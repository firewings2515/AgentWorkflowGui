// T021 smoke run on the real machine: a Codex session's activity followed its turns only in the Claude
// adapter, and the model set for a turn was never reported (R-12). Scripted on the SP-01 handshake.
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId } from '../../contracts';
import type { DispatchRequest } from '../../core/ports';
import { loadFixture, notify, out, recordedResult, reply, type ReplayRecord } from './testing/fake-app-server';
import { expectValidEvents, SESSION, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const TURN_ID = '01a16795-3172-7802-a04e-3b9e5974a6f9';
const AT = '2026-10-24T12:00:00.000Z';

const wireTurn = (status: string) => ({ id: TURN_ID, items: [], status, error: null, startedAt: 1792739193, completedAt: status === 'inProgress' ? null : 1792739196 });
const turnStarted = notify('turn/started', { threadId: THREAD_ID, turn: wireTurn('inProgress') });
const turnCompleted = (status: string) => notify('turn/completed', { threadId: THREAD_ID, turn: wireTurn(status) });
const attempt: DispatchRequest['attempt'] = {
  state: 'unknown',
  attemptId: AttemptId.parse('attempt-1'),
  clientMessageId: ClientMessageId.parse('9a7c1e52-0d3b-4f6e-8a21-000000000001'),
  dispatchStartedAt: AT,
};

const resumed = async (records: ReplayRecord[]) => {
  const h = setup([out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized'), out('thread/resume', 2), reply(2, recordedResult(sp01, 'thread/start')), ...records]);
  await h.adapter.start();
  await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
  return h;
};

describe('T021 Codex session activity follows its turns', () => {
  it('T021 a turn that starts makes the session running, and one that completes makes it idle', async () => {
    const h = await resumed([turnStarted, turnCompleted('completed')]);
    await until(() => h.fake.finished && h.of('session.activity').length === 2, 'activity');
    expect(h.of('session.activity')).toEqual([
      { type: 'session.activity', sessionId: SESSION, activity: 'running', at: AT },
      { type: 'session.activity', sessionId: SESSION, activity: 'idle', at: expect.any(String) as unknown },
    ]);
    expectValidEvents(h.events);
  });

  it('T021 an interrupted turn leaves the session interrupted', async () => {
    const h = await resumed([turnStarted, turnCompleted('interrupted')]);
    await until(() => h.fake.finished && h.of('session.activity').length === 2, 'activity');
    expect(h.of('session.activity').map((e) => e.activity)).toEqual(['running', 'interrupted']);
  });
});

describe('T021 R-12: the model a turn was started with is the configured one from then on', () => {
  it('T021 a turn started with a new model reports it as configured, never as the model it used', async () => {
    const h = await resumed([
      out('turn/start', 3, { threadId: THREAD_ID, input: [{ type: 'text', text: 'go', text_elements: [] }], clientUserMessageId: attempt.clientMessageId, model: 'gpt-5.6-luna', effort: 'low' }),
      reply(3, recordedResult(sp01, 'turn/start')),
      turnStarted,
    ]);
    await h.adapter.dispatchOnce({ nativeSessionRef: THREAD_ID, attempt, text: 'go', entry: { kind: 'new-turn', model: { runtime: 'codex', model: 'gpt-5.6-luna', effort: 'low' } } });
    await until(() => h.fake.finished && h.of('model.observed').length === 1, 'model');
    expect(h.of('model.observed')).toEqual([{ type: 'model.observed', sessionId: SESSION, observed: { source: 'configured', model: 'gpt-5.6-luna', observedAt: AT }, at: AT }]);
    expectValidEvents(h.events);
  });

  it('T021 a turn started without a model change reports no model', async () => {
    const h = await resumed([turnStarted]);
    await until(() => h.fake.finished && h.of('session.activity').length === 1, 'activity');
    expect(h.of('model.observed')).toEqual([]);
  });
});

describe('t021-r1-P1-3 the configured model is reported whichever comes first, the turn/start response or turn/started', () => {
  const startWithModel = out('turn/start', 3, { threadId: THREAD_ID, input: [{ type: 'text', text: 'go', text_elements: [] }], clientUserMessageId: attempt.clientMessageId, model: 'gpt-5.6-luna', effort: 'low' });
  const go = { nativeSessionRef: THREAD_ID, attempt, text: 'go', entry: { kind: 'new-turn' as const, model: { runtime: 'codex' as const, model: 'gpt-5.6-luna', effort: 'low' } } };
  const expected = [{ type: 'model.observed', sessionId: SESSION, observed: { source: 'configured', model: 'gpt-5.6-luna', observedAt: AT }, at: AT }];

  it('t021-r1-P1-3 the response first, turn/started only after dispatchOnce returned: reported once', async () => {
    const h = await resumed([startWithModel, reply(3, recordedResult(sp01, 'turn/start'))]);
    await h.adapter.dispatchOnce(go);
    expect(h.of('model.observed')).toEqual([]);
    // The notification arrives later, on its own.
    h.fake.stdout.write(`${JSON.stringify(turnStarted.data)}\n`);
    await until(() => h.of('session.activity').length === 1, 'turn/started');
    expect(h.of('model.observed')).toEqual(expected);
    expect(h.of('turn.updated')[0]?.turn.requestedModel).toMatchObject({ model: 'gpt-5.6-luna' });
    expectValidEvents(h.events);
  });

  it('t021-r1-P1-3 turn/started first, then the response: reported once', async () => {
    const h = await resumed([startWithModel, turnStarted, reply(3, recordedResult(sp01, 'turn/start'))]);
    await h.adapter.dispatchOnce(go);
    await until(() => h.fake.finished && h.of('session.activity').length === 1, 'turn/started');
    expect(h.of('model.observed')).toEqual(expected);
  });

  it('t021-r1-P1-3 a repeated turn/started of the same turn does not report it again', async () => {
    const h = await resumed([startWithModel, reply(3, recordedResult(sp01, 'turn/start')), turnStarted, turnStarted]);
    await h.adapter.dispatchOnce(go);
    await until(() => h.fake.finished && h.of('session.activity').length === 2, 'both notifications');
    expect(h.of('model.observed')).toEqual(expected);
  });
});
