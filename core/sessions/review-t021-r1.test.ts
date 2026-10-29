// T021 review round 1, P1-2: a background sub-agent's request held for the user made an idle session look
// busy, so a new message was sent as an insert into a turn that did not exist. Memory ports, fake adapters.
import { describe, expect, it } from 'vitest';
import { MessageId, NativeTaskId, OperationId, PermissionRequestId, type SessionId, TurnId } from '../../contracts';
import { permissionRequest } from './testing/fake-adapter';
import { created, rid, session, settle, world, type World } from './testing/harness';

const at = '2026-10-29T01:00:00.000Z';
const task = NativeTaskId.parse('task-bg');
const mainTurn = TurnId.parse('turn-main');

/** A background sub-agent's request held for the user, pushed as the real adapters push it. */
const holdForSubAgent = async (w: World, sessionId: SessionId, extra: Parameters<typeof permissionRequest>[1] = {}) => {
  const codex = w.codex.get(sessionId)!;
  codex.emit({
    type: 'nativeTask.updated',
    task: { id: task, sessionId, runtime: 'codex', parentRef: 'thread-1', nativeRef: 'child-1', label: 'helper', state: 'running', background: true, startedAt: at },
  });
  w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
  const handle = codex.ask(permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-bg'), nativeTaskId: task, turnId: TurnId.parse('turn-child'), ...extra }));
  await settle();
  codex.emit({ type: 'permission.updated', request: handle.request });
  await settle();
  return handle;
};
const send = async (w: World, sessionId: SessionId, text: string) =>
  w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(`m-${text}`), expectedRevision: (await session(w, sessionId)).revision, text, attachments: [] });

describe('t021-r1-P1-2 a background sub-agent waiting for the user does not make the session busy', () => {
  it("t021-r1-P1-2 the reviewer's case: idle session, background sub-agent held, send → new-turn, and it is sent", async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await holdForSubAgent(w, sessionId);
    expect((await session(w, sessionId)).activity).toBe('idle');
    const sent = await send(w, sessionId, 'hello');
    expect(sent.ok).toBe(true);
    await settle();
    const codex = w.codex.get(sessionId)!;
    expect(codex.dispatched.at(-1)).toMatchObject({ text: 'hello', entry: { kind: 'new-turn' } });
    expect((await w.store.get(OperationId.parse('user-message:m-hello')))?.delivery.state).toBe('sent');
  });

  it('t021-r1-P1-2 a send_message to that session starts a turn too', async () => {
    const w = await world();
    const { sessionId: target } = await created(w);
    const { sessionId: caller } = await created(w, 'codex', 'session-b');
    await holdForSubAgent(w, target);
    const result = await w.service.sendMessage({ to: target, content: 'ping' }, { caller, operationId: OperationId.parse('op-1'), sourceCallRef: 'call-1' });
    expect(result).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect(w.codex.get(target)!.dispatched.at(-1)).toMatchObject({ entry: { kind: 'new-turn' } });
  });

  it("t021-r1-P1-2 a sub-agent request inside the running main turn still marks the session waiting-user, and an insert joins it", async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit({ type: 'session.activity', sessionId, activity: 'running', at });
    codex.emit({ type: 'turn.updated', turn: { id: mainTurn, sessionId, state: 'running', startedAt: at } });
    await settle();
    await holdForSubAgent(w, sessionId, { turnId: mainTurn });
    expect((await session(w, sessionId)).activity).toBe('waiting-user');
    await send(w, sessionId, 'more');
    await settle();
    expect(codex.dispatched.at(-1)).toMatchObject({ text: 'more', entry: { kind: 'insert' } });
  });

  it('t021-r1-P1-2 a session marked waiting-user with no main turn running gets a new turn, never an insert', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    // A main-session request outside any turn (no nativeTaskId): waiting-user, but nothing to insert into.
    w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
    const handle = codex.ask(permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-main') }));
    await settle();
    codex.emit({ type: 'permission.updated', request: handle.request });
    await settle();
    expect((await session(w, sessionId)).activity).toBe('waiting-user');
    await send(w, sessionId, 'now');
    await settle();
    expect(codex.dispatched.at(-1)).toMatchObject({ text: 'now', entry: { kind: 'new-turn' } });
  });
});
