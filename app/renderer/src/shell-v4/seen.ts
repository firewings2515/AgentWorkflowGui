// Unread marks (U3_PLAN Q-14, T054): a session is unread when its newest assistant reply is newer than the time it was
// last seen. A session shown in a visible pane counts as seen up to that reply. The seen times live in this renderer
// only (localStorage), never in the backend.
//
// r1 P2-2: the record also keeps `since`, the newest message time known when the baseline was taken. A session the
// record does not name is unread only for a reply newer than that, so an older history page loaded later cannot light
// it up, while a session created after the baseline still lights up with its first reply.
import { instant } from './last-message';
import type { LastMessageTimes } from './last-message';
import type { StoredRead } from './local-store';

/** `{ version: 2, since: ISO | null, seen: {sessionId: ISO} }`. */
export const SEEN_KEY = 'awg.seen.v2';
export type SeenTimes = Readonly<Record<string, string>>;
export interface SeenRecord { readonly since: string | null; readonly seen: SeenTimes }

const iso = (time: number) => new Date(time).toISOString();
const validTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const newest = (times: Iterable<number>) => { let max = -Infinity; for (const time of times) if (time > max) max = time; return max === -Infinity ? null : iso(max); };

/**
 * Everything as seen up to its newest reply: the first start, or a record that cannot be read, lights nothing up.
 * `since` is the newest message (any counted role) in the Snapshot.
 */
export function baselineSeen(sessions: readonly { id: string }[], replies: LastMessageTimes, last: LastMessageTimes): SeenRecord {
  const seen: Record<string, string> = {};
  for (const session of sessions) {
    const reply = replies.get(session.id);
    if (reply !== undefined) seen[session.id] = iso(reply);
  }
  return { since: newest([...last.values(), ...replies.values()]), seen };
}

/** Keeps the entries of sessions still in the Snapshot; an entry that is not a time takes that session's baseline. */
function prune(entries: Record<string, unknown>, sessions: readonly { id: string }[], replies: LastMessageTimes): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const session of sessions) {
    if (!Object.hasOwn(entries, session.id)) continue;
    const value = entries[session.id];
    const reply = replies.get(session.id);
    if (validTime(value)) seen[session.id] = value;
    else if (reply !== undefined) seen[session.id] = iso(reply);
  }
  return seen;
}

/**
 * The seen record at start-up: a v2 record's `since`, and its entries of sessions still in the Snapshot. Anything else
 * (missing, unreadable, broken JSON, another shape) takes the baseline (r2: only v2 exists; v1 was never released). A
 * session the record does not name appeared since, so only a reply newer than `since` makes it unread.
 */
export function initialSeen(stored: StoredRead, sessions: readonly { id: string }[], replies: LastMessageTimes, last: LastMessageTimes): SeenRecord {
  const value = stored.ok ? stored.value : undefined;
  if (!isMap(value) || value.version !== 2 || !isMap(value.seen) || !(value.since === null || validTime(value.since))) return baselineSeen(sessions, replies, last);
  return { since: value.since, seen: prune(value.seen, sessions, replies) };
}

/**
 * The record as written: only the entries of sessions that still exist (T058), so a session that went away while the app
 * ran is not written back until the next start prunes it. The record in memory keeps them; they light nothing up.
 */
export function serializeSeen(record: SeenRecord, sessionIds: ReadonlySet<string>): string {
  const seen: Record<string, string> = {};
  for (const [id, time] of Object.entries(record.seen)) if (sessionIds.has(id)) seen[id] = time;
  return JSON.stringify({ version: 2, since: record.since, seen });
}

const seenAt = (record: SeenRecord, id: string) => {
  const value = record.seen[id];
  if (value !== undefined) return instant(value);
  return record.since === null ? -Infinity : instant(record.since);
};

/** Moves the seen time of each visible session up to its newest reply; the same object when nothing changes. */
export function markSeen(record: SeenRecord, replies: LastMessageTimes, visible: readonly string[]): SeenRecord {
  let next: Record<string, string> | undefined;
  for (const id of visible) {
    const reply = replies.get(id);
    if (reply === undefined || (record.seen[id] !== undefined && reply <= instant(record.seen[id]))) continue;
    next ??= { ...record.seen };
    next[id] = iso(reply);
  }
  return next ? { since: record.since, seen: next } : record;
}

/** Sessions with a reply newer than their seen time, except those shown in a visible pane right now. */
export function unreadOf(replies: LastMessageTimes, record: SeenRecord, visible: readonly string[]): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const [id, reply] of replies) if (reply > seenAt(record, id) && !visible.includes(id)) unread.add(id);
  return unread;
}
