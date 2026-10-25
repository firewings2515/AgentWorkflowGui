// The runtime port (T005/T006) on the Codex adapter: session start / resume, model changes, inserts,
// interrupts, the native process reference and stored history. Scripts reuse the SP-01 handshake.
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, NativeTaskId } from '../../contracts';
import type { DispatchRequest, RuntimeAdapter } from '../../core/ports';
import { CodexAdapter } from './adapter';
import { ISOLATION_CONFIG } from './protocol';
import { loadFixture, notify, out, recordedResult, reply, replyError, type ReplayRecord } from './testing/fake-app-server';
import { expectValidEvents, SESSION, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const TURN_ID = '01a16795-3172-7802-a04e-3b9e5974a6f9';
const CWD = 'E:\\work\\task';
const AT = '2026-10-24T12:00:00.000Z';

const init = (): ReplayRecord[] => [out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized')];
const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }];
const wireTurn = (id: string, status: string, startedAt = 1792739193, completedAt: number | null = status === 'inProgress' ? null : 1792739196) => ({
  id,
  items: [],
  status,
  error: null,
  startedAt,
  completedAt,
});
const turnStarted = notify('turn/started', { threadId: THREAD_ID, turn: wireTurn(TURN_ID, 'inProgress') });
const turnCompleted = notify('turn/completed', { threadId: THREAD_ID, turn: wireTurn(TURN_ID, 'completed') });

const attempt = (n: number): DispatchRequest['attempt'] => ({
  state: 'unknown',
  attemptId: AttemptId.parse(`attempt-${n}`),
  clientMessageId: ClientMessageId.parse(`9a7c1e52-0d3b-4f6e-8a21-${String(n).padStart(12, '0')}`),
  dispatchStartedAt: AT,
});
const dispatch = (n: number, entry: DispatchRequest['entry'], t = `payload ${n}`): DispatchRequest => ({ nativeSessionRef: THREAD_ID, attempt: attempt(n), text: t, entry });

const resumed = async (records: ReplayRecord[]) => {
  const h = setup([...init(), out('thread/resume', 2), reply(2, recordedResult(sp01, 'thread/start')), ...records]);
  await h.adapter.start();
  await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
  return h;
};

describe('RuntimeAdapter port', () => {
  it('is a RuntimeAdapter for the codex runtime', () => {
    const adapter: RuntimeAdapter = new CodexAdapter({ onPermissionRequest: () => undefined });
    expect(adapter.runtime).toBe('codex');
  });

  it('starts a session with the read-only sandbox, instructions and model, and sends the effort with the first turn', async () => {
    const h = setup([
      ...init(),
      out('thread/start', 2, {
        cwd: CWD,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        ephemeral: false,
        sandbox: 'read-only',
        config: ISOLATION_CONFIG,
        model: 'gpt-6-luna',
        developerInstructions: 'Review only.',
      }),
      reply(2, recordedResult(sp01, 'thread/start')),
      out('turn/start', 3, { threadId: THREAD_ID, input: text('first'), clientUserMessageId: attempt(1).clientMessageId, model: 'gpt-6-luna', effort: 'high' }),
      reply(3, recordedResult(sp01, 'turn/start')),
      // setModel only takes effect with the next turn/start (R-12); a second dispatch then names nothing.
      out('turn/start', 4, { threadId: THREAD_ID, input: text('second'), clientUserMessageId: attempt(2).clientMessageId, model: 'gpt-6.1-sol', effort: 'low' }),
      reply(4, recordedResult(sp01, 'turn/start')),
      out('turn/start', 5, { threadId: THREAD_ID, input: text('third'), clientUserMessageId: attempt(3).clientMessageId }),
      reply(5, recordedResult(sp01, 'turn/start')),
    ]);
    await h.adapter.start();
    const info = await h.adapter.startSession({
      sessionId: SESSION,
      cwd: CWD,
      model: { runtime: 'codex', model: 'gpt-6-luna', effort: 'high' },
      readOnly: true,
      instructions: 'Review only.',
      preallocatedRef: 'ignored-by-codex',
    });
    expect(info).toEqual({ sessionId: SESSION, nativeSessionRef: THREAD_ID, cwd: expect.any(String) as unknown, model: { source: 'configured', model: 'gpt-6-luna', observedAt: AT } });

    expect(await h.adapter.dispatchOnce(dispatch(1, { kind: 'new-turn' }, 'first'))).toMatchObject({ state: 'sent' });
    expect(await h.adapter.setModel(THREAD_ID, { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'low' })).toBe('next-turn');
    expect(h.fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(await h.adapter.dispatchOnce(dispatch(2, { kind: 'new-turn' }, 'second'))).toMatchObject({ state: 'sent' });
    expect(await h.adapter.dispatchOnce(dispatch(3, { kind: 'new-turn' }, 'third'))).toMatchObject({ state: 'sent' });
    expect(h.fake.mismatches).toEqual([]);
  });

  it('resumes a session with its model and lets an explicit entry model win over a pending one', async () => {
    const h = setup([
      ...init(),
      out('thread/resume', 2, {
        threadId: THREAD_ID,
        cwd: CWD,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        ephemeral: false,
        sandbox: 'workspace-write',
        config: ISOLATION_CONFIG,
        model: 'gpt-6.1-sol',
        excludeTurns: true,
      }),
      reply(2, recordedResult(sp01, 'thread/start')),
      out('turn/start', 3, { threadId: THREAD_ID, input: text('go'), clientUserMessageId: attempt(1).clientMessageId, model: 'gpt-6-luna', effort: 'low' }),
      reply(3, recordedResult(sp01, 'turn/start')),
      out('turn/start', 4, { threadId: THREAD_ID, input: text('again'), clientUserMessageId: attempt(2).clientMessageId }),
      reply(4, recordedResult(sp01, 'turn/start')),
    ]);
    await h.adapter.start();
    const info = await h.adapter.resumeSession({
      sessionId: SESSION,
      nativeSessionRef: THREAD_ID,
      cwd: CWD,
      model: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      readOnly: false,
    });
    expect(info).toMatchObject({ sessionId: SESSION, nativeSessionRef: THREAD_ID });
    await h.adapter.dispatchOnce(dispatch(1, { kind: 'new-turn', model: { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' } }, 'go'));
    // The pending selection was replaced by the explicit one, so nothing is sent a second time.
    await h.adapter.dispatchOnce(dispatch(2, { kind: 'new-turn' }, 'again'));
    expect(h.fake.mismatches).toEqual([]);
  });

  it('refuses a model of another runtime before anything is sent', async () => {
    const h = setup(init());
    await h.adapter.start();
    await expect(h.adapter.startSession({ sessionId: SESSION, cwd: CWD, model: { runtime: 'claude', model: 'opus' }, readOnly: false })).rejects.toThrow(/claude/);
    expect(h.fake.received.map((m) => m.method)).toEqual(['initialize', 'initialized']);
  });

  it('rejects setModel and interrupt for a session it does not know', async () => {
    const h = setup(init());
    await h.adapter.start();
    await expect(h.adapter.setModel('nope', { runtime: 'codex', model: 'gpt-6-luna' })).rejects.toThrow(/not bound/);
    await expect(h.adapter.interrupt('nope')).rejects.toThrow(/not bound/);
  });
});

describe('inserting into the running turn', () => {
  it('uses the running turn it saw start when the caller names none', async () => {
    const h = await resumed([turnStarted, out('turn/steer', 3, { threadId: THREAD_ID, expectedTurnId: TURN_ID, input: text('more'), clientUserMessageId: attempt(1).clientMessageId }), reply(3, { turnId: TURN_ID })]);
    await until(() => h.of('turn.updated').length === 1, 'turn start seen');
    const result = await h.adapter.dispatchOnce(dispatch(1, { kind: 'insert' }, 'more'));
    expect(result).toMatchObject({ state: 'sent', nativeRef: { sessionRef: THREAD_ID, turnRef: TURN_ID } });
    expect(h.fake.mismatches).toEqual([]);
  });

  it('sends nothing when no running turn is known, and the same attempt can go out once one is', async () => {
    const h = await resumed([
      turnStarted,
      turnCompleted,
      out('turn/steer', 3, { threadId: THREAD_ID, expectedTurnId: TURN_ID, input: text('more'), clientUserMessageId: attempt(1).clientMessageId }),
      reply(3, { turnId: TURN_ID }),
    ]);
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'turn end');
    const refused = await h.adapter.dispatchOnce(dispatch(1, { kind: 'insert' }, 'more'));
    expect(refused).toMatchObject({ state: 'unknown', reason: 'rejected', written: false });
    expect(h.fake.received.some((m) => m.method === 'turn/steer')).toBe(false);
    // Nothing left the process, so the attempt was not used up; an explicit turn goes through.
    expect(await h.adapter.dispatchOnce(dispatch(1, { kind: 'insert', expectedTurnRef: TURN_ID }, 'more'))).toMatchObject({ state: 'sent' });
    expect(h.fake.mismatches).toEqual([]);
  });
});

describe('interrupt and stopNativeTask', () => {
  it('interrupts the turn it saw start', async () => {
    const h = await resumed([turnStarted, out('turn/interrupt', 3, { threadId: THREAD_ID, turnId: TURN_ID }), reply(3, {})]);
    await h.fake.idle();
    await h.adapter.interrupt(THREAD_ID);
    expect(h.fake.mismatches).toEqual([]);
    expect(h.fake.received.filter((m) => m.method === 'turn/interrupt')).toHaveLength(1);
  });

  it('looks for a running turn it did not see start, and does nothing when there is none', async () => {
    const list = { threadId: THREAD_ID, limit: 1, sortDirection: 'desc' };
    const h = await resumed([
      out('thread/turns/list', 3, list),
      reply(3, { data: [wireTurn(TURN_ID, 'inProgress')], nextCursor: null }),
      out('turn/interrupt', 4, { threadId: THREAD_ID, turnId: TURN_ID }),
      reply(4, {}),
      out('thread/turns/list', 5, list),
      reply(5, { data: [wireTurn(TURN_ID, 'completed')], nextCursor: null }),
    ]);
    await h.adapter.interrupt(THREAD_ID);
    await h.adapter.interrupt(THREAD_ID);
    expect(h.fake.received.filter((m) => m.method === 'turn/interrupt')).toHaveLength(1);
    expect(h.fake.mismatches).toEqual([]);
  });

  it('stops only native tasks of the session, never other threads', async () => {
    const h = await resumed([out('thread/items/list', 3, { threadId: THREAD_ID, limit: 200, sortDirection: 'asc' }), reply(3, { data: [], nextCursor: null, backwardsCursor: null })]);
    await expect(h.adapter.stopNativeTask(THREAD_ID, 'unknown-thread')).rejects.toThrow(/not a native task/);
    // The session's own thread is not a native task either.
    await expect(h.adapter.stopNativeTask(THREAD_ID, THREAD_ID)).rejects.toThrow(/not a native task/);
    expect(h.fake.received.some((m) => m.method === 'turn/interrupt')).toBe(false);
  });
});

describe('native process reference', () => {
  const command = (processId: unknown, status: string, extra: Record<string, unknown> = {}) => ({
    type: 'commandExecution',
    id: 'exec-p',
    command: 'build',
    cwd: CWD,
    processId,
    status,
    aggregatedOutput: null,
    exitCode: null,
    ...extra,
  });

  it('carries the processId of a command, whenever Codex reports it', async () => {
    const h = await resumed([
      turnStarted,
      notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1792739195000, item: command(null, 'inProgress') }),
      notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1792739196000, item: command('4891', 'completed', { exitCode: 0 }) }),
      notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1792739197000, item: command('', 'inProgress') }),
    ]);
    await until(() => h.of('item.updated').length === 3, 'items');
    const items = h.of('item.updated').map((e) => e.item);
    expect(items[0]).not.toHaveProperty('nativeProcessRef');
    expect(items[1]).toMatchObject({ kind: 'command', state: 'completed', nativeProcessRef: '4891' });
    // An empty handle is no handle.
    expect(items[2]).not.toHaveProperty('nativeProcessRef');
    expectValidEvents(h.events);
  });
});

describe('runtime.exited', () => {
  it('names the runtime and every session the process hosted', async () => {
    const h = await resumed([]);
    await h.adapter.close();
    const [exited] = h.of('runtime.exited');
    expect(exited).toMatchObject({ runtime: 'codex', sessionIds: [SESSION], expected: true });
    expectValidEvents(h.events);
  });
});

// ---- readHistory ----------------------------------------------------------------------------------

const CHILD_A = '01a167fd-0e9e-70a3-baba-cfdbcc1e464a';
const CHILD_B = '01a167fd-0f09-7f10-b499-85674fe07a1c';
const userItem = (id: string, t: string) => ({ type: 'userMessage', id, clientId: null, content: text(t) });
const agentItem = (id: string, t: string) => ({ type: 'agentMessage', id, text: t, phase: 'final_answer' });
const commandItem = { type: 'commandExecution', id: 'exec-1', command: 'sleep 60', cwd: CWD, processId: '55', status: 'inProgress', aggregatedOutput: 'partial', exitCode: null };
const activity = (id: string, kind: string, child: string, path: string) => ({ type: 'subAgentActivity', id, kind, agentThreadId: child, agentPath: path });
const entry = (turnId: string, item: unknown, startedAtMs: number | null = 1792739195000, completedAtMs: number | null = 1792739195500) => ({ turnId, item, startedAtMs, completedAtMs });
const page = (data: unknown[]) => ({ data, nextCursor: null, backwardsCursor: null });
const ITEMS = { limit: 200, sortDirection: 'asc' };

const historyRequest = (extra: Partial<Parameters<CodexAdapter['readHistory']>[0]> = {}) => ({ sessionId: SESSION, nativeSessionRef: THREAD_ID, cwd: CWD, ...extra });

describe('readHistory', () => {
  const mainItems = [
    entry('turn-1', userItem('u-1', 'start')),
    entry('turn-1', commandItem, 1792739195000, null),
    entry('turn-1', activity('sa-1', 'started', CHILD_A, '/root/a')),
    entry('turn-1', activity('sa-2', 'started', CHILD_B, '/root/b')),
    entry('turn-1', activity('sa-3', 'completed', CHILD_B, '/root/b'), null, 1792739196500),
    entry('turn-2', userItem('u-2', 'continue')),
    entry('turn-2', agentItem('a-2', 'done')),
  ];
  const mainTurns = [wireTurn('turn-1', 'interrupted', 1792739194, 1792739197), wireTurn('turn-2', 'completed', 1792739198, 1792739199)];

  it('maps turns, messages and items oldest first, closes what an interrupted turn left open, and lists the native tasks', async () => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      reply(2, page(mainItems)),
      out('thread/turns/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page(mainTurns)),
      // CHILD_A never reported an end; its own newest turn did.
      out('thread/turns/list', 4, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      reply(4, page([wireTurn('child-turn', 'completed')])),
      // CHILD_B: the parent reported it completed, but its own newest turn failed, and the child decides (T003 r2).
      out('thread/turns/list', 5, { threadId: CHILD_B, limit: 1, sortDirection: 'desc' }),
      reply(5, page([wireTurn('child-turn-b', 'failed', 1792739194, 1792739196)])),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.complete).toBe(true);
    expect(result.entries.map((e) => (e.kind === 'turn' ? `turn:${e.turn.id}` : e.kind === 'message' ? `message:${e.message.id}` : `item:${e.item.id}`))).toEqual([
      'turn:turn-1',
      'message:u-1',
      'item:exec-1',
      'turn:turn-2',
      'message:u-2',
      'message:a-2',
    ]);
    const turn1 = result.entries.find((e) => e.kind === 'turn');
    expect(turn1).toMatchObject({ turn: { state: 'interrupted', sessionId: SESSION } });
    const command = result.entries.find((e) => e.kind === 'item');
    expect(command).toMatchObject({ item: { kind: 'command', state: 'interrupted', nativeProcessRef: '55', output: 'partial', turnId: 'turn-1', endedAt: new Date(1792739197000).toISOString() } });
    expect(result.nativeTasks).toEqual([
      expect.objectContaining({ nativeRef: CHILD_A, id: CHILD_A, label: '/root/a', state: 'completed', parentRef: THREAD_ID, lastActivity: 'turn completed' }),
      expect.objectContaining({ nativeRef: CHILD_B, label: '/root/b', state: 'failed', endedAt: new Date(1792739196000).toISOString() }),
    ]);
    // Read only: no resume, no turn.
    expect(h.fake.received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/items/list', 'thread/turns/list', 'thread/turns/list', 'thread/turns/list']);
    expect(h.fake.mismatches).toEqual([]);
  });

  it("reads a native sub-agent's own thread: its turns and entries carry the nativeTaskId and no session turn", async () => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: CHILD_A, ...ITEMS }),
      reply(2, page([entry('child-turn', userItem('cu-1', 'task')), entry('child-turn', commandItem, 1792739195000, 1792739195500), entry('child-turn', agentItem('ca-1', 'HERON'))])),
      out('thread/turns/list', 3, { threadId: CHILD_A, ...ITEMS }),
      reply(3, page([wireTurn('child-turn', 'completed')])),
    ]);
    await h.adapter.start();
    const taskId = NativeTaskId.parse(CHILD_A);
    const result = await h.adapter.readHistory(historyRequest({ nativeTask: { nativeTaskId: taskId, nativeRef: CHILD_A } }));
    expect(result.complete).toBe(true);
    expect(result.nativeTasks).toEqual([]);
    for (const e of result.entries) {
      const part = e.kind === 'turn' ? e.turn : e.kind === 'message' ? e.message : e.item;
      expect(part.nativeTaskId).toBe(taskId);
    }
    expect(result.entries.filter((e) => e.kind !== 'turn').every((e) => (e.kind === 'message' ? e.message.turnId : e.kind === 'item' ? e.item.turnId : 'x') === undefined)).toBe(true);
    // The turn ended without closing the command, so it does not stay open in the history.
    expect(result.entries.find((e) => e.kind === 'item')).toMatchObject({ item: { state: 'failed', endedAt: expect.any(String) as unknown } });
    expect(h.fake.mismatches).toEqual([]);
  });

  it('is incomplete, but still returns what it read, when the turn list cannot be read', async () => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      reply(2, page([entry('turn-2', userItem('u-2', 'continue'))])),
      out('thread/turns/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      replyError(3, -32600, 'cannot list turns'),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.complete).toBe(false);
    expect(result.entries.map((e) => e.kind)).toEqual(['message']);
  });

  it('falls back to thread/read, and is incomplete when a turn there is only a summary', async () => {
    const full = { ...wireTurn('turn-1', 'completed'), items: [userItem('u-1', 'start'), agentItem('a-1', 'ok')], itemsView: 'full' };
    const summary = { ...wireTurn('turn-2', 'completed'), items: [], itemsView: 'summary' };
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      replyError(2, -32600, 'thread not loaded'),
      out('thread/read', 3, { threadId: THREAD_ID, includeTurns: true }),
      reply(3, { thread: { ...(recordedResult(sp01, 'thread/start') as { thread: object }).thread, turns: [full, summary] } }),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.complete).toBe(false);
    expect(result.entries.map((e) => (e.kind === 'turn' ? `turn:${e.turn.id}` : e.kind === 'message' ? `message:${e.message.id}` : 'item'))).toEqual(['turn:turn-1', 'message:u-1', 'message:a-1', 'turn:turn-2']);
    expect(h.fake.mismatches).toEqual([]);
  });

  // Review r2 P1-1: a task is not given an end it was not shown to have.
  it.each([
    ['inProgress', 'started', true],
    ['inProgress', 'completed', false],
  ])('keeps a native task running when its newest turn is %s and the parent stored %s', async (status, parentKind, complete) => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      reply(2, page([entry('turn-1', activity('sa-1', 'started', CHILD_A, '/root/a')), ...(parentKind === 'completed' ? [entry('turn-1', activity('sa-2', 'completed', CHILD_A, '/root/a'), null, 1792739197000)] : [])])),
      out('thread/turns/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page([wireTurn('turn-1', 'completed')])),
      out('thread/turns/list', 4, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      reply(4, page([wireTurn('child-turn', status)])),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks).toEqual([expect.objectContaining({ nativeRef: CHILD_A, state: 'running' })]);
    expect(result.nativeTasks[0]).not.toHaveProperty('endedAt');
    expect(result.complete).toBe(complete);
  });

  it('does not take the parent end report for an answer when the child cannot be read', async () => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      reply(2, page([entry('turn-1', activity('sa-1', 'started', CHILD_A, '/root/a')), entry('turn-1', activity('sa-2', 'completed', CHILD_A, '/root/a'), null, 1792739197000)])),
      out('thread/turns/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page([wireTurn('turn-1', 'completed')])),
      out('thread/turns/list', 4, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      replyError(4, -32600, 'child not stored'),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks).toEqual([expect.objectContaining({ nativeRef: CHILD_A, state: 'running' })]);
    expect(result.nativeTasks[0]).not.toHaveProperty('endedAt');
    expect(result.complete).toBe(false);
  });

  it('uses the parent end report only when the child was read and has no turn at all', async () => {
    const h = setup([
      ...init(),
      out('thread/items/list', 2, { threadId: THREAD_ID, ...ITEMS }),
      reply(2, page([entry('turn-1', activity('sa-1', 'started', CHILD_A, '/root/a')), entry('turn-1', activity('sa-2', 'interrupted', CHILD_A, '/root/a'), null, 1792739197000)])),
      out('thread/turns/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page([wireTurn('turn-1', 'completed')])),
      out('thread/turns/list', 4, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      reply(4, page([])),
    ]);
    await h.adapter.start();
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks).toEqual([expect.objectContaining({ nativeRef: CHILD_A, state: 'stopped', endedAt: new Date(1792739197000).toISOString() })]);
    expect(result.complete).toBe(true);
  });
});

describe('stopping a native task found in history (R-13)', () => {
  const childTurnId = 'child-turn';
  const spawn = { ...activity('sa-1', 'started', CHILD_A, '/root/a') };
  const stopScript = (firstId: number): ReplayRecord[] => [
    out('thread/turns/list', firstId, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
    reply(firstId, page([wireTurn(childTurnId, 'inProgress')])),
    out('turn/interrupt', firstId + 1, { threadId: CHILD_A, turnId: childTurnId }),
    reply(firstId + 1, {}),
  ];

  it('stops the child read by readHistory after the parent was resumed', async () => {
    const h = await resumed([
      out('thread/items/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page([entry('turn-1', spawn)])),
      out('thread/turns/list', 4, { threadId: THREAD_ID, ...ITEMS }),
      reply(4, page([wireTurn('turn-1', 'completed')])),
      // the child's newest turn, read to find the task's state
      out('thread/turns/list', 5, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      reply(5, page([wireTurn(childTurnId, 'inProgress')])),
      ...stopScript(6),
    ]);
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks).toHaveLength(1);
    await h.adapter.stopNativeTask(THREAD_ID, result.nativeTasks[0]!.nativeRef);
    expect(h.fake.received.filter((m) => m.method === 'turn/interrupt')).toHaveLength(1);
    expect(h.fake.mismatches).toEqual([]);
  });

  it('finds the child in the parent stored activity when only the task ref is known (after a restart)', async () => {
    const h = await resumed([
      out('thread/items/list', 3, { threadId: THREAD_ID, ...ITEMS }),
      reply(3, page([entry('turn-1', spawn)])),
      out('thread/turns/list', 4, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
      reply(4, page([wireTurn(childTurnId, 'inProgress')])),
      ...stopScript(5),
    ]);
    await h.adapter.stopNativeTask(THREAD_ID, CHILD_A);
    expect(h.fake.received.filter((m) => m.method === 'turn/interrupt')).toHaveLength(1);
    expect(h.fake.mismatches).toEqual([]);
  });

  // Review r2 P1-2: what history shows is tracked like what was seen live (T003 rules).
  const childTurnEvent = (method: string, status: string, completedAt: number | null) =>
    notify(method, { threadId: CHILD_A, turn: wireTurn(childTurnId, status, 1792739194, completedAt) });
  const historyScript = (childStatus: string): ReplayRecord[] => [
    out('thread/items/list', 3, { threadId: THREAD_ID, ...ITEMS }),
    reply(3, page([entry('turn-1', spawn)])),
    out('thread/turns/list', 4, { threadId: THREAD_ID, ...ITEMS }),
    reply(4, page([wireTurn('turn-1', 'completed')])),
    out('thread/turns/list', 5, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
    reply(5, page([wireTurn(childTurnId, childStatus, 1792739194, childStatus === 'inProgress' ? null : 1792739195)])),
  ];

  it('reports the task stopped when its child turn ends interrupted after the history showed it running', async () => {
    const h = await resumed([
      ...historyScript('inProgress'),
      ...stopScript(6),
      childTurnEvent('turn/completed', 'interrupted', 1792739196),
    ]);
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks[0]).toMatchObject({ state: 'running' });
    await h.adapter.stopNativeTask(THREAD_ID, CHILD_A);
    await until(() => h.of('nativeTask.updated').length > 0, 'task update');
    expect(h.of('nativeTask.updated').map((e) => e.task.state)).toEqual(['stopped']);
    expect(h.of('nativeTask.updated')[0]!.task).toMatchObject({ nativeRef: CHILD_A, endedAt: new Date(1792739196000).toISOString() });
    expectValidEvents(h.events);
  });

  it('does not revive a task the history showed failed when the spawn call completes late', async () => {
    const h = await resumed([
      ...historyScript('failed'),
      // Played only after the history was read (each scripted request waits for the adapter), so the late report comes second.
      out('thread/loaded/list', 6),
      reply(6, page([])),
      notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1792739198000, item: spawn }),
      notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1792739199000, item: { ...spawn, id: 'sa-done', kind: 'completed' } }),
      out('thread/loaded/list', 7),
      reply(7, page([])),
      childTurnEvent('turn/started', 'inProgress', null),
    ]);
    const result = await h.adapter.readHistory(historyRequest());
    expect(result.nativeTasks[0]).toMatchObject({ state: 'failed' });
    await h.adapter.listLoadedThreads();
    // The late reports of the same spawn (started, then completed) change nothing ...
    await h.fake.idle();
    expect(h.of('nativeTask.updated')).toEqual([]);
    // ... only the child's own new turn makes it run again.
    await h.adapter.listLoadedThreads();
    await until(() => h.of('nativeTask.updated').length > 0, 'task update');
    expect(h.of('nativeTask.updated').map((e) => e.task.state)).toEqual(['running']);
    expect(h.of('nativeTask.updated')[0]!.task.endedAt).toBeUndefined();
    expect(h.fake.mismatches).toEqual([]);
  });

  // Review r3 P1-1/P1-2: what an earlier history read showed is not taken for live evidence.
  const spawnDone = { ...spawn, id: 'sa-done', kind: 'completed' };
  const readScript = (base: number, parentItems: unknown[], child: (id: number) => ReplayRecord): ReplayRecord[] => [
    out('thread/items/list', base, { threadId: THREAD_ID, ...ITEMS }),
    reply(base, page(parentItems)),
    out('thread/turns/list', base + 1, { threadId: THREAD_ID, ...ITEMS }),
    reply(base + 1, page([wireTurn('turn-1', 'completed')])),
    out('thread/turns/list', base + 2, { threadId: CHILD_A, limit: 1, sortDirection: 'desc' }),
    child(base + 2),
  ];
  const childNow = (status: string) => (id: number) =>
    reply(id, page([wireTurn(childTurnId, status, 1792739194, status === 'inProgress' ? null : 1792739195)]));

  it('reads the child again on every history read instead of trusting what an earlier read showed', async () => {
    const parentItems = [entry('turn-1', spawn), entry('turn-1', spawnDone, null, 1792739197000)];
    const h = await resumed([
      ...readScript(3, parentItems, childNow('inProgress')),
      ...readScript(6, parentItems, childNow('inProgress')),
      ...readScript(9, parentItems, childNow('failed')),
    ]);
    const first = await h.adapter.readHistory(historyRequest());
    expect(first.nativeTasks[0]).toMatchObject({ state: 'running' });
    expect(first.complete).toBe(false);
    // Nothing changed: still unconfirmed, not suddenly complete.
    const second = await h.adapter.readHistory(historyRequest());
    expect(second.nativeTasks[0]).toMatchObject({ state: 'running' });
    expect(second.complete).toBe(false);
    // The child's turn has since failed: the new read shows it.
    const third = await h.adapter.readHistory(historyRequest());
    expect(third.nativeTasks[0]).toMatchObject({ state: 'failed', endedAt: new Date(1792739195000).toISOString() });
    expect(third.complete).toBe(true);
    expect(h.fake.received.filter((m) => m.method === 'thread/turns/list' && (m.params as { threadId?: string }).threadId === CHILD_A)).toHaveLength(3);
    expect(h.fake.mismatches).toEqual([]);
  });

  it('reports a new child turn as running after a later history read replaced an unconfirmed running task with failed', async () => {
    const h = await resumed([
      ...readScript(3, [entry('turn-1', spawn)], (id) => replyError(id, -32600, 'child not stored')),
      ...readScript(6, [entry('turn-1', spawn)], childNow('failed')),
      out('thread/loaded/list', 9),
      reply(9, page([])),
      childTurnEvent('turn/started', 'inProgress', null),
    ]);
    const first = await h.adapter.readHistory(historyRequest());
    expect(first.nativeTasks[0]).toMatchObject({ state: 'running' });
    expect(first.complete).toBe(false);
    const second = await h.adapter.readHistory(historyRequest());
    expect(second.nativeTasks[0]).toMatchObject({ state: 'failed' });
    expect(h.of('nativeTask.updated')).toEqual([]);
    await h.adapter.listLoadedThreads();
    await until(() => h.of('nativeTask.updated').length > 0, 'task update');
    expect(h.of('nativeTask.updated').map((e) => e.task.state)).toEqual(['running']);
    expect(h.fake.mismatches).toEqual([]);
  });
});

describe('pending model while a turn/start is in flight', () => {
  const luna = { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' } as const;
  const sol = { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' } as const;
  const start = (n: number, t: string, model?: { model: string; effort: string }) =>
    out('turn/start', n + 2, { threadId: THREAD_ID, input: text(t), clientUserMessageId: attempt(n).clientMessageId, ...(model && { model: model.model, effort: model.effort }) });
  const ack = (id: number) => reply(id, recordedResult(sp01, 'turn/start'));

  it('keeps a model set while an explicit-model turn/start was waiting', async () => {
    const h = await resumed([start(1, 'one', luna), ack(3), start(2, 'two', sol), ack(4)]);
    const first = h.adapter.dispatchOnce(dispatch(1, { kind: 'new-turn', model: luna }, 'one'));
    await h.adapter.setModel(THREAD_ID, sol);
    expect(await first).toMatchObject({ state: 'sent' });
    expect(await h.adapter.dispatchOnce(dispatch(2, { kind: 'new-turn' }, 'two'))).toMatchObject({ state: 'sent' });
    expect(h.fake.mismatches).toEqual([]);
  });

  it('keeps a newer model when the turn/start that used the older pending one is answered', async () => {
    const h = await resumed([start(1, 'one', luna), ack(3), start(2, 'two', sol), ack(4), out('turn/start', 5, { threadId: THREAD_ID, input: text('three'), clientUserMessageId: attempt(3).clientMessageId }), ack(5)]);
    await h.adapter.setModel(THREAD_ID, luna);
    const first = h.adapter.dispatchOnce(dispatch(1, { kind: 'new-turn' }, 'one'));
    await h.adapter.setModel(THREAD_ID, sol);
    expect(await first).toMatchObject({ state: 'sent' });
    expect(await h.adapter.dispatchOnce(dispatch(2, { kind: 'new-turn' }, 'two'))).toMatchObject({ state: 'sent' });
    // Now it is spent: a third turn names nothing.
    expect(await h.adapter.dispatchOnce(dispatch(3, { kind: 'new-turn' }, 'three'))).toMatchObject({ state: 'sent' });
    expect(h.fake.mismatches).toEqual([]);
  });
});
