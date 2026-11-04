// "Last message" time of a session (U3_PLAN §2, Q-17): the newest message's createdAt, or the session's createdAt when it
// has none. The sidebar order (T054) and the move picker (T053) use the same functions.
import { useMemo } from 'react';
import type { Message, WorkflowInstance } from '../../../../contracts';

/** What ordering needs of a session (structural, so plain test data works too). */
export interface SessionTimes { id: string; createdAt: string }

/** Newest message time per session, as epoch milliseconds; one pass over the Snapshot's messages. */
export type LastMessageTimes = ReadonlyMap<string, number>;

/** Timestamps are compared as instants: the data mixes `Z` and `+08:00`, so comparing the strings would be wrong. */
export const instant = (value: string) => { const time = Date.parse(value); return Number.isNaN(time) ? 0 : time; };

type MessageFields = Pick<Message, 'sessionId' | 'role' | 'createdAt'> & { nativeTaskId?: string | undefined };

/**
 * Q-17 (T054 decision): only the user's and the assistant's messages of the main conversation count — user (also peer,
 * handoff and transfer messages) or assistant, without nativeTaskId. System notes and a sub-agent's messages do not.
 */
export const countsAsMessage = (message: MessageFields) => (message.role === 'user' || message.role === 'assistant') && message.nativeTaskId === undefined;
/** Q-14: only the assistant's replies in the main conversation make a session unread. */
export const countsAsReply = (message: MessageFields) => message.role === 'assistant' && message.nativeTaskId === undefined;

function newestBy(messages: readonly MessageFields[], include: (message: MessageFields) => boolean): Map<string, number> {
  const times = new Map<string, number>();
  for (const message of messages) {
    if (!include(message)) continue;
    const time = instant(message.createdAt);
    if (time > (times.get(message.sessionId) ?? -Infinity)) times.set(message.sessionId, time);
  }
  return times;
}

export const lastMessageTimes = (snapshot: { messages: readonly MessageFields[] }): LastMessageTimes => newestBy(snapshot.messages, countsAsMessage);
/** Newest assistant reply per session (Q-14), as epoch milliseconds. */
export const lastReplyTimes = (snapshot: { messages: readonly MessageFields[] }): LastMessageTimes => newestBy(snapshot.messages, countsAsReply);

export const lastMessageAt = (times: LastMessageTimes, session: SessionTimes) =>
  times.get(session.id) ?? instant(session.createdAt);

/** Newest last message first; equal times keep a stable order by ID. */
export const byLastMessage = (times: LastMessageTimes) => (a: SessionTimes, b: SessionTimes) =>
  lastMessageAt(times, b) - lastMessageAt(times, a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A run's last message (Q-17): the newest of its node sessions, or the run's createdAt when it has none newer. */
export const runLastMessageAt = (times: LastMessageTimes, instance: Pick<WorkflowInstance, 'createdAt'>, nodes: readonly SessionTimes[]) =>
  nodes.reduce((latest, node) => Math.max(latest, lastMessageAt(times, node)), instant(instance.createdAt));

export interface MessageTimes { last: LastMessageTimes; replies: LastMessageTimes }

const sameFields = (a: Message, b: Message) =>
  a === b || (a.id === b.id && a.sessionId === b.sessionId && a.role === b.role && a.createdAt === b.createdAt && a.nativeTaskId === b.nativeTaskId);

/** The last computed times, shared by every caller: the result depends only on the messages, not on who asks. */
let cache: { messages: readonly Message[]; times: MessageTimes } | undefined;

/**
 * Last-message and last-reply times that keep their identity while only message text changes. A `message.delta` to a
 * stored message makes a new `messages` array each time (renderer-store `applyEnvelope`), so a memo on the array alone
 * would recompute on every delta: here a delta costs one pointer scan, and nothing downstream (order, unread) reruns.
 */
export function messageTimesOf(messages: readonly Message[]): MessageTimes {
  if (cache && (cache.messages === messages || (cache.messages.length === messages.length && messages.every((message, index) => sameFields(cache!.messages[index]!, message))))) {
    cache = { messages, times: cache.times };
    return cache.times;
  }
  cache = { messages, times: { last: lastMessageTimes({ messages }), replies: lastReplyTimes({ messages }) } };
  return cache.times;
}

export const useMessageTimes = (messages: readonly Message[]) => useMemo(() => messageTimesOf(messages), [messages]);
