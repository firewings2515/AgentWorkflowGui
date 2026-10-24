// Real `codex app-server` round trip. Skipped unless AWG_CODEX_LIVE=1 because it spends Codex usage
// (two short turns on the cheapest model). Optional: AWG_CODEX_MODEL (default gpt-6-luna),
// AWG_CODEX_COMMAND (default `codex` on PATH).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, SessionId } from '../../contracts';
import { CodexAdapter, type CodexAdapterEvent } from './adapter';

const live = process.env.AWG_CODEX_LIVE === '1';
const model = process.env.AWG_CODEX_MODEL ?? 'gpt-6-luna';
const spawnOptions = process.env.AWG_CODEX_COMMAND ? { command: process.env.AWG_CODEX_COMMAND } : {};

describe.skipIf(!live)('Codex app-server (live)', () => {
  const cwd = live ? mkdtempSync(join(tmpdir(), 'awg-t003-')) : '';
  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('dispatches once, then reconciles the attempt from history in a fresh app-server', { timeout: 120_000 }, async () => {
    const events: CodexAdapterEvent[] = [];
    // Read-only sandbox and decline-all: the turn has no tool side effects.
    const writer = new CodexAdapter({ spawnOptions, onPermissionRequest: (h) => h.answer({ outcome: 'decline', decidedBy: 'policy', at: new Date().toISOString() }) });
    writer.subscribe((e) => events.push(e));
    await writer.start();
    const thread = await writer.startThread({ sessionId: SessionId.parse('live-session'), cwd, sandbox: 'read-only', model });
    const clientMessageId = randomUUID();
    const text = `AWG T003 live check ${clientMessageId}. Reply only ACK. Do not call tools.`;
    const sent = await writer.dispatchOnce({
      threadId: thread.threadId,
      attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${clientMessageId}`), clientMessageId: ClientMessageId.parse(clientMessageId), dispatchStartedAt: new Date().toISOString() },
      text,
      entry: { kind: 'new-turn', model, effort: 'low' },
      timeoutMs: 60_000,
    });
    expect(sent.state).toBe('sent');
    const deadline = Date.now() + 90_000;
    while (!events.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === 'message.completed' && e.message.role === 'assistant')).toBe(true);
    expect(await writer.close()).toMatchObject({ forced: false });

    const reader = new CodexAdapter({ spawnOptions, onPermissionRequest: (h) => h.answer({ outcome: 'decline', decidedBy: 'policy', at: new Date().toISOString() }) });
    await reader.start();
    const reconciled = await reader.reconcile({ threadId: thread.threadId, clientMessageId, text });
    await reader.close();
    expect(reconciled).toMatchObject({ state: 'sent', evidence: { kind: 'reconciled' } });
  });
});
