// T065: the GUI's own notice to a session (origin `system`, C-31) is a `system` message, live and in the stored history:
// contracts allow only `system` with that origin (message.origin-role), so as a `user` message it could not be stored
// (trial D: "recording message.completed ... failed (InvalidRecordError)", every notice missing from root's conversation).
import { describe, expect, it } from 'vitest';
import { AppEvent, Message, SessionId } from '../../contracts';
import type { DispatchRequest } from '../../core/ports';
import { attempt, echo, expectValidEvents, promptLine, REF, replyLine, setup, started, transcript, u, until } from './testing/harness';

const NOTICE = 'Notice from the GUI (not a message from the user): the tasks of your list were created.';
const request = (extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  nativeSessionRef: REF,
  attempt: attempt(),
  text: NOTICE,
  entry: { kind: 'new-turn' },
  timeoutMs: 1000,
  origin: { kind: 'system' },
  ...extra,
});

describe('T065: a notice from the GUI is a system message', () => {
  it('acked live: message.completed has role system, origin system, and passes the contracts', async () => {
    const h = await started();
    const q = h.sdk.last;
    const req = request();
    const sending = h.adapter.dispatchOnce(req);
    await until(() => q.inputs.length === 1, 'input written');
    q.emit(echo(req.attempt.clientMessageId));
    expect(await sending).toMatchObject({ state: 'sent' });
    const [completed] = h.of('message.completed');
    expect(completed?.message).toMatchObject({ id: req.attempt.clientMessageId, role: 'system', origin: { kind: 'system' }, text: NOTICE });
    expect(Message.safeParse(completed?.message).success).toBe(true);
    expectValidEvents(h.events);
  });

  it('a peer payload stays a user message (only the GUI\'s own words change role)', async () => {
    const h = await started();
    const q = h.sdk.last;
    const req = request({ origin: { kind: 'peer', fromSessionId: SessionId.parse('session-b'), peerMessageId: 'peer-1' as never } });
    const sending = h.adapter.dispatchOnce(req);
    await until(() => q.inputs.length === 1, 'input written');
    q.emit(echo(req.attempt.clientMessageId));
    await sending;
    expect(h.of('message.completed')[0]?.message).toMatchObject({ role: 'user', origin: { kind: 'peer' } });
    expectValidEvents(h.events);
  });

  it('read back from the stored history: the notice is a system message there too', async () => {
    const DIR = 'D:\\demo\\t065';
    const ref = '33333333-3333-4333-8333-333333333333';
    const h = setup({ userOrigin: ({ clientMessageId }) => (clientMessageId === u(2) ? { kind: 'system' } : { kind: 'user' }) });
    h.sdk.store(DIR, ref, transcript(ref, DIR, [promptLine(u(1), 'hello'), replyLine(u(10), { type: 'text', text: 'hi' }), promptLine(u(2), NOTICE), replyLine(u(11), { type: 'text', text: 'noted' })]));
    const history = await h.adapter.readHistory({ sessionId: SessionId.parse('session-t065'), nativeSessionRef: ref, cwd: DIR });
    const messages = history.entries.flatMap((e) => (e.kind === 'message' ? [e.message] : []));
    expect(messages.map((m) => [m.role, m.origin.kind])).toEqual([
      ['user', 'user'],
      ['assistant', 'agent'],
      ['system', 'system'],
      ['assistant', 'agent'],
    ]);
    for (const message of messages) expect(AppEvent.safeParse({ type: 'message.completed', message }).success).toBe(true);
  });
});
