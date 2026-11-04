// T054 (U3 Q-14): the seen record at start-up, moving it up, and which sessions are unread.
import { describe, expect, it } from 'vitest';
import { initialSeen, markSeen, unreadOf } from './seen';

const at = (time: string) => Date.parse(time);
const replies = new Map([['a', at('2026-11-04T02:00:00.000Z')], ['b', at('2026-11-04T10:00:00+08:00')]]);
const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('T054 seen record at start-up', () => {
  it.each([
    ['nothing stored (first start)', { ok: false } as const],
    ['not an object', { ok: true, value: 'x' } as const],
    ['an array', { ok: true, value: ['a'] } as const],
    ['null', { ok: true, value: null } as const],
  ])('%s: every session is seen up to its newest reply, so nothing lights up', (_, stored) => {
    const seen = initialSeen(stored, sessions, replies);
    expect(seen).toEqual({ a: '2026-11-04T02:00:00.000Z', b: '2026-11-04T02:00:00.000Z' });
    expect(unreadOf(replies, seen, []).size).toBe(0);
  });

  it('drops sessions that are gone, keeps valid times, takes the baseline for an entry that is not a time', () => {
    const seen = initialSeen({ ok: true, value: { a: '2026-11-04T01:00:00.000Z', b: 42, gone: '2026-11-04T01:00:00.000Z' } }, sessions, replies);
    expect(seen).toEqual({ a: '2026-11-04T01:00:00.000Z', b: '2026-11-04T02:00:00.000Z' });
    expect([...unreadOf(replies, seen, [])]).toEqual(['a']);
  });

  it('a session the record does not name appeared since: its replies are new', () => {
    const seen = initialSeen({ ok: true, value: { a: '2026-11-04T05:00:00.000Z' } }, sessions, replies);
    expect([...unreadOf(replies, seen, [])]).toEqual(['b']);
  });
});

describe('T054 unread and seen', () => {
  it('a reply newer than the seen time is unread, except in a visible session; mixed offsets compare as instants', () => {
    const seen = { a: '2026-11-04T09:59:00+08:00', b: '2026-11-04T02:00:00.000Z' };
    expect([...unreadOf(replies, seen, [])]).toEqual(['a']);
    expect(unreadOf(replies, seen, ['a']).size).toBe(0);
  });

  it('a session without replies (only the user\'s own messages) is never unread', () => {
    expect(unreadOf(new Map(), {}, []).size).toBe(0);
  });

  it('markSeen moves visible sessions up to their newest reply, and returns the same object when nothing changes', () => {
    const seen = { a: '2026-11-04T01:00:00.000Z' };
    const next = markSeen(seen, replies, ['a', 'b', 'c']);
    expect(next).toEqual({ a: '2026-11-04T02:00:00.000Z', b: '2026-11-04T02:00:00.000Z' });
    expect(markSeen(next, replies, ['a', 'b'])).toBe(next);
    expect(markSeen(seen, replies, [])).toBe(seen);
    // Never moves back: an older reply (after a reload) leaves a newer seen time alone.
    expect(markSeen({ a: '2026-11-04T09:00:00.000Z' }, replies, ['a'])).toEqual({ a: '2026-11-04T09:00:00.000Z' });
  });
});
