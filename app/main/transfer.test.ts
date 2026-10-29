// Cross-tool transfer assembled in the backend (T023): a real SQLite file, the facade the IPC layer serves,
// and fake adapters. Claude → Codex with the GUI's digest, Codex → Claude with the source agent's note, and a
// restart while the new session's creation was under way.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentId,
  CONTRACTS_VERSION,
  type Command,
  type CommandResult,
  type EventEnvelope,
  ItemId,
  MessageId,
  type ModelSelection,
  type OwnedProcess,
  RequestId,
  type Runtime,
  SessionId,
  Snapshot,
  TransferId,
  TurnId,
} from '../../contracts';
import type { DispatchRequest, PermissionHandle, RuntimeAdapter } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { entriesOf, NOTE_REQUEST, targetSessionOf } from '../../core/transfer';
import { type Backend, type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t023-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob() {
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned() {
    return Promise.resolve([] as OwnedProcess[]);
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

let counter = 0;
const next = () => String(++counter);
const rid = () => RequestId.parse(`r-${next()}`);
const AGENT = AgentId.parse('agent-1');
const CLAUDE: ModelSelection = { runtime: 'claude', model: 'haiku' };
const CODEX: ModelSelection = { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' };
const at = () => new Date(Date.UTC(2026, 9, 30, 2, 0, 0, Number(next()))).toISOString();

interface Started {
  backend: Backend;
  envelopes: EventEnvelope[];
  adapters: FakeAdapter[];
  logs: string[];
  run(command: Command): Promise<CommandResult>;
}

interface Script {
  /** What a session's agent answers the note request with. */
  notes: Map<SessionId, string>;
  /** Sessions whose creation never answers (the GUI is cut off inside it). */
  hangStart: Set<SessionId>;
}

const start = async (script: Script): Promise<Started> => {
  const logs: string[] = [];
  const adapters: FakeAdapter[] = [];
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  const refs = new Map<string, SessionId>();
  let claude: FakeAdapter | undefined;
  const ref: { backend?: Backend } = {};
  const wire = (adapter: FakeAdapter) => {
    const startSession = adapter.startSession.bind(adapter);
    adapter.startSession = async (options) => {
      if (script.hangStart.has(options.sessionId)) return new Promise(() => undefined);
      const info = await startSession(options);
      refs.set(info.nativeSessionRef, options.sessionId);
      return info;
    };
    const resume = adapter.resumeSession.bind(adapter);
    adapter.resumeSession = async (options) => {
      const info = await resume(options);
      refs.set(info.nativeSessionRef, options.sessionId);
      return info;
    };
    // The runtime's history is what the GUI recorded of the session (the fake keeps no other).
    (adapter as RuntimeAdapter).readHistory = async (request) => ({ entries: entriesOf(await ref.backend!.repositories.conversations.get(request.sessionId)), nativeTasks: [], complete: true });
    const dispatch = adapter.dispatchOnce.bind(adapter);
    adapter.dispatchOnce = async (request) => {
      let result = await dispatch(request);
      const sessionId = refs.get(request.nativeSessionRef);
      if (result.state === 'sent' && request.entry.kind === 'new-turn' && sessionId !== undefined) {
        const turnId = `turn-${next()}`;
        result = { ...result, nativeRef: { ...result.nativeRef, turnRef: turnId } };
        void Promise.resolve().then(() => {
          const note = script.notes.get(sessionId);
          const reply = note !== undefined && request.text === NOTE_REQUEST ? note : 'On it.';
          emitTurn(adapter, sessionId, turnId, [], reply, request);
        });
      }
      return result;
    };
    adapters.push(adapter);
    return adapter;
  };
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      if (runtime === 'claude' && claude !== undefined) return claude;
      const adapter = wire(new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)));
      if (runtime === 'claude') claude = adapter;
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
    closeTimeoutMs: 50,
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  ref.backend = result;
  return { backend: result, envelopes, adapters, logs, run: (command) => result.facade.execute(command) as Promise<CommandResult> };
};

/** One turn of a session as its runtime reports it: running, its items, its reply, completed. */
const emitTurn = (adapter: FakeAdapter, sessionId: SessionId, turnId: string, items: { kind: 'file' | 'test' }[], reply: string, echo?: DispatchRequest) => {
  const turn = TurnId.parse(turnId);
  adapter.emit({ type: 'turn.updated', turn: { id: turn, sessionId, state: 'running', startedAt: at() } });
  // The runtime echoes what it received, with the origin it was dispatched with (both adapters do).
  if (echo !== undefined)
    adapter.emit({
      type: 'message.completed',
      message: { id: MessageId.parse(echo.attempt.clientMessageId), sessionId, turnId: turn, role: 'user', origin: echo.origin ?? { kind: 'user' }, text: echo.text, attachments: [], createdAt: at() },
    });
  for (const item of items) {
    const t = at();
    adapter.emit({
      type: 'item.updated',
      item:
        item.kind === 'file'
          ? { id: ItemId.parse(`fc-${next()}`), sessionId, turnId: turn, kind: 'fileChange', changes: [{ path: 'calc.js', change: 'update' }], state: 'applied', diff: '+export const add = (a, b) => a + b;', startedAt: t, endedAt: t }
          : { id: ItemId.parse(`cmd-${next()}`), sessionId, turnId: turn, kind: 'command', command: 'npm test', cwd: dir, state: 'completed', exitCode: 0, output: '4 passing', outputTruncated: false, startedAt: t, endedAt: t },
    });
  }
  adapter.emit({ type: 'message.completed', message: { id: MessageId.parse(`reply-${next()}`), sessionId, turnId: turn, role: 'assistant', origin: { kind: 'agent' }, text: reply, attachments: [], createdAt: at() } });
  const end = at();
  adapter.emit({ type: 'turn.updated', turn: { id: turn, sessionId, state: 'completed', startedAt: end, endedAt: end } });
  adapter.emit({ type: 'session.activity', sessionId, activity: 'idle', at: end });
};

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
};

const snapshot = async (s: Started) => Snapshot.parse(await s.backend.facade.snapshot());

/** An ordinary session that wrote calc.js and ran the tests. */
const sourceSession = async (s: Started, id: string, model: ModelSelection) => {
  const sessionId = SessionId.parse(id);
  expect(
    await s.run({ type: 'agent.save', requestId: rid(), agent: { schemaVersion: CONTRACTS_VERSION, id: AGENT, revision: 0, name: 'Builder', description: '', instructions: 'Build.', updatedAt: at() }, expectedRevision: null }),
  ).toMatchObject({ ok: true });
  expect(await s.run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: AGENT, model, cwd: dir })).toMatchObject({ ok: true });
  await settle();
  const session = (await snapshot(s)).sessions.find((x) => x.id === sessionId)!;
  expect(
    await s.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(`m-${id}`), expectedRevision: session.revision, text: 'Implement add() in calc.js.', attachments: [] }),
  ).toMatchObject({ ok: true });
  await settle();
  const adapter = s.adapters.find((a) => a.runtime === model.runtime && [...a.started].some((o) => o.sessionId === sessionId))!;
  emitTurn(adapter, sessionId, `own-${next()}`, [{ kind: 'file' }, { kind: 'test' }], 'add() is done.');
  await settle();
  return sessionId;
};

const databaseBytes = () =>
  readdirSync(dir)
    .filter((f) => f.startsWith('awg.sqlite'))
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n');

const proposalOf = async (s: Started, id: TransferId) => {
  const p = (await snapshot(s)).transfers.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no transfer ${id}`);
  return p;
};

describe('cross-tool transfer in the backend (T023)', () => {
  it('Claude → Codex with the GUI digest: nothing of the target before the confirmation, then one new session with the frame', async () => {
    const s = await start({ notes: new Map(), hangStart: new Set() });
    const source = await sourceSession(s, 'claude-src', CLAUDE);
    const T = TransferId.parse('tr-claude-codex');
    expect(await s.run({ type: 'transfer.prepare', requestId: rid(), transferId: T, sourceSessionId: source, target: CODEX, noteSource: 'gui-digest' })).toMatchObject({
      ok: true,
      created: [{ kind: 'transfer', id: T }],
    });
    await settle();
    let p = await proposalOf(s, T);
    expect(p).toMatchObject({ state: 'awaiting-confirmation', content: { noteSource: 'gui-digest', goal: 'Implement add() in calc.js.' } });
    expect(p.content.diff).toContain('+export const add');
    expect(p.content.testOutput).toContain('4 passing');
    // CR-5: no Codex runtime at all, no target session, no record of it.
    expect(s.adapters.filter((a) => a.runtime === 'codex')).toHaveLength(0);
    expect((await snapshot(s)).sessions.map((x) => x.id)).toEqual([source]);

    expect(await s.run({ type: 'transfer.confirm', requestId: rid(), transferId: T, expectedRevision: p.revision })).toMatchObject({
      ok: true,
      created: [{ kind: 'session', id: targetSessionOf(T) }],
    });
    await settle();
    const snap = await snapshot(s);
    p = snap.transfers.find((x) => x.id === T)!;
    expect(p).toMatchObject({ state: 'approved', createdSessionId: targetSessionOf(T), provision: { state: 'sent' }, delivery: { state: 'sent' } });
    expect(snap.sessions.find((x) => x.id === targetSessionOf(T))).toMatchObject({ derivedFromSessionId: source, requestedModel: CODEX });
    const codex = s.adapters.filter((a) => a.runtime === 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]!.started).toHaveLength(1);
    expect(codex[0]!.dispatched).toHaveLength(1);
    expect(codex[0]!.dispatched[0]).toMatchObject({ origin: { kind: 'transfer', fromSessionId: source, transferId: T }, entry: { kind: 'new-turn' } });
    expect(codex[0]!.dispatched[0]!.text).toContain('## Current test output\n$ npm test');
    // The new session shows the transfer content as a message from the transfer (G-1), stored by SQLite.
    expect(snap.messages.filter((m) => m.sessionId === targetSessionOf(T) && m.role === 'user')).toMatchObject([
      { origin: { kind: 'transfer', fromSessionId: source, transferId: T }, text: codex[0]!.dispatched[0]!.text },
    ]);
    expect(s.logs.filter((l) => l.includes('failed'))).toEqual([]);
    expect(s.envelopes.filter((e) => e.event.type === 'transfer.updated').length).toBeGreaterThan(2);
    // No MCP token in the database, the log or what was pushed (C-07).
    const tokens = s.adapters.flatMap((a) => [...a.started, ...a.resumed]).flatMap((o) => (o.mcp === undefined ? [] : [o.mcp.token]));
    expect(tokens.length).toBeGreaterThan(1);
    const bytes = databaseBytes();
    for (const token of tokens) {
      expect(bytes).not.toContain(token);
      expect(s.logs.join('\n')).not.toContain(token);
      expect(JSON.stringify(s.envelopes)).not.toContain(token);
    }
    await s.backend.shutdown();
  });

  it("Codex → Claude with the source agent's note, asked for through the delivery service", async () => {
    const script: Script = { notes: new Map(), hangStart: new Set() };
    const s = await start(script);
    const source = await sourceSession(s, 'codex-src', CODEX);
    script.notes.set(source, 'Done: add(). Not done: subtract(). Evidence: npm test, 4 passing.');
    const T = TransferId.parse('tr-codex-claude');
    expect(await s.run({ type: 'transfer.prepare', requestId: rid(), transferId: T, sourceSessionId: source, target: CLAUDE, noteSource: 'agent' })).toMatchObject({ ok: true });
    await settle();
    let p = await proposalOf(s, T);
    expect(p).toMatchObject({ state: 'awaiting-confirmation', content: { noteSource: 'agent', note: 'Done: add(). Not done: subtract(). Evidence: npm test, 4 passing.' } });
    const codex = s.adapters.find((a) => a.runtime === 'codex')!;
    expect(codex.dispatched.at(-1)).toMatchObject({ text: NOTE_REQUEST, origin: { kind: 'transfer', fromSessionId: source, transferId: T } });
    expect(s.adapters.find((a) => a.runtime === 'claude')?.started ?? []).toHaveLength(0);
    // The note request shows in the source as a message from the transfer, naming the source itself (G-1).
    expect((await snapshot(s)).messages.filter((m) => m.sessionId === source && m.text === NOTE_REQUEST)).toMatchObject([
      { role: 'user', origin: { kind: 'transfer', fromSessionId: source, transferId: T } },
    ]);
    expect(await s.run({ type: 'transfer.confirm', requestId: rid(), transferId: T, expectedRevision: p.revision })).toMatchObject({ ok: true });
    await settle();
    p = await proposalOf(s, T);
    expect(p).toMatchObject({ state: 'approved', delivery: { state: 'sent' }, createdSessionId: targetSessionOf(T) });
    const claude = s.adapters.find((a) => a.runtime === 'claude')!;
    expect(claude.started.map((o) => o.sessionId)).toEqual([targetSessionOf(T)]);
    expect(claude.dispatched).toHaveLength(1);
    expect(claude.dispatched[0]!.text).toContain('written by the source agent');
    await s.backend.shutdown();
  });

  it('a restart while the new session was being created: unknown, shown at the source, never created again; the user retries', async () => {
    const script: Script = { notes: new Map(), hangStart: new Set() };
    const s = await start(script);
    const source = await sourceSession(s, 'claude-src', CLAUDE);
    const T = TransferId.parse('tr-restart');
    await s.run({ type: 'transfer.prepare', requestId: rid(), transferId: T, sourceSessionId: source, target: CODEX, noteSource: 'gui-digest' });
    await settle();
    script.hangStart.add(targetSessionOf(T));
    void s.run({ type: 'transfer.confirm', requestId: rid(), transferId: T, expectedRevision: (await proposalOf(s, T)).revision });
    await settle();
    await s.backend.shutdown();

    const again = await start({ notes: new Map(), hangStart: new Set() });
    await settle();
    let snap = await snapshot(again);
    expect(snap.transfers[0]).toMatchObject({ state: 'approved', provision: { state: 'unknown' }, delivery: { state: 'pending' } });
    const escalation = snap.escalations.find((e) => e.kind === 'delivery-unknown' && e.state === 'open');
    expect(escalation).toMatchObject({ rootSessionId: source, ref: { kind: 'provision', blocked: [`transfer:${T}`] } });
    expect(again.adapters.filter((a) => a.runtime === 'codex').flatMap((a) => a.started)).toHaveLength(0);
    expect(await again.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
    await settle();
    snap = await snapshot(again);
    expect(snap.transfers[0]).toMatchObject({ state: 'approved', createdSessionId: targetSessionOf(T), delivery: { state: 'sent' } });
    const codex = again.adapters.filter((a) => a.runtime === 'codex');
    expect(codex.flatMap((a) => a.started)).toHaveLength(1);
    expect(codex.flatMap((a) => a.dispatched)).toHaveLength(1);
    await again.backend.shutdown();
  });
});
