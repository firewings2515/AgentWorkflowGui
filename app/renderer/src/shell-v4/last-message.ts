// "Last message" time of a session (U3_PLAN §2, Q-17): the newest message's createdAt, or the session's createdAt when it
// has none. The move picker sorts by it (T053); T054 uses the same functions for the sidebar order.
import type { LogicalSession, Snapshot } from '../../../../contracts';

/** Newest message time per session, as epoch milliseconds; one pass over the Snapshot's messages. */
export type LastMessageTimes = ReadonlyMap<string, number>;

/** Timestamps are compared as instants: the data mixes `Z` and `+08:00`, so comparing the strings would be wrong. */
const instant = (value: string) => { const time = Date.parse(value); return Number.isNaN(time) ? 0 : time; };

export function lastMessageTimes(snapshot: Pick<Snapshot, 'messages'>): LastMessageTimes {
  const times = new Map<string, number>();
  for (const message of snapshot.messages) {
    const time = instant(message.createdAt);
    if (time > (times.get(message.sessionId) ?? -Infinity)) times.set(message.sessionId, time);
  }
  return times;
}

export const lastMessageAt = (times: LastMessageTimes, session: Pick<LogicalSession, 'id' | 'createdAt'>) =>
  times.get(session.id) ?? instant(session.createdAt);

/** Newest last message first; equal times keep a stable order by ID. */
export const byLastMessage = (times: LastMessageTimes) => (a: Pick<LogicalSession, 'id' | 'createdAt'>, b: Pick<LogicalSession, 'id' | 'createdAt'>) =>
  lastMessageAt(times, b) - lastMessageAt(times, a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
