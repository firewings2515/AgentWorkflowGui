// Real Claude Agent SDK checks. Skipped unless AWG_CLAUDE_LIVE=1 because it spends Claude usage: a few
// short turns on the cheapest model, in a fresh temp folder, and about three minutes of waiting.
// Optional: AWG_CLAUDE_MODEL (default haiku); AWG_CLAUDE_LIVE_LOG=<file> writes every SDK message, hook
// input and finding there as JSON.
//
// What it checks (the assumptions the fake SDK cannot prove):
//   A. initializationResult() resolves before any prompt (start waits on it).
//   B. setModel + applyFlagSettings({effortLevel}) are accepted.
//   C. A permission held longer than the CLI's usual hook timeout is not released, and cancel
//      (`continue: false`) ends the turn without running the tool.
//   D. What the CLI does when a hook does time out (observed with a 5 s hook timeout, not asserted).
//   E. A payload inserted into a busy turn is acknowledged through user_message_uuids.
//   F. Afterwards, from a fresh adapter: reconcile and readHistory find the payloads.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, EscalationId, type PermissionDecision, SessionId } from '../../contracts';
import type { DispatchEntry, PermissionHandle, RuntimeEvent } from '../../core/ports';
import { ClaudeAdapter } from './adapter';
import { claudeAgentSdk } from './sdk';
import type { ClaudeSdk, WireQuery } from './wire';

const live = process.env.AWG_CLAUDE_LIVE === '1';
const model = process.env.AWG_CLAUDE_MODEL ?? 'haiku';
const logFile = process.env.AWG_CLAUDE_LIVE_LOG;

const t0 = Date.now();
const log: { ms: number; kind: string; data: unknown }[] = [];
const findings: Record<string, unknown> = {};
const record = (kind: string, data: unknown) => log.push({ ms: Date.now() - t0, kind, data });

/** The real SDK, with every SDK message and PreToolUse input/output recorded. */
const recordingSdk: ClaudeSdk = {
  ...claudeAgentSdk,
  query: ({ prompt, options }) => {
    const hooks = options.hooks.PreToolUse.map((m) => ({
      ...m,
      hooks: m.hooks.map((hook) => async (input: unknown, id: string | undefined, o: { signal: AbortSignal }) => {
        record('hook-in', input);
        const out = await hook(input, id, o);
        record('hook-out', out);
        return out;
      }),
    }));
    const q = claudeAgentSdk.query({ prompt, options: { ...options, hooks: { PreToolUse: hooks } } });
    async function* messages() {
      for await (const m of q) {
        record('sdk', m);
        yield m;
      }
    }
    const wrapped: WireQuery = {
      interrupt: () => q.interrupt(),
      close: () => q.close(),
      setModel: (m) => q.setModel(m),
      applyFlagSettings: (s) => q.applyFlagSettings(s),
      supportedModels: () => q.supportedModels(),
      stopTask: (t) => q.stopTask(t),
      initializationResult: () => q.initializationResult(),
      [Symbol.asyncIterator]: () => messages(),
    };
    return wrapped;
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what: string, predicate: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`live: timed out waiting for ${what}`);
    await sleep(200);
  }
};
const policy = (outcome: PermissionDecision['outcome']): PermissionDecision => ({ outcome, decidedBy: 'policy', at: new Date().toISOString() });

describe.skipIf(!live)('Claude Agent SDK (live)', () => {
  const cwd = live ? mkdtempSync(join(tmpdir(), 'awg-t009-')) : '';
  afterAll(() => {
    if (logFile) writeFileSync(logFile, JSON.stringify({ findings, log }, null, 1));
    if (!cwd) return;
    rmSync(cwd, { recursive: true, force: true });
    // The CLI keeps task output and scratch files under %TEMP%\claude\<encoded cwd>; the transcript
    // under ~/.claude/projects stays (Claude's own folder).
    const scratch = join(tmpdir(), 'claude');
    if (existsSync(scratch)) for (const d of readdirSync(scratch)) if (d.endsWith(basename(cwd))) rmSync(join(scratch, d), { recursive: true, force: true });
  });

  it('holds, cancels, inserts into a busy turn, and reconciles afterwards', { timeout: 420_000 }, async () => {
    const events: RuntimeEvent[] = [];
    const handles: PermissionHandle[] = [];
    let onRequest: (h: PermissionHandle) => void = (h) => handles.push(h);
    const writer = new ClaudeAdapter({ sdk: recordingSdk, onPermissionRequest: (h) => onRequest(h), log: (level, message) => record(`log-${level}`, message) });
    writer.subscribe((e) => {
      events.push(e);
      record('event', e);
    });
    await writer.start();
    const sessionId = SessionId.parse('live-session');
    const ref = randomUUID();

    // A. start resolves on initializationResult(), before any prompt is sent.
    let started = Date.now();
    const info = await writer.startSession({ sessionId, cwd, model: { runtime: 'claude', model }, readOnly: false, preallocatedRef: ref });
    findings.A_startMs = Date.now() - started;
    expect(info.nativeSessionRef).toBe(ref);
    expect(log.filter((l) => l.kind === 'sdk')).toEqual([]);

    // B. effort through applyFlagSettings, on a model that supports it.
    const models = await writer.listModels();
    findings.B_models = models.map((m) => [m.model, m.efforts.join('/')]);
    const efforts = models.find((m) => m.model === model)?.efforts ?? [];
    const effort = efforts.includes('low') ? 'low' : efforts[0];
    findings.B_effortTried = effort ?? null;
    expect(await writer.setModel(ref, { runtime: 'claude', model, ...(effort && { effort }) })).toBe('next-model-call');

    const send = async (text: string, entry: DispatchEntry, timeoutMs = 90_000) => {
      const clientMessageId = randomUUID();
      const result = await writer.dispatchOnce({
        nativeSessionRef: ref,
        attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${clientMessageId}`), clientMessageId: ClientMessageId.parse(clientMessageId), dispatchStartedAt: new Date().toISOString() },
        text,
        entry,
        timeoutMs,
      });
      return { clientMessageId, text, result };
    };
    const turnsEnded = () => events.filter((e) => e.type === 'turn.updated' && e.turn.state !== 'running').length;

    // C. Hold one write past the usual hook timeout, then cancel.
    const markerA = join(cwd, 'marker-a.txt');
    const a = await send('Use the Write tool to create the file marker-a.txt in the current folder with the content hi. Do not use any other tool.', { kind: 'new-turn' });
    expect(a.result.state).toBe('sent');
    await waitFor('a permission request', () => handles.length > 0, 90_000);
    const held = handles[0]!;
    findings.C_request = { kind: held.request.kind, summary: held.request.summary };
    const hookIn = log.find((l) => l.kind === 'hook-in')?.data as { effort?: unknown } | undefined;
    findings.B_hookEffort = hookIn?.effort ?? null;
    expect(held.hold({ reason: 'awaiting-user', escalationId: EscalationId.parse('live-esc') })).toBe(true);
    started = Date.now();
    await sleep(75_000);
    findings.C_afterHold = { heldMs: Date.now() - started, fileExists: existsSync(markerA), requestState: held.request.state, turnsEnded: turnsEnded() };
    expect(existsSync(markerA)).toBe(false);
    expect(held.request.state).toBe('held');
    const endedBefore = turnsEnded();
    started = Date.now();
    expect(held.answer(policy('cancel'))).toBe(true);
    await waitFor('turn end after cancel', () => turnsEnded() > endedBefore, 60_000);
    const cancelledTurn = events.filter((e) => e.type === 'turn.updated').at(-1);
    findings.C_cancel = {
      msToTurnEnd: Date.now() - started,
      turn: cancelledTurn?.type === 'turn.updated' ? cancelledTurn.turn.state : null,
      fileExists: existsSync(markerA),
      toolCallsAfterCancel: log.filter((l) => l.kind === 'hook-in').length - 1,
      items: events.flatMap((e) => (e.type === 'item.updated' && e.item.endedAt ? [[e.item.kind, e.item.state]] : [])),
    };
    expect(existsSync(markerA)).toBe(false);
    // The CLI ends a cancelled turn with a successful result and terminal_reason hook_stopped.
    expect(findings.C_cancel).toMatchObject({ turn: 'interrupted' });

    // D. Observation only: a hook that times out (5 s) while the answer is held.
    const observer = new ClaudeAdapter({ sdk: recordingSdk, hookTimeoutSeconds: 5, onPermissionRequest: (h) => observed.push(h) });
    const observed: PermissionHandle[] = [];
    const observerEvents: RuntimeEvent[] = [];
    observer.subscribe((e) => observerEvents.push(e));
    await observer.start();
    const refD = randomUUID();
    await observer.startSession({ sessionId: SessionId.parse('live-timeout'), cwd, model: { runtime: 'claude', model }, readOnly: false, preallocatedRef: refD });
    const markerB = join(cwd, 'marker-b.txt');
    const idD = randomUUID();
    const d = await observer.dispatchOnce({
      nativeSessionRef: refD,
      attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${idD}`), clientMessageId: ClientMessageId.parse(idD), dispatchStartedAt: new Date().toISOString() },
      text: 'Use the Write tool to create the file marker-b.txt in the current folder with the content hi. Do not use any other tool. If it fails, reply only FAILED.',
      entry: { kind: 'new-turn' },
      timeoutMs: 90_000,
    });
    expect(d.state).toBe('sent');
    await waitFor('the timeout probe request', () => observed.length > 0, 90_000);
    await sleep(15_000);
    findings.D_afterTimeout = {
      fileExists: existsSync(markerB),
      requestState: observed[0]!.request.state,
      laterRequests: observed.length - 1,
      answeredLate: observed[0]!.answer(policy('decline')),
    };
    await waitFor('timeout probe turn end', () => observerEvents.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running'), 90_000).catch((e: unknown) => {
      findings.D_turnEnd = String(e);
    });
    findings.D_final = {
      fileExists: existsSync(markerB),
      items: observerEvents.flatMap((e) => (e.type === 'item.updated' && e.item.endedAt ? [[e.item.kind, e.item.state]] : [])),
      reply: observerEvents.flatMap((e) => (e.type === 'message.completed' && e.message.role === 'assistant' ? [e.message.text.slice(0, 200)] : [])),
    };
    findings.D_close = await observer.close();

    // E. Insert into a busy turn: approve everything, start a short sleep, add a request mid-turn.
    onRequest = (h) => {
      handles.push(h);
      h.answer(policy('approve'));
    };
    const commandRunning = () => events.some((e) => e.type === 'item.updated' && e.item.kind === 'command' && e.item.state === 'running');
    const b = await send('Run the shell command Start-Sleep -Seconds 15 with your shell tool. When it has finished, reply exactly: SLEPT', { kind: 'new-turn' });
    expect(b.result.state).toBe('sent');
    await waitFor('the sleep command', commandRunning, 90_000);
    const turnRef = b.result.state === 'sent' ? b.result.nativeRef.turnRef : undefined;
    const c = await send('Also add the word PEER-OK at the very end of your final reply.', { kind: 'insert', ...(turnRef && { expectedTurnRef: turnRef }) }, 120_000);
    const echoFrame = log.find((l) => l.kind === 'sdk' && JSON.stringify((l.data as { user_message_uuids?: unknown }).user_message_uuids ?? []).includes(c.clientMessageId));
    const endedBeforeB = turnsEnded();
    await waitFor('the sleep turn end', () => turnsEnded() > endedBeforeB || turnsEnded() >= 3, 120_000).catch(() => undefined);
    const replies = events.flatMap((e) => (e.type === 'message.completed' && e.message.role === 'assistant' ? [e.message.text] : []));
    findings.E_insert = {
      result: c.result,
      echoFrame: echoFrame ? { type: (echoFrame.data as { type?: string }).type, uuids: (echoFrame.data as { user_message_uuids?: unknown }).user_message_uuids } : null,
      lastReplies: replies.slice(-2),
      turns: events.flatMap((e) => (e.type === 'turn.updated' ? [[e.turn.id, e.turn.state]] : [])),
    };
    expect(c.result.state).toBe('sent');
    expect(await writer.close()).toEqual({ forced: false });

    // F. A fresh adapter reads what happened, without starting a session.
    const reader = new ClaudeAdapter({ sdk: claudeAgentSdk, onPermissionRequest: (h) => h.answer(policy('decline')) });
    await reader.start();
    const reconcile = async (p: { clientMessageId: string; text: string }) =>
      reader.reconcile({ nativeSessionRef: ref, cwd, clientMessageId: ClientMessageId.parse(p.clientMessageId), text: p.text });
    findings.F_reconcile = { a: await reconcile(a), b: await reconcile(b), c: await reconcile(c) };
    const history = await reader.readHistory({ sessionId, nativeSessionRef: ref, cwd });
    findings.F_history = { complete: history.complete, entries: history.entries.map((e) => (e.kind === 'turn' ? `turn:${e.turn.state}` : e.kind === 'message' ? e.message.role : `${e.item.kind}:${e.item.state}`)) };
    await reader.close();
    record('findings', findings);
    expect(findings.F_reconcile).toMatchObject({ a: { state: 'sent' }, b: { state: 'sent' } });
  });
});
