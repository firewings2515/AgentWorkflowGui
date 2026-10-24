// CR-2: send once, never retry, report unknown unless the runtime accepted this exact request, and
// reconcile only by reading the stored history. Scripts reuse the SP-01 recording for the handshake.
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, DispatchAttempt } from '../../contracts';
import type { DispatchRequest } from './adapter';
import { RpcClosedError } from './rpc';
import { loadFixture, out, recordedResult, reply, replyError, type ReplayRecord, serverRequest } from './testing/fake-app-server';
import { SESSION, sentParams, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const RECORDED_TURN = '01a16795-3172-7802-a04e-3b9e5974a6f9';

const handshake = (): ReplayRecord[] => [
  out('initialize', 1),
  reply(1, recordedResult(sp01, 'initialize')),
  out('initialized'),
  out('thread/resume', 2),
  reply(2, recordedResult(sp01, 'thread/start')),
];

const attempt = (n = 1): DispatchRequest['attempt'] => ({
  state: 'unknown',
  attemptId: AttemptId.parse(`attempt-${n}`),
  clientMessageId: ClientMessageId.parse(`9a7c1e52-0d3b-4f6e-8a21-${String(n).padStart(12, '0')}`),
  dispatchStartedAt: '2026-10-24T12:00:00.000Z',
});

const dispatch = (n = 1, extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  threadId: THREAD_ID,
  attempt: attempt(n),
  text: 'Handoff payload',
  entry: { kind: 'new-turn', model: 'gpt-6-luna', effort: 'low' },
  ...extra,
});

const started = async (records: ReplayRecord[]) => {
  const h = setup(records);
  await h.adapter.start();
  await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
  return h;
};

describe('dispatchOnce', () => {
  it('reports sent with a live ack for the turn/start response, and refuses to send the same attempt again', async () => {
    const h = await started([...handshake(), out('turn/start', 3), reply(3, recordedResult(sp01, 'turn/start'))]);
    const result = await h.adapter.dispatchOnce(dispatch());
    expect(result).toEqual({
      state: 'sent',
      nativeRef: { sessionRef: THREAD_ID, turnRef: RECORDED_TURN },
      evidence: { kind: 'live-ack', at: '2026-10-24T12:00:00.000Z', detail: expect.stringContaining(RECORDED_TURN) as unknown },
    });
    expect(sentParams(h.fake, 'turn/start')).toMatchObject({
      threadId: THREAD_ID,
      clientUserMessageId: attempt().clientMessageId,
      input: [{ type: 'text', text: 'Handoff payload', text_elements: [] }],
      model: 'gpt-6-luna',
      effort: 'low',
    });
    // The record the dispatcher stores next must satisfy the contract.
    if (result.state !== 'sent') throw new Error('expected sent');
    DispatchAttempt.parse({ ...attempt(), state: 'sent', nativeRef: result.nativeRef, evidence: result.evidence });

    const again = await h.adapter.dispatchOnce(dispatch());
    expect(again).toMatchObject({ state: 'unknown', reason: 'already-dispatched', written: false });
    const sameClientId = await h.adapter.dispatchOnce({ ...dispatch(), attempt: { ...attempt(), attemptId: AttemptId.parse('attempt-x') } });
    expect(sameClientId).toMatchObject({ state: 'unknown', reason: 'already-dispatched' });
    expect(h.fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(h.fake.mismatches).toEqual([]);
  });

  it('reports unknown on timeout and does not retry', async () => {
    const h = await started([...handshake(), out('turn/start', 3)]);
    const result = await h.adapter.dispatchOnce(dispatch(1, { timeoutMs: 20 }));
    expect(result).toMatchObject({ state: 'unknown', reason: 'timeout', written: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
  });

  it('reports unknown when the runtime rejects the request (an error is not proof of non-delivery)', async () => {
    const h = await started([...handshake(), out('turn/steer', 3), replyError(3, -32600, 'expectedTurnId does not match the active turn')]);
    const result = await h.adapter.dispatchOnce(dispatch(1, { entry: { kind: 'insert', expectedTurnId: 'turn-gone' } }));
    expect(result).toMatchObject({ state: 'unknown', reason: 'rejected', written: true, detail: expect.stringContaining('expectedTurnId') as unknown });
  });

  it('fails every in-flight request and withdraws open approvals when the app-server dies', async () => {
    const approval = serverRequest(0, 'item/commandExecution/requestApproval', {
      threadId: THREAD_ID,
      turnId: RECORDED_TURN,
      itemId: 'exec-1',
      startedAtMs: 1792739195000,
      command: 'git status',
      cwd: 'E:\\work\\task',
    });
    const h = await started([...handshake(), approval, out('turn/steer', 3), out('thread/read', 4)]);
    await until(() => h.permissions.length === 1, 'approval');
    const pendingDispatch = h.adapter.dispatchOnce(dispatch(1, { entry: { kind: 'insert', expectedTurnId: RECORDED_TURN } }));
    const pendingRead = h.adapter.readThread(THREAD_ID).catch((e: unknown) => e);
    await h.fake.idle();
    h.fake.crash(3);

    expect(await pendingDispatch).toMatchObject({ state: 'unknown', reason: 'disconnected', written: true });
    expect(await pendingRead).toBeInstanceOf(RpcClosedError);
    expect(h.of('permission.updated').at(-1)!.request.state).toBe('withdrawn');
    expect(h.permissions[0]!.answer({ outcome: 'approve', decidedBy: 'policy', at: '2026-10-24T12:00:00.000Z' })).toBe(false);
    expect(h.of('runtime.exited')).toEqual([expect.objectContaining({ expected: false, code: 3 })]);
    expect(h.adapter.running).toBe(false);

    // Afterwards nothing is written; the payload never leaves the GUI.
    expect(await h.adapter.dispatchOnce(dispatch(2))).toMatchObject({ state: 'unknown', reason: 'not-running', written: false });
  });

  it('only accepts the live attempt committed as unknown', async () => {
    const h = await started(handshake());
    const abandoned = { ...attempt(), resolution: { decision: 'retry' as const, decidedBy: 'user' as const, at: '2026-10-24T12:00:00.000Z' } };
    await expect(h.adapter.dispatchOnce({ ...dispatch(), attempt: abandoned })).rejects.toThrow(/committed as unknown/);
    expect(h.fake.received.some((m) => m.method === 'turn/start')).toBe(false);
  });
});

// ---- reconcile ------------------------------------------------------------------------------------

const userItem = (id: string, clientId: string | null, text: string) => ({
  type: 'userMessage',
  id,
  clientId,
  content: [{ type: 'text', text, text_elements: [] }],
});
const entry = (turnId: string, item: unknown) => ({ turnId, item, startedAtMs: 1792739195018, completedAtMs: 1792739195018 });
const agentItem = { type: 'agentMessage', id: 'msg_1', text: 'ACK', phase: 'final_answer' };

const CLIENT_ID = '9a7c1e52-0d3b-4f6e-8a21-000000000001';
const init = (): ReplayRecord[] => [out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized')];
const reconcileWith = async (records: ReplayRecord[], text = 'Handoff payload') => {
  const h = setup([...init(), ...records]);
  await h.adapter.start();
  const result = await h.adapter.reconcile({ threadId: THREAD_ID, clientMessageId: CLIENT_ID, text });
  // Reconciliation is read-only: no resume, no turn.
  expect(h.fake.received.every((m) => ['initialize', 'initialized', 'thread/items/list', 'thread/read'].includes(m.method as string))).toBe(true);
  expect(h.fake.mismatches).toEqual([]);
  return { h, result };
};

describe('reconcile', () => {
  it('pages the whole history and reports sent for exactly one stored message with the same clientId and text', async () => {
    const { h, result } = await reconcileWith([
      out('thread/items/list', 2),
      reply(2, { data: [entry('turn-1', userItem('u-0', null, 'earlier')), entry('turn-1', agentItem)], nextCursor: 'c1', backwardsCursor: null }),
      out('thread/items/list', 3),
      reply(3, { data: [entry('turn-2', userItem('u-1', CLIENT_ID, 'Handoff payload'))], nextCursor: null, backwardsCursor: null }),
    ]);
    expect(result).toEqual({
      state: 'sent',
      nativeRef: { sessionRef: THREAD_ID, turnRef: 'turn-2', itemRef: 'u-1' },
      evidence: { kind: 'reconciled', at: '2026-10-24T12:00:00.000Z', detail: expect.stringContaining(CLIENT_ID) as unknown },
    });
    expect(sentParams(h.fake, 'thread/items/list', 1)).toMatchObject({ threadId: THREAD_ID, cursor: 'c1', sortDirection: 'asc' });
  });

  it('keeps unknown when nothing matches after reading every page', async () => {
    const { result } = await reconcileWith([
      out('thread/items/list', 2),
      reply(2, { data: [entry('turn-1', userItem('u-0', null, 'Handoff payload'))], nextCursor: 'c1', backwardsCursor: null }),
      out('thread/items/list', 3),
      reply(3, { data: [], nextCursor: null, backwardsCursor: null }),
    ]);
    expect(result).toMatchObject({ state: 'unknown', reason: 'not-found', matches: [] });
  });

  it('treats two stored messages with the same clientId as a suspected duplicate', async () => {
    const { result } = await reconcileWith([
      out('thread/items/list', 2),
      reply(2, {
        data: [entry('turn-1', userItem('u-1', CLIENT_ID, 'Handoff payload')), entry('turn-2', userItem('u-2', CLIENT_ID, 'Handoff payload'))],
        nextCursor: null,
        backwardsCursor: null,
      }),
    ]);
    expect(result).toMatchObject({ state: 'unknown', reason: 'duplicate', matches: [{ itemId: 'u-1' }, { itemId: 'u-2' }] });
  });

  it('does not accept a clientId match whose content differs', async () => {
    const { result } = await reconcileWith([
      out('thread/items/list', 2),
      reply(2, { data: [entry('turn-1', userItem('u-1', CLIENT_ID, 'Something else'))], nextCursor: null, backwardsCursor: null }),
    ]);
    expect(result).toMatchObject({ state: 'unknown', reason: 'content-mismatch', matches: [{ contentMatches: false }] });
  });

  it('falls back to thread/read with full turns when thread/items/list fails (the CR-2 proof path)', async () => {
    // Shape of the stored history read back in spike/review-followup/cr2-native-proof (Codex 0.160.0).
    const proofText = 'Receipt fixture de7e0897-b8ac-4891-a4c3-d9566db60d73. Reply only ACK. Do not call tools.';
    const h = setup([
      ...init(),
      out('thread/items/list', 2),
      replyError(2, -32600, 'thread not loaded'),
      out('thread/read', 3),
      reply(3, {
        thread: {
          ...(recordedResult(sp01, 'thread/start') as { thread: object }).thread,
          id: '01a16874-c8e2-71d0-964c-4ef1fe708cdc',
          turns: [
            {
              id: '01a16874-cc7f-7a90-952a-b9f32f705d54',
              items: [userItem('01a16874-d206-7011-a24f-0ec6ef158c89', 'de7e0897-b8ac-4891-a4c3-d9566db60d73', proofText), agentItem],
              status: 'completed',
              error: null,
              startedAt: 1792753847,
              completedAt: 1792753850,
            },
          ],
        },
      }),
    ]);
    await h.adapter.start();
    const result = await h.adapter.reconcile({ threadId: '01a16874-c8e2-71d0-964c-4ef1fe708cdc', clientMessageId: 'de7e0897-b8ac-4891-a4c3-d9566db60d73', text: proofText });
    expect(result).toMatchObject({ state: 'sent', nativeRef: { turnRef: '01a16874-cc7f-7a90-952a-b9f32f705d54', itemRef: '01a16874-d206-7011-a24f-0ec6ef158c89' } });
    expect(sentParams(h.fake, 'thread/read')).toEqual({ threadId: '01a16874-c8e2-71d0-964c-4ef1fe708cdc', includeTurns: true });
  });

  it('keeps unknown when the history cannot be read', async () => {
    const { result } = await reconcileWith([out('thread/items/list', 2), replyError(2, -32600, 'no rollout'), out('thread/read', 3), replyError(3, -32600, 'no rollout')]);
    expect(result).toMatchObject({ state: 'unknown', reason: 'read-failed' });
  });
});
