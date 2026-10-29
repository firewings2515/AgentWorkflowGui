// T017 review round 1: every reproduction from T017-r1-result.md as a regression test on the session
// service (memory ports, fake adapters). r1-P1-1 and r1-P1-6 are in core/delivery and app/main.
import { describe, expect, it } from 'vitest';
import { ItemId, MessageId, NativeTaskId, OperationId, type SessionId, TurnId } from '../../contracts';
import { hashOf } from '../delivery/testing/fixtures';
import { CWD, created, rid, session, settle, world, type World } from './testing/harness';

const send = (w: World, sessionId: SessionId, text: string, messageId: string, revision: number) =>
  w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(messageId), expectedRevision: revision, text, attachments: [] });
const latest = async (w: World, id: string) => (await session(w, id)).revision;
const at = '2026-10-29T01:00:00.000Z';

describe('r1-P1-2 MCP tokens never reach events, storage or logs', () => {
  it('r1-P1-2 redacts every token handed out from runtime.exited errors, message text and command output', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    codex.emit({ type: 'message.completed', message: { id: MessageId.parse('a-1'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: `MCP said Bearer ${token}`, attachments: [], createdAt: at } });
    codex.emit({
      type: 'item.updated',
      item: { id: ItemId.parse('cmd-1'), sessionId, kind: 'command', command: 'echo', cwd: CWD, state: 'completed', output: `token=${token}`, outputTruncated: false, startedAt: at, endedAt: at },
    });
    codex.emit({ type: 'runtime.exited', runtime: 'codex', sessionIds: [sessionId], expected: false, code: 1, signal: null, error: `mcp gui failed: Authorization: Bearer ${token}`, at });
    await settle();
    const stored = JSON.stringify(await w.repositories.readSnapshotData());
    expect(stored).not.toContain(token);
    expect(stored).toContain('[redacted]');
    expect(JSON.stringify(w.events)).not.toContain(token);
    expect(JSON.stringify(w.events)).toContain('Bearer [redacted]');
  });

  it('r1-P1-2 a start that fails with an error quoting its token is reported without it', async () => {
    const w = await world();
    w.configure = (adapter) => {
      adapter.startModes.push('fail');
      // The fake quotes the mount it was given, as a failing MCP connection might.
      const start = adapter.startSession.bind(adapter);
      adapter.startSession = (options) => {
        adapter.startError = `connect ${options.mcp?.url ?? ''} with ${options.mcp?.token ?? ''} failed`;
        return start(options);
      };
    };
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const result = await send(w, sessionId, 'hi', 'm-1', await latest(w, 'session-a'));
    expect(JSON.stringify(result)).not.toContain(token);
    expect(w.logs.join('\n')).not.toContain(token);
    expect(JSON.stringify(w.events)).not.toContain(token);
    expect(JSON.stringify(await w.repositories.readSnapshotData())).not.toContain(token);
  });
});

describe('r1-P1-3 a resend must be the same message from the same session', () => {
  const call = (w: World, caller: SessionId, to: string, content: string, operationId = 'op-1', sourceCallRef = 'call-1') =>
    w.service.sendMessage({ to: to as SessionId, content }, { caller, operationId: OperationId.parse(operationId), sourceCallRef });

  it('r1-P1-3 the same operationId with changed content, another target or another caller is rejected, not a duplicate', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    const { sessionId: c } = await created(w, 'codex', 'session-c');
    expect(await call(w, a, b, 'original')).toMatchObject({ status: 'accepted' });
    // The reviewer's case: same operationId, new sourceCallRef, changed content.
    expect(await call(w, a, b, 'changed', 'op-1', 'call-2')).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    expect(await call(w, a, c, 'original')).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    expect(await call(w, c, b, 'original')).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    // The same message again is still the same operation.
    expect(await call(w, a, b, 'original', 'op-1', 'call-3')).toMatchObject({ status: 'duplicate' });
    expect(w.codex.get(b)!.dispatched).toHaveLength(1);
  });

  it('r1-P1-3 after a restart an existing operation of unknown owner is refused (retryOf can no longer be checked)', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    expect(await call(w, a, b, 'original')).toMatchObject({ status: 'accepted' });
    const after = w.restart();
    await after.service.start();
    expect(await call(after, a, b, 'original', 'op-1', 'call-9')).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
  });

  it('r1-P1-3 a cross-tool message waiting for the user cannot be swapped by a resend', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: c } = await created(w, 'claude', 'session-claude');
    expect(await call(w, a, c, 'original')).toMatchObject({ status: 'awaiting-confirmation' });
    expect(await call(w, a, c, 'changed', 'op-1', 'call-2')).toMatchObject({ status: 'rejected' });
    expect(await call(w, a, c, 'original', 'op-1', 'call-3')).toMatchObject({ status: 'awaiting-confirmation' });
  });
});

describe('r1-P1-4 commands and events of a session share one queue', () => {
  it('r1-P1-4 an activity event during a slow setModel neither makes it stale nor leaves the runtime and the record apart', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    let release!: () => void;
    codex.setModelGate = new Promise((resolve) => (release = resolve));
    const model = { runtime: 'codex' as const, model: 'gpt-6.1-sol' };
    const pending = w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), model });
    await settle();
    codex.emit({ type: 'session.activity', sessionId, activity: 'running', at });
    await settle();
    release();
    expect(await pending).toMatchObject({ ok: true });
    await settle();
    expect(codex.models).toEqual([{ ref: 'thread-1', model }]);
    const s = await session(w, 'session-a');
    expect(s.requestedModel).toEqual(model);
    expect(s.activity).toBe('running');
  });

  it('r1-P1-4 a runtime that refuses the model leaves the record as it was', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const before = (await session(w, 'session-a')).requestedModel;
    w.codex.get(sessionId)!.setModelError = new Error('no such model');
    const result = await w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), model: { runtime: 'codex', model: 'nope' } });
    expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect((await session(w, 'session-a')).requestedModel).toEqual(before);
  });
});

describe('r1-P1-5 exit settles running and queued work', () => {
  it('r1-P1-5 a start that returns after shutdown began is closed again at once and never counted as open', async () => {
    const w = await world();
    w.configure = (adapter) => adapter.startModes.push('held');
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    const shutdown = w.service.shutdown();
    await settle();
    codex.release();
    await shutdown;
    expect(w.service.runtimes.openSessions()).toEqual([]);
    expect(codex.closedSessions).toEqual(['thread-1']);
    expect(w.closed).toContain(sessionId);
  });

  it('r1-P1-5 a command queued behind running work answers runtime_unavailable once closing began, and never reaches the runtime', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    let release!: () => void;
    codex.setModelGate = new Promise((resolve) => (release = resolve));
    const revision = await latest(w, 'session-a');
    const slow = w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: revision, model: { runtime: 'codex', model: 'm2' } });
    await settle();
    const queued = send(w, sessionId, 'late', 'm-late', revision + 1);
    const shutdown = w.service.shutdown();
    await settle();
    release();
    await slow;
    expect(await queued).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    await shutdown;
    expect(codex.dispatched).toHaveLength(0);
  });

  it('r1-P1-5 past the deadline the sessions are closed anyway (R-14)', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.setModelGate = new Promise(() => undefined);
    void w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), model: { runtime: 'codex', model: 'm2' } });
    await settle();
    w.sleeper = () => Promise.resolve();
    await w.service.shutdown(10);
    expect(codex.closedSessions).toEqual(['thread-1']);
  });
});

describe('r1-P1-7 an event that cannot be stored is not pushed', () => {
  it('r1-P1-7 a failed message write keeps the event from the renderer and logs only the code', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const append = w.repositories.conversations.appendMessage;
    w.repositories.conversations.appendMessage = () => Promise.reject(new Error('disk full: SECRET_TEXT'));
    w.codex.get(sessionId)!.emit({ type: 'message.completed', message: { id: MessageId.parse('a-1'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: 'SECRET_TEXT', attachments: [], createdAt: at } });
    await settle();
    expect(w.events.filter((e) => e.type === 'message.completed')).toEqual([]);
    expect(w.logs.join('\n')).toContain('message.completed');
    expect(w.logs.join('\n')).not.toContain('SECRET_TEXT');
    // The next event that can be stored is pushed as usual.
    w.repositories.conversations.appendMessage = append;
    w.codex.get(sessionId)!.emit({ type: 'message.completed', message: { id: MessageId.parse('a-2'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: 'ok', attachments: [], createdAt: at } });
    await settle();
    expect(w.events.filter((e) => e.type === 'message.completed')).toHaveLength(1);
  });
});

describe('r1-P1-8 the user message survives a failure after acceptance', () => {
  it('r1-P1-8 a failed message write accepts nothing; the retry with the same messageId writes and sends it once', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const append = w.repositories.conversations.appendMessage;
    w.repositories.conversations.appendMessage = () => Promise.reject(new Error('busy'));
    await expect(send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'))).rejects.toThrow();
    // The message comes first now (r2-P1-8): nothing was accepted or sent without it.
    expect(await w.store.get(OperationId.parse('user-message:m-1'))).toBeUndefined();
    w.repositories.conversations.appendMessage = append;
    expect(await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'))).toMatchObject({ ok: true });
    expect((await w.repositories.conversations.get(sessionId)).messages).toMatchObject([{ id: 'm-1', text: 'hello' }]);
    expect(w.codex.get(sessionId)!.dispatched).toHaveLength(1);
  });

  it('r1-P1-8 an operation accepted earlier without its message gets the message from the retry', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await w.service.delivery.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-1'),
      payloadHash: hashOf('hello'),
      payload: 'hello',
      proposalRevision: await latest(w, 'session-a'),
      target: { sessionId, nativeSessionRef: 'thread-1' },
      at,
      context: { runtime: 'codex', cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false } },
    });
    expect(await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'))).toMatchObject({ ok: true });
    expect((await w.repositories.conversations.get(sessionId)).messages).toMatchObject([{ id: 'm-1', text: 'hello' }]);
    expect(w.codex.get(sessionId)!.dispatched).toHaveLength(1);
  });

  it('r1-P1-8 recovery writes the message of an operation accepted before a crash', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await w.service.delivery.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-2'),
      payloadHash: hashOf('later'),
      payload: 'later',
      proposalRevision: 0,
      target: { sessionId, nativeSessionRef: 'thread-1' },
      at,
      context: { runtime: 'codex', cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false } },
    });
    const after = w.restart();
    await after.service.start();
    expect((await after.repositories.conversations.get(sessionId)).messages).toMatchObject([{ id: 'm-2', text: 'later', role: 'user' }]);
  });
});

describe('r1-P1-9 only the echo of this process’s own message is dropped', () => {
  it('r1-P1-9 a native sub-agent’s prompt (a user message with nativeTaskId) is stored and pushed', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await send(w, sessionId, 'do it', 'm-1', await latest(w, 'session-a'));
    const prompt = { id: MessageId.parse('sub-1'), sessionId, nativeTaskId: NativeTaskId.parse('task-1'), role: 'user' as const, origin: { kind: 'user' as const }, text: 'do it', attachments: [], createdAt: at };
    w.codex.get(sessionId)!.emit({ type: 'message.completed', message: prompt });
    await settle();
    expect((await w.repositories.conversations.get(sessionId)).messages.map((m) => m.id)).toEqual(['m-1', 'sub-1']);
    expect(w.events).toContainEqual({ type: 'message.completed', message: prompt });
  });

  it('r1-P1-9 a user message in another turn is not taken for the echo', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'));
    const codex = w.codex.get(sessionId)!;
    const echo = (id: string, turn: string) => ({ id: MessageId.parse(id), sessionId, turnId: TurnId.parse(turn), role: 'user' as const, origin: { kind: 'user' as const }, text: 'hello', attachments: [], createdAt: at });
    codex.emit({ type: 'message.completed', message: echo('other', 'turn-9') });
    codex.emit({ type: 'message.completed', message: echo('echo', 'turn-1') });
    await settle();
    expect((await w.repositories.conversations.get(sessionId)).messages.map((m) => m.id)).toEqual(['m-1', 'other']);
  });
});
