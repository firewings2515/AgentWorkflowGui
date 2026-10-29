// T017 review round 2: every reproduction from T017-r2-result.md as a regression test on the session
// service (memory ports, fake adapters). r2-P1-1 is in core/delivery; r2-P1-8 also runs on SQLite in app/main.
import { describe, expect, it } from 'vitest';
import { type AppEvent, ItemId, MessageId, OperationId, type SessionId, TurnId } from '../../contracts';
import { hashOf } from '../delivery/testing/fixtures';
import { tokenForms } from './redact';
import { permissionRequest } from './testing/fake-adapter';
import { CWD, created, rid, session, settle, world, type World } from './testing/harness';

const send = (w: World, sessionId: SessionId, text: string, messageId: string, revision: number) =>
  w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(messageId), expectedRevision: revision, text, attachments: [] });
const latest = async (w: World, id: string) => (await session(w, id)).revision;
const at = '2026-10-29T01:00:00.000Z';
const deltas = (w: World, messageId: string) =>
  w.events.filter((e): e is Extract<AppEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.messageId === messageId).map((e) => e.delta);
const later = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};

describe('r2-P1-2 a token split across deltas or encoded is still redacted', () => {
  it('r2-P1-2 a token cut in two message deltas never reaches a consumer whole, and the held text comes out when the message completes', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    const messageId = MessageId.parse('a-1');
    codex.emit({ type: 'message.delta', sessionId, messageId, delta: `before ${token.slice(0, 8)}` });
    codex.emit({ type: 'message.delta', sessionId, messageId, delta: `${token.slice(8)} after` });
    await settle();
    expect(deltas(w, 'a-1').join('')).not.toContain(token.slice(0, 8));
    codex.emit({ type: 'message.completed', message: { id: messageId, sessionId, role: 'assistant', origin: { kind: 'agent' }, text: `before ${token} after`, attachments: [], createdAt: at } });
    await settle();
    expect(deltas(w, 'a-1').join('')).toBe('before [redacted] after');
    expect(JSON.stringify(w.events)).not.toContain(token);
  });

  it('r2-P1-2 command output deltas are held and let out the same way when the item ends', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    const itemId = ItemId.parse('cmd-1');
    codex.emit({ type: 'item.outputDelta', sessionId, itemId, delta: token.slice(0, 20) });
    codex.emit({ type: 'item.outputDelta', sessionId, itemId, delta: `${token.slice(20)}\n` });
    codex.emit({ type: 'item.updated', item: { id: itemId, sessionId, kind: 'command', command: 'x', cwd: CWD, state: 'completed', output: token, outputTruncated: false, startedAt: at, endedAt: at } });
    await settle();
    const out = w.events.filter((e) => e.type === 'item.outputDelta').map((e) => (e.type === 'item.outputDelta' ? e.delta : ''));
    expect(out.join('')).toBe('[redacted]\n');
    expect(JSON.stringify(w.events)).not.toContain(token.slice(0, 20));
  });

  it('r2-P1-2 percent-encoded and \\u-escaped spellings of the token are redacted too (Base64 is an accepted residual risk)', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const forms = tokenForms(token).filter((f) => f !== token);
    expect(forms.some((f) => f.startsWith('%'))).toBe(true);
    expect(forms.some((f) => f.startsWith('\\u'))).toBe(true);
    const codex = w.codex.get(sessionId)!;
    codex.emit({ type: 'message.completed', message: { id: MessageId.parse('a-2'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: forms.join(' | '), attachments: [], createdAt: at } });
    await settle();
    const stored = JSON.stringify(await w.repositories.readSnapshotData());
    for (const form of forms) expect(stored).not.toContain(form.replace(/\\/g, '\\\\'));
    expect(JSON.stringify(w.events)).not.toContain(forms[0]!.replace(/\\/g, '\\\\'));
  });
});

describe('r2-P1-3 concurrent calls for one operation are checked against each other', () => {
  it('r2-P1-3 two callers racing with one operationId: the second is rejected, not a duplicate', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    const { sessionId: c } = await created(w, 'codex', 'session-c');
    const op = OperationId.parse('op-race');
    const [first, second] = await Promise.all([
      w.service.sendMessage({ to: b, content: 'original' }, { caller: a, operationId: op, sourceCallRef: 'call-a' }),
      w.service.sendMessage({ to: b, content: 'changed' }, { caller: c, operationId: op, sourceCallRef: 'call-c' }),
    ]);
    expect(first).toMatchObject({ status: 'accepted' });
    expect(second).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    expect(w.codex.get(b)!.dispatched.map((d) => d.text)).toEqual(['original']);
  });

  it('r2-P1-3 the same caller racing with changed content: the second is rejected', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    const op = OperationId.parse('op-race');
    const results = await Promise.all([
      w.service.sendMessage({ to: b, content: 'original' }, { caller: a, operationId: op, sourceCallRef: 'call-1' }),
      w.service.sendMessage({ to: b, content: 'changed' }, { caller: a, operationId: op, sourceCallRef: 'call-2' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
  });
});

describe('r2-P1-4 nothing is written after shutdown returned', () => {
  it('r2-P1-4 a start that returns after a timed-out shutdown writes nothing: no sent, no session update', async () => {
    const w = await world();
    w.configure = (adapter) => adapter.startModes.push('held');
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    w.sleeper = () => Promise.resolve();
    await w.service.shutdown(1);
    const eventsAfter = w.events.length;
    const before = JSON.stringify(await w.repositories.readSnapshotData());
    const provisionBefore = JSON.stringify(await w.store.get(OperationId.parse(`provision:${sessionId}`)));
    codex.release();
    await settle();
    expect(JSON.stringify(await w.store.get(OperationId.parse(`provision:${sessionId}`)))).toBe(provisionBefore);
    expect(JSON.stringify(await w.repositories.readSnapshotData())).toBe(before);
    expect(w.events.slice(eventsAfter).filter((e) => e.type === 'session.updated')).toEqual([]);
    // The session that came up late was closed again.
    expect(codex.closedSessions).toEqual(['thread-1']);
    expect(w.service.runtimes.openSessions()).toEqual([]);
  });

  it('r2-P1-4 a resume that returns after a timed-out shutdown writes nothing either', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    // A message accepted before a restart; recovery resumes the session first.
    await w.service.delivery.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-1'),
      payloadHash: hashOf('later'),
      payload: 'later',
      proposalRevision: 0,
      target: { sessionId, nativeSessionRef: 'thread-1' },
      at,
      context: { runtime: 'codex', cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false } },
    });
    const after = w.restart();
    const hold = later();
    after.configure = (adapter) => {
      adapter.resumeGate = hold.gate;
    };
    void after.service.start();
    await settle();
    after.sleeper = () => Promise.resolve();
    await after.service.shutdown(1);
    const snapshot = JSON.stringify(await after.repositories.readSnapshotData());
    const eventsAfter = after.events.length;
    hold.release();
    await settle();
    expect(JSON.stringify(await after.repositories.readSnapshotData())).toBe(snapshot);
    expect(after.events.slice(eventsAfter).filter((e) => e.type === 'session.updated')).toEqual([]);
    expect(after.codex.get(sessionId)!.dispatched).toEqual([]);
  });
});

describe('r2-P1-5 an adapter that never comes up does not hold the exit', () => {
  it('r2-P1-5 shutdown returns past the deadline while an initialize hangs, and ends that session’s Job', async () => {
    const w = await world();
    const hold = later();
    w.configure = (adapter) => {
      adapter.startGate = hold.gate;
    };
    const { sessionId } = await created(w);
    w.sleeper = () => Promise.resolve();
    await w.service.shutdown(1);
    expect(w.closed).toContain(sessionId);
    // When the initialize finally answers, nothing is started on the closed adapter.
    hold.release();
    await settle();
    const calls = w.codex.get(sessionId)!.calls;
    expect(calls).not.toContain('startSession');
    expect(calls).toContain('close');
  });
});

describe('r2-P1-6 one closing gate for every way in', () => {
  it('r2-P1-6 a permission request after shutdown is declined, never approved', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    await w.service.shutdown();
    const handle = codex.ask(permissionRequest(sessionId));
    await settle();
    expect(handle.decision).toMatchObject({ outcome: 'decline', decidedBy: 'policy' });
  });

  it('r2-P1-6 a cross-tool send_message paused before closing answers shutting-down and opens no confirmation', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: c } = await created(w, 'claude', 'session-c');
    const hold = later();
    const get = w.repositories.sessions.get;
    let paused = false;
    w.repositories.sessions.get = async (id) => {
      if (!paused) {
        paused = true;
        await hold.gate;
      }
      return get(id);
    };
    const result = w.service.sendMessage({ to: c, content: 'cross' }, { caller: a, operationId: OperationId.parse('op-x'), sourceCallRef: 'call-x' });
    await settle();
    const shutdown = w.service.shutdown();
    hold.release();
    await shutdown;
    expect(await result).toMatchObject({ status: 'rejected', rejection: { reason: 'shutting-down' } });
    expect([...w.repositories.escalationRecords.values()].filter((e) => e.kind === 'confirmation')).toEqual([]);
    expect(w.events.filter((e) => e.type === 'escalation.updated')).toEqual([]);
  });

  it('r2-P1-6 a reparent queued behind another one answers runtime_unavailable once closing began', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const { sessionId: p } = await created(w, 'codex', 'session-p');
    const hold = later();
    const list = w.repositories.sessions.list;
    let paused = false;
    w.repositories.sessions.list = async () => {
      if (!paused) {
        paused = true;
        await hold.gate;
      }
      return list();
    };
    const revision = await latest(w, 'session-a');
    const first = w.run({ type: 'session.reparent', requestId: rid(), sessionId, expectedRevision: revision, parentId: p });
    await settle();
    const second = w.run({ type: 'session.reparent', requestId: rid(), sessionId, expectedRevision: revision + 1, parentId: null });
    const shutdown = w.service.shutdown();
    hold.release();
    await first;
    expect(await second).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    await shutdown;
    expect((await session(w, 'session-a')).parentId).toBe(p);
  });
});

describe('r2-P1-7 only a proven echo is dropped', () => {
  const userMessage = (sessionId: SessionId, id: string, turn: string, text: string) => ({
    id: MessageId.parse(id),
    sessionId,
    turnId: TurnId.parse(turn),
    role: 'user' as const,
    origin: { kind: 'user' as const },
    text,
    attachments: [],
    createdAt: at,
  });

  it('r2-P1-7 after recovery, another turn’s message with the same text is kept and the real echo is dropped', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await w.service.delivery.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-1'),
      payloadHash: hashOf('again'),
      payload: 'again',
      proposalRevision: 0,
      target: { sessionId, nativeSessionRef: 'thread-1' },
      at,
      context: { runtime: 'codex', cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false } },
    });
    const after = w.restart();
    await after.service.start();
    const codex = after.codex.get(sessionId)!;
    expect(codex.dispatched).toHaveLength(1);
    // The fake answers the first dispatch with turn-1.
    codex.emit({ type: 'message.completed', message: userMessage(sessionId, 'other', 'turn-9', 'again') });
    codex.emit({ type: 'message.completed', message: userMessage(sessionId, 'echo', 'turn-1', 'again') });
    await settle();
    expect((await after.repositories.conversations.get(sessionId)).messages.map((m) => m.id)).toEqual(['m-1', 'other']);
  });

  it('r2-P1-7 a message under the dispatched clientMessageId but with other text or in another turn is kept', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'));
    const codex = w.codex.get(sessionId)!;
    const clientMessageId = codex.dispatched[0]!.attempt.clientMessageId;
    codex.emit({ type: 'message.completed', message: userMessage(sessionId, clientMessageId, 'turn-1', 'not the same') });
    codex.emit({ type: 'message.completed', message: { ...userMessage(sessionId, 'x', 'turn-7', 'hello'), id: MessageId.parse(`${clientMessageId}`) } });
    await settle();
    const ids = (await w.repositories.conversations.get(sessionId)).messages.map((m) => m.id);
    expect(ids).toEqual(['m-1', clientMessageId]);
  });

  it('r2-P1-7 without proof (an unknown dispatch) the echo is kept: a duplicate rather than a loss', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.dispatchModes.push('lost');
    await send(w, sessionId, 'maybe', 'm-1', await latest(w, 'session-a'));
    codex.emit({ type: 'message.completed', message: userMessage(sessionId, 'echo', 'turn-1', 'maybe') });
    await settle();
    expect((await w.repositories.conversations.get(sessionId)).messages.map((m) => m.id)).toEqual(['m-1', 'echo']);
  });
});

describe('r2-P1-8 a message ID another session holds', () => {
  it('r2-P1-8 is refused before anything is accepted or sent', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    w.codex.get(b)!.emit({ type: 'message.completed', message: { id: MessageId.parse('collision'), sessionId: b, role: 'assistant', origin: { kind: 'agent' }, text: 'mine', attachments: [], createdAt: at } });
    await settle();
    expect(await send(w, a, 'hello', 'collision', await latest(w, 'session-a'))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await w.store.get(OperationId.parse('user-message:collision'))).toBeUndefined();
    expect(w.codex.get(a)!.dispatched).toEqual([]);
    expect((await w.repositories.conversations.get(a)).messages).toEqual([]);
    expect(w.events.filter((e) => e.type === 'message.completed' && e.message.sessionId === a)).toEqual([]);
  });
});
