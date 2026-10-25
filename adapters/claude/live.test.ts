// Real Claude Agent SDK round trip. Skipped unless AWG_CLAUDE_LIVE=1 because it spends Claude usage
// (one short turn on the cheapest model). Optional: AWG_CLAUDE_MODEL (default haiku).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, SessionId } from '../../contracts';
import type { RuntimeEvent } from '../../core/ports';
import { ClaudeAdapter } from './adapter';
import { claudeAgentSdk } from './sdk';

const live = process.env.AWG_CLAUDE_LIVE === '1';
const model = process.env.AWG_CLAUDE_MODEL ?? 'haiku';
// Decline every tool call: the turn has no side effects.
const declineAll = { onPermissionRequest: (h: { answer: (d: { outcome: 'decline'; decidedBy: 'policy'; at: string }) => boolean }) => h.answer({ outcome: 'decline', decidedBy: 'policy', at: new Date().toISOString() }) };

describe.skipIf(!live)('Claude Agent SDK (live)', () => {
  const cwd = live ? mkdtempSync(join(tmpdir(), 'awg-t009-')) : '';
  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('starts a pre-allocated session, dispatches once, closes, then reconciles and reads it back', { timeout: 180_000 }, async () => {
    const events: RuntimeEvent[] = [];
    const sessionId = SessionId.parse('live-session');
    const writer = new ClaudeAdapter({ sdk: claudeAgentSdk, ...declineAll });
    writer.subscribe((e) => events.push(e));
    await writer.start();
    const ref = randomUUID();
    const info = await writer.startSession({ sessionId, cwd, model: { runtime: 'claude', model }, readOnly: true, preallocatedRef: ref });
    expect(info.nativeSessionRef).toBe(ref);

    const clientMessageId = randomUUID();
    const text = `AWG T009 live check ${clientMessageId}. Reply only ACK. Do not call tools.`;
    const sent = await writer.dispatchOnce({
      nativeSessionRef: ref,
      attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${clientMessageId}`), clientMessageId: ClientMessageId.parse(clientMessageId), dispatchStartedAt: new Date().toISOString() },
      text,
      entry: { kind: 'new-turn' },
      timeoutMs: 90_000,
    });
    expect(sent).toMatchObject({ state: 'sent', evidence: { kind: 'live-ack' }, nativeRef: { sessionRef: ref, itemRef: clientMessageId } });
    const deadline = Date.now() + 90_000;
    while (!events.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(events.find((e) => e.type === 'turn.updated' && e.turn.state !== 'running')).toMatchObject({ turn: { state: 'completed' } });
    expect(events.some((e) => e.type === 'model.observed')).toBe(true);
    expect(await writer.close()).toEqual({ forced: false });

    const reader = new ClaudeAdapter({ sdk: claudeAgentSdk, ...declineAll });
    await reader.start();
    expect(await reader.reconcile({ nativeSessionRef: ref, cwd, clientMessageId: ClientMessageId.parse(clientMessageId), text })).toMatchObject({ state: 'sent', evidence: { kind: 'reconciled' } });
    const history = await reader.readHistory({ sessionId, nativeSessionRef: ref, cwd });
    expect(history.entries.some((e) => e.kind === 'message' && e.message.role === 'assistant')).toBe(true);
    expect(await reader.listModels()).not.toEqual([]);
    await reader.close();
  });
});
