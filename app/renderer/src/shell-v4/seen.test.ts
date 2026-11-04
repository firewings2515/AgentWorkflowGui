// T054 (U3 Q-14): the seen record at start-up, moving it up, and which sessions are unread.
import { describe, expect, it } from 'vitest';
import { baselineSeen, initialSeen, markSeen, serializeSeen, unreadOf } from './seen';
import type { SeenRecord } from './seen';

const at = (time: string) => Date.parse(time);
const replies = new Map([['a', at('2026-11-04T02:00:00.000Z')], ['b', at('2026-11-04T10:00:00+08:00')]]);
const last = new Map([['a', at('2026-11-04T02:00:00.000Z')], ['c', at('2026-11-04T03:00:00.000Z')]]);
const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const none = { ok: false } as const;
const v2 = (value: unknown) => ({ ok: true as const, value });
const record = (since: string | null, seen: Record<string, string>): SeenRecord => ({ since, seen });

describe('T054 seen record at start-up', () => {
  it.each([
    ['nothing stored (first start)', none],
    ['not an object', v2('x')],
    ['an array', v2(['a'])],
    ['null', v2(null)],
    ['another version', v2({ version: 3, since: null, seen: {} })],
    ['seen is not a map', v2({ version: 2, since: null, seen: [] })],
    ['since is not a time', v2({ version: 2, since: 'yesterday', seen: {} })],
  ])('%s: every session is seen up to its newest reply, so nothing lights up', (_, stored) => {
    const seen = initialSeen(stored, none, sessions, replies, last);
    expect(seen).toEqual({ since: '2026-11-04T03:00:00.000Z', seen: { a: '2026-11-04T02:00:00.000Z', b: '2026-11-04T02:00:00.000Z' } });
    expect(unreadOf(replies, seen, []).size).toBe(0);
  });

  it('a v2 record: drops sessions that are gone, keeps valid times, takes the baseline for an entry that is not a time', () => {
    const seen = initialSeen(v2({ version: 2, since: '2026-11-04T00:00:00.000Z', seen: { a: '2026-11-04T01:00:00.000Z', b: 42, gone: '2026-11-04T01:00:00.000Z' } }), none, sessions, replies, last);
    expect(seen).toEqual({ since: '2026-11-04T00:00:00.000Z', seen: { a: '2026-11-04T01:00:00.000Z', b: '2026-11-04T02:00:00.000Z' } });
    expect([...unreadOf(replies, seen, [])]).toEqual(['a']);
  });

  it('no v2 record: a v1 map is read, with since the newest time in it; a malformed v2 record does not fall back to v1', () => {
    const legacy = v2({ a: '2026-11-04T01:00:00.000Z', gone: '2026-11-04T01:30:00.000Z' });
    expect(initialSeen(none, legacy, sessions, replies, last)).toEqual({ since: '2026-11-04T01:30:00.000Z', seen: { a: '2026-11-04T01:00:00.000Z' } });
    expect(initialSeen(v2('bad'), legacy, sessions, replies, last).seen).toEqual(baselineSeen(sessions, replies, last).seen);
  });

  it('a session the record does not name is unread only for a reply newer than since', () => {
    expect([...unreadOf(replies, record('2026-11-04T01:00:00.000Z', {}), [])]).toEqual(['a', 'b']);
    expect([...unreadOf(replies, record('2026-11-04T02:00:00.000Z', {}), [])]).toEqual([]);
    expect([...unreadOf(replies, record(null, {}), [])]).toEqual(['a', 'b']);
  });

  it('r1 P2-2: an older history page with an assistant reply does not light up a session the baseline had no reply for', () => {
    // First start: the latest page of `x` has only the user's message; `y` replied last.
    const firstLast = new Map([['x', at('2026-11-04T05:00:00.000Z')], ['y', at('2026-11-04T06:00:00.000Z')]]);
    const firstReplies = new Map([['y', at('2026-11-04T06:00:00.000Z')]]);
    const seen = baselineSeen([{ id: 'x' }, { id: 'y' }], firstReplies, firstLast);
    expect(seen.seen).toEqual({ y: '2026-11-04T06:00:00.000Z' });
    // The user opens `x`, asks for history and leaves before it arrives: the older page brings a 04:00 reply.
    const withHistory = new Map([...firstReplies, ['x', at('2026-11-04T04:00:00.000Z')]]);
    expect(unreadOf(withHistory, seen, []).size).toBe(0);
    // A session created after the baseline still lights up with its first reply.
    expect([...unreadOf(new Map([...withHistory, ['z', at('2026-11-04T07:00:00.000Z')]]), seen, [])]).toEqual(['z']);
  });

  it('serializes as version 2', () => {
    expect(JSON.parse(serializeSeen(record('2026-11-04T00:00:00.000Z', { a: '2026-11-04T01:00:00.000Z' })))).toEqual({ version: 2, since: '2026-11-04T00:00:00.000Z', seen: { a: '2026-11-04T01:00:00.000Z' } });
  });
});

describe('T054 unread and seen', () => {
  it('a reply newer than the seen time is unread, except in a visible session; mixed offsets compare as instants', () => {
    const seen = record(null, { a: '2026-11-04T09:59:00+08:00', b: '2026-11-04T02:00:00.000Z' });
    expect([...unreadOf(replies, seen, [])]).toEqual(['a']);
    expect(unreadOf(replies, seen, ['a']).size).toBe(0);
  });

  it('a session without replies (only the user\'s own messages) is never unread', () => {
    expect(unreadOf(new Map(), record(null, {}), []).size).toBe(0);
  });

  it('markSeen moves visible sessions up to their newest reply, and returns the same object when nothing changes', () => {
    const seen = record('2026-11-04T00:00:00.000Z', { a: '2026-11-04T01:00:00.000Z' });
    const next = markSeen(seen, replies, ['a', 'b', 'c']);
    expect(next).toEqual(record('2026-11-04T00:00:00.000Z', { a: '2026-11-04T02:00:00.000Z', b: '2026-11-04T02:00:00.000Z' }));
    expect(markSeen(next, replies, ['a', 'b'])).toBe(next);
    expect(markSeen(seen, replies, [])).toBe(seen);
    // Never moves back: an older reply (after a reload) leaves a newer seen time alone.
    const ahead = record(null, { a: '2026-11-04T09:00:00.000Z' });
    expect(markSeen(ahead, replies, ['a'])).toBe(ahead);
  });
});
