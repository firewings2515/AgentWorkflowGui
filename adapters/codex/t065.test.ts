// T065 on the Codex adapter: the GUI's own notice (origin `system`, C-31) goes out in its envelope and is shown as a
// `system` message, live and when read back; contracts allow only `system` with that origin (message.origin-role), so
// as a `user` message it could not be stored.
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, Message, type MessageOrigin } from '../../contracts';
import type { DispatchRequest } from '../../core/ports';
import { envelope } from './origin';
import { loadFixture, notify, out, recordedResult, reply, type ReplayRecord } from './testing/fake-app-server';
import { SESSION, expectValidEvents, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const CLIENT_ID = ClientMessageId.parse('9a7c1e52-0d3b-4f6e-8a21-000000000065');
const SYSTEM: MessageOrigin = { kind: 'system' };
const NOTICE = 'the tasks of your list were created';

const init = (): ReplayRecord[] => [out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized')];
const request = (): DispatchRequest => ({
  nativeSessionRef: THREAD_ID,
  attempt: { state: 'unknown', attemptId: AttemptId.parse('attempt-65'), clientMessageId: CLIENT_ID, dispatchStartedAt: '2026-10-24T12:00:00.000Z' },
  text: NOTICE,
  entry: { kind: 'new-turn' },
  origin: SYSTEM,
});
const userItem = (clientId: string | null, text: string) => ({ type: 'userMessage', id: 'u-65', clientId, content: [{ type: 'text', text, text_elements: [] }] });

describe('T065: a notice from the GUI on Codex is a system message', () => {
  it('live: the completed item becomes a system message with origin system, valid by the contracts', async () => {
    const wrapped = envelope(NOTICE, SYSTEM);
    const h = setup([
      ...init(),
      out('thread/resume', 2),
      reply(2, recordedResult(sp01, 'thread/start')),
      out('turn/start', 3, { threadId: THREAD_ID, input: [{ type: 'text', text: wrapped, text_elements: [] }], clientUserMessageId: CLIENT_ID }),
      reply(3, recordedResult(sp01, 'turn/start')),
      notify('item/completed', { threadId: THREAD_ID, turnId: 'turn-x', completedAtMs: 1792739196000, item: userItem(CLIENT_ID, wrapped) }),
    ]);
    await h.adapter.start();
    await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
    expect(await h.adapter.dispatchOnce(request())).toMatchObject({ state: 'sent' });
    await until(() => h.of('message.completed').length > 0, 'the notice');
    const message = h.of('message.completed')[0]?.message;
    expect(message).toMatchObject({ role: 'system', origin: SYSTEM, text: NOTICE });
    expect(Message.safeParse(message).success).toBe(true);
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});
