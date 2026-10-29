// T021 smoke run on the real machine: what only the live GUI showed, as regression tests on memory ports and
// fake adapters. The adapter and process-host halves are in adapters/codex and adapters/process.
import { describe, expect, it } from 'vitest';
import { ItemId, MessageId, NativeTaskId, PermissionRequestId, type SessionId, TurnId } from '../../contracts';
import type { FakeHandle } from './testing/fake-adapter';
import { permissionRequest } from './testing/fake-adapter';
import { created, rid, session, settle, world, type World } from './testing/harness';

const at = '2026-10-29T01:00:00.000Z';
const turnId = TurnId.parse('turn-1');
const runningTurn = (sessionId: SessionId) => ({ type: 'turn.updated' as const, turn: { id: turnId, sessionId, state: 'running' as const, startedAt: at } });
const latest = async (w: World, id: string) => (await session(w, id)).revision;

/** What the real adapters do: the request is pushed again each time its state changes (held, answered). */
const pushState = (w: World, sessionId: SessionId, handle: FakeHandle) => {
  const request = handle.decision ? { ...handle.request, state: 'answered' as const, decision: handle.decision } : handle.request;
  if (request.state === 'answered') delete (request as { hold?: unknown }).hold;
  w.codex.get(sessionId)!.emit({ type: 'permission.updated', request });
};

const holdOne = async (w: World, sessionId: SessionId) => {
  w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
  const handle = w.codex.get(sessionId)!.ask(permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-held') }));
  await settle();
  pushState(w, sessionId, handle);
  await settle();
  const escalation = [...w.repositories.escalationRecords.values()].find((e) => e.state === 'open')!;
  return { handle, escalation };
};

describe('T021 waiting-user: a session blocked on the user says so', () => {
  it('T021 a request held for the user shows the session as waiting-user, and running again once the user answered', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit({ type: 'session.activity', sessionId, activity: 'running', at });
    codex.emit(runningTurn(sessionId));
    await settle();
    const { handle, escalation } = await holdOne(w, sessionId);
    expect((await session(w, 'session-a')).activity).toBe('waiting-user');
    expect(w.events.some((e) => e.type === 'session.updated' && e.session.id === sessionId && e.session.activity === 'waiting-user')).toBe(true);

    expect((await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'approve' })).ok).toBe(true);
    pushState(w, sessionId, handle);
    await settle();
    expect((await session(w, 'session-a')).activity).toBe('running');
  });

  it('T021 a session whose turn ended while its request waited is idle once the request is withdrawn', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit(runningTurn(sessionId));
    await settle();
    const { handle } = await holdOne(w, sessionId);
    expect((await session(w, 'session-a')).activity).toBe('waiting-user');
    codex.emit({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'interrupted', startedAt: at, endedAt: at } });
    handle.withdraw();
    codex.emit({ type: 'permission.updated', request: { ...permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-held') }), state: 'withdrawn' } });
    await settle();
    expect((await session(w, 'session-a')).activity).toBe('idle');
  });

  it('T021 one answered request does not end waiting-user while another one of the session still waits', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit(runningTurn(sessionId));
    await settle();
    w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
    const first = codex.ask(permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-a') }));
    const second = codex.ask(permissionRequest(sessionId, { id: PermissionRequestId.parse('perm-b') }));
    await settle();
    pushState(w, sessionId, first);
    pushState(w, sessionId, second);
    await settle();
    const open = [...w.repositories.escalationRecords.values()].filter((e) => e.state === 'open');
    expect(open).toHaveLength(2);
    const ofFirst = open.find((e) => e.ref?.kind === 'permission' && e.ref.permissionRequestId === 'perm-a')!;
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: ofFirst.id, decision: 'decline' });
    pushState(w, sessionId, first);
    await settle();
    expect((await session(w, 'session-a')).activity).toBe('waiting-user');
  });

  it('T021 a message to a session waiting for the user joins its running turn, as it would while running', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit({ type: 'session.activity', sessionId, activity: 'running', at });
    codex.emit(runningTurn(sessionId));
    await settle();
    await holdOne(w, sessionId);
    expect((await session(w, 'session-a')).activity).toBe('waiting-user');
    const sent = await w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse('m-1'), expectedRevision: await latest(w, 'session-a'), text: 'also this', attachments: [] });
    expect(sent.ok).toBe(true);
    await settle();
    expect(codex.dispatched.at(-1)?.entry).toMatchObject({ kind: 'insert' });
    // Exiting counts it as unfinished work too (R-14).
    expect((await w.service.unfinishedWork()).runningSessions).toEqual([sessionId]);
  });
});

describe('T021 restart after the GUI was killed mid-turn', () => {
  it('T021 turns, items and sub-agents the last run left running are recorded as cut off by its exit', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit(runningTurn(sessionId));
    codex.emit({ type: 'item.updated', item: { id: ItemId.parse('cmd-1'), sessionId, turnId, kind: 'command', command: 'sleep 90', cwd: 'E:\\work\\project', state: 'running', output: '', outputTruncated: false, startedAt: at } });
    codex.emit({ type: 'item.updated', item: { id: ItemId.parse('edit-1'), sessionId, turnId, kind: 'fileChange', changes: [{ path: 'E:\\work\\project\\a.txt', change: 'add' }], state: 'proposed', startedAt: at } });
    codex.emit({ type: 'item.updated', item: { id: ItemId.parse('done-1'), sessionId, turnId, kind: 'toolCall', tool: 'x', summary: 'x', state: 'completed', startedAt: at, endedAt: at } });
    codex.emit({
      type: 'nativeTask.updated',
      task: { id: NativeTaskId.parse('task-1'), sessionId, runtime: 'codex', parentRef: 'thread-1', nativeRef: 'child-1', label: 'helper', state: 'running', background: true, startedAt: at },
    });
    await settle();

    const after = w.restart();
    await after.service.start();
    const conversation = await after.repositories.conversations.get(sessionId);
    expect(conversation.turns).toMatchObject([{ id: turnId, state: 'interrupted', endedAt: at }]);
    const items = new Map(conversation.items.map((i) => [i.id, i]));
    expect(items.get(ItemId.parse('cmd-1'))).toMatchObject({ state: 'interrupted', endedAt: at });
    expect(items.get(ItemId.parse('edit-1'))).toMatchObject({ state: 'failed', endedAt: at });
    // What had ended stays as it was.
    expect(items.get(ItemId.parse('done-1'))).toMatchObject({ state: 'completed' });
    expect(conversation.nativeTasks).toMatchObject([{ state: 'stopped', endedAt: at }]);
    expect((await session(after, 'session-a')).activity).toBe('closed');
  });
});

describe('T021 R-12: the model a runtime reports when its session opens is recorded', () => {
  it('T021 Codex reports its configured model only on start and resume: the session shows it', async () => {
    const w = await world();
    w.configure = (adapter) => {
      adapter.openedModel = { source: 'configured', model: 'gpt-6-luna', observedAt: at };
    };
    const { sessionId } = await created(w);
    expect((await session(w, 'session-a')).observedModel).toEqual({ source: 'configured', model: 'gpt-6-luna', observedAt: at });
    expect(w.events.some((e) => e.type === 'model.observed' && e.sessionId === sessionId && e.observed.source === 'configured')).toBe(true);
  });

  it('T021 a runtime that knows nothing yet leaves the session at unknown', async () => {
    const w = await world();
    await created(w);
    expect((await session(w, 'session-a')).observedModel).toEqual({ source: 'unknown' });
  });
});
