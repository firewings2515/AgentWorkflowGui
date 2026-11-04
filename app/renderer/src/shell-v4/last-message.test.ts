// T054 (U3 Q-17): which messages set a session's last-message time, a run's time, and the times keeping their identity
// through message.delta.
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../../contracts';
import { byLastMessage, lastMessageTimes, lastReplyTimes, messageTimesOf, runLastMessageAt } from './last-message';

const message = (id: string, sessionId: string, createdAt: string, extra: Partial<Message> = {}) =>
  ({ id, sessionId, role: 'assistant', origin: { kind: 'agent' }, text: id, attachments: [], createdAt, ...extra }) as Message;
const session = (id: string, createdAt = '2026-11-04T00:00:00.000Z') => ({ id, createdAt });

describe('T054 last-message time (Q-17)', () => {
  it('counts user (also peer, handoff, transfer) and assistant messages of the main conversation, compared as instants', () => {
    const times = lastMessageTimes({ messages: [
      message('m1', 'a', '2026-11-04T10:30:00+08:00', { role: 'user', origin: { kind: 'user' } }),
      message('m2', 'a', '2026-11-04T02:00:00.000Z'),
      message('m3', 'b', '2026-11-04T03:00:00.000Z', { role: 'user', origin: { kind: 'peer', fromSessionId: 'a', peerMessageId: 'pm' } } as Partial<Message>),
    ] });
    expect(times.get('a')).toBe(Date.parse('2026-11-04T02:30:00.000Z'));
    expect(times.get('b')).toBe(Date.parse('2026-11-04T03:00:00.000Z'));
  });

  it('system notes and a sub-agent\'s messages (nativeTaskId) do not change the time or the order', () => {
    const base = [message('m1', 'a', '2026-11-04T01:00:00.000Z'), message('m2', 'b', '2026-11-04T02:00:00.000Z')];
    const extra = [
      message('m3', 'a', '2026-11-04T05:00:00.000Z', { role: 'system', origin: { kind: 'system' } }),
      message('m4', 'a', '2026-11-04T06:00:00.000Z', { nativeTaskId: 'nt-1' } as Partial<Message>),
    ];
    const order = (messages: Message[]) => [session('a'), session('b')].sort(byLastMessage(lastMessageTimes({ messages }))).map(item => item.id);
    expect(order(base)).toEqual(['b', 'a']);
    expect(order([...base, ...extra])).toEqual(['b', 'a']);
    expect(lastMessageTimes({ messages: [...base, ...extra] }).get('a')).toBe(Date.parse('2026-11-04T01:00:00.000Z'));
  });

  it('a session with no counted message falls back to its createdAt', () => {
    const times = lastMessageTimes({ messages: [message('m1', 'a', '2026-11-04T05:00:00.000Z', { role: 'system', origin: { kind: 'system' } })] });
    const sorted = [session('a', '2026-11-04T01:00:00.000Z'), session('b', '2026-11-04T02:00:00+08:00')].sort(byLastMessage(times));
    expect(sorted.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('replies are the assistant\'s messages only, without sub-agent ones (Q-14)', () => {
    const replies = lastReplyTimes({ messages: [
      message('m1', 'a', '2026-11-04T01:00:00.000Z'),
      message('m2', 'a', '2026-11-04T02:00:00.000Z', { role: 'user', origin: { kind: 'user' } }),
      message('m3', 'a', '2026-11-04T03:00:00.000Z', { nativeTaskId: 'nt-1' } as Partial<Message>),
      message('m4', 'b', '2026-11-04T03:00:00.000Z', { role: 'user', origin: { kind: 'user' } }),
    ] });
    expect(replies.get('a')).toBe(Date.parse('2026-11-04T01:00:00.000Z'));
    expect(replies.has('b')).toBe(false);
  });

  it('a run takes the newest of its node sessions, else the nodes\' or the run\'s createdAt', () => {
    const times = lastMessageTimes({ messages: [message('m1', 'n1', '2026-11-04T09:00:00+08:00'), message('m2', 'n2', '2026-11-04T02:00:00.000Z')] });
    const run = { createdAt: '2026-11-04T00:00:00.000Z' };
    expect(runLastMessageAt(times, run, [session('n1'), session('n2')])).toBe(Date.parse('2026-11-04T02:00:00.000Z'));
    expect(runLastMessageAt(times, run, [session('n3', '2026-11-04T04:00:00.000Z')])).toBe(Date.parse('2026-11-04T04:00:00.000Z'));
    expect(runLastMessageAt(times, run, [])).toBe(Date.parse(run.createdAt));
  });
});

describe('T054 times keep their identity through message.delta', () => {
  const messages = [message('m1', 'a', '2026-11-04T01:00:00.000Z'), message('m2', 'b', '2026-11-04T02:00:00.000Z')];

  it('a delta (a new array, one message with longer text) returns the same object', () => {
    const first = messageTimesOf(messages);
    const delta = messages.map(item => item.id === 'm2' ? { ...item, text: `${item.text} more` } : item);
    expect(messageTimesOf(delta)).toBe(first);
    expect(messageTimesOf(structuredClone(delta))).toBe(first);
  });

  it('a new message, a replaced createdAt or role, or a removed message works the times out again', () => {
    const first = messageTimesOf(messages);
    const added = messageTimesOf([...messages, message('m3', 'a', '2026-11-04T05:00:00.000Z')]);
    expect(added).not.toBe(first);
    expect(added.last.get('a')).toBe(Date.parse('2026-11-04T05:00:00.000Z'));
    const moved = messageTimesOf(messages.map(item => item.id === 'm1' ? { ...item, createdAt: '2026-11-04T06:00:00.000Z' } : item));
    expect(moved.last.get('a')).toBe(Date.parse('2026-11-04T06:00:00.000Z'));
    const asUser = messageTimesOf(messages.map(item => item.id === 'm1' ? { ...item, role: 'user' as const, origin: { kind: 'user' as const } } : item));
    expect(asUser.replies.has('a')).toBe(false);
    expect(messageTimesOf(messages.slice(1)).last.has('a')).toBe(false);
  });
});
