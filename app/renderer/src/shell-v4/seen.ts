// Unread marks (U3_PLAN Q-14, T054): a session is unread when its newest assistant reply is newer than the time it was
// last seen. A session shown in any pane counts as seen up to that reply. The seen times live in this renderer only
// (localStorage `awg.seen.v1`, `{sessionId: ISO time}`), never in the backend.
import { instant } from './last-message';
import type { LastMessageTimes } from './last-message';
import type { StoredRead } from './local-store';

export const SEEN_KEY = 'awg.seen.v1';
export type SeenTimes = Readonly<Record<string, string>>;

const iso = (time: number) => new Date(time).toISOString();
const validTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Everything as seen up to its newest reply: the first start, or a record that cannot be read, lights nothing up. */
export function baselineSeen(sessions: readonly { id: string }[], replies: LastMessageTimes): SeenTimes {
  const seen: Record<string, string> = {};
  for (const session of sessions) {
    const reply = replies.get(session.id);
    if (reply !== undefined) seen[session.id] = iso(reply);
  }
  return seen;
}

/**
 * The seen times at start-up from the stored record. Missing, unreadable or not an object: the baseline. Otherwise the
 * entries of sessions the Snapshot no longer has are dropped; an entry that is not a time takes the baseline. A session
 * the record does not name appeared since, so any reply it has is new.
 */
export function initialSeen(stored: StoredRead, sessions: readonly { id: string }[], replies: LastMessageTimes): SeenTimes {
  const record = stored.ok ? stored.value : undefined;
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return baselineSeen(sessions, replies);
  const entries = record as Record<string, unknown>;
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

const seenAt = (seen: SeenTimes, id: string) => { const value = seen[id]; return value === undefined ? -Infinity : instant(value); };

/** Moves the seen time of each visible session up to its newest reply; the same object when nothing changes. */
export function markSeen(seen: SeenTimes, replies: LastMessageTimes, visible: readonly string[]): SeenTimes {
  let next: Record<string, string> | undefined;
  for (const id of visible) {
    const reply = replies.get(id);
    if (reply === undefined || reply <= seenAt(seen, id)) continue;
    next ??= { ...seen };
    next[id] = iso(reply);
  }
  return next ?? seen;
}

/** Sessions with a reply newer than their seen time, except those shown in a pane right now. */
export function unreadOf(replies: LastMessageTimes, seen: SeenTimes, visible: readonly string[]): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const [id, reply] of replies) if (reply > seenAt(seen, id) && !visible.includes(id)) unread.add(id);
  return unread;
}
