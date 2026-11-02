// The conversation records a window was not sent events about (T040 r1 P1-1): a window that was let go (C-27), or whose
// batch could not be sent, reads the Snapshot again and takes it in place of everything it held. The Snapshot holds
// each session's last turns and whatever is still open (C-26), so a record older than those that changed meanwhile (a
// far-back running turn that ended, a permission request that was answered) would be in neither: the renderer would
// keep its stream of a message it never sees completed, and the record would be missing from what it shows. So the
// batcher writes down what it did not send, and the next Snapshot brings those records back, however old.
//
// By session: whole turns (a turn's records come with it) and, for records without a turn, the record itself. Past a
// limit a session is taken whole instead: memory stays bounded however long a window is not fed.
import type { AppEvent, SessionId } from '../../contracts';
import type { Conversation } from '../../core/ports';

export interface MissedSession {
  turns: Set<string>;
  /** `<kind>:<id>` of records without a turn (`m` message, `i` item, `p` permission request, `n` native task, `a` artifact). */
  records: Set<string>;
  /** Too much to name one by one: the session's whole conversation goes into the Snapshot. */
  whole: boolean;
}

export type MissedRecords = Map<SessionId, MissedSession>;

/** Turns and records written down per session before it is taken whole. */
export const MISSED_PER_SESSION = 2000;

type RecordKind = 'm' | 'i' | 'p' | 'n' | 'a';

const recordOf = (event: AppEvent): { sessionId: SessionId; turnId?: string | undefined; kind?: RecordKind; id?: string } | undefined => {
  switch (event.type) {
    case 'turn.updated':
      return { sessionId: event.turn.sessionId, turnId: event.turn.id };
    case 'message.completed':
      return { sessionId: event.message.sessionId, turnId: event.message.turnId, kind: 'm', id: event.message.id };
    case 'message.delta':
      return { sessionId: event.sessionId, turnId: event.turnId, kind: 'm', id: event.messageId };
    case 'item.updated':
      return { sessionId: event.item.sessionId, turnId: event.item.turnId, kind: 'i', id: event.item.id };
    case 'item.outputDelta':
      return { sessionId: event.sessionId, kind: 'i', id: event.itemId };
    case 'permission.updated':
      return { sessionId: event.request.sessionId, turnId: event.request.turnId, kind: 'p', id: event.request.id };
    case 'nativeTask.updated':
      return { sessionId: event.task.sessionId, kind: 'n', id: event.task.id };
    case 'artifact.updated':
      return { sessionId: event.artifact.sessionId, turnId: event.artifact.turnId, kind: 'a', id: event.artifact.id };
    default:
      // Everything else the Snapshot holds in full (sessions, instances, handoffs, escalations, transfers, ...).
      return undefined;
  }
};

/** Writes down the record an event not sent was about, if the Snapshot might not hold it. */
export const noteMissed = (missed: MissedRecords, event: AppEvent): void => {
  const record = recordOf(event);
  if (record === undefined) return;
  let session = missed.get(record.sessionId);
  if (session === undefined) missed.set(record.sessionId, (session = { turns: new Set(), records: new Set(), whole: false }));
  if (session.whole) return;
  // A record of a turn comes with its turn; a native task has no turn of its own.
  if (record.turnId !== undefined) session.turns.add(record.turnId);
  else if (record.kind !== undefined && record.id !== undefined) session.records.add(`${record.kind}:${record.id}`);
  if (session.turns.size + session.records.size > MISSED_PER_SESSION) {
    session.whole = true;
    session.turns.clear();
    session.records.clear();
  }
};

/** `from`'s entries added to `into` (the batcher keeps what a Snapshot that failed did not bring back). */
export const mergeMissed = (into: MissedRecords, from: MissedRecords): void => {
  for (const [sessionId, session] of from) {
    const kept = into.get(sessionId);
    if (kept === undefined) {
      into.set(sessionId, session);
      continue;
    }
    kept.whole ||= session.whole;
    for (const t of session.turns) kept.turns.add(t);
    for (const r of session.records) kept.records.add(r);
    if (kept.whole || kept.turns.size + kept.records.size > MISSED_PER_SESSION) {
      kept.whole = true;
      kept.turns.clear();
      kept.records.clear();
    }
  }
};

const key = (r: { sessionId: string; id: string }) => JSON.stringify([r.sessionId, r.id]);

/**
 * The sessions of `missed` whose records `held` (the Snapshot's part of the conversations) does not all hold, with what
 * is to be added of each: these are read in full and `addMissed` takes what was asked for.
 */
export const sessionsToRead = (held: Conversation, missed: MissedRecords): SessionId[] => {
  const turns = new Set(held.turns.map(key));
  const records = new Set<string>([
    ...held.messages.map((r) => `m${key(r)}`),
    ...held.items.map((r) => `i${key(r)}`),
    ...held.permissionRequests.map((r) => `p${key(r)}`),
    ...held.nativeTasks.map((r) => `n${key(r)}`),
    ...held.artifacts.map((r) => `a${key(r)}`),
  ]);
  return [...missed]
    .filter(
      ([sessionId, s]) =>
        s.whole ||
        [...s.turns].some((id) => !turns.has(key({ sessionId, id }))) ||
        [...s.records].some((r) => {
          const at = r.indexOf(':');
          return !records.has(`${r.slice(0, at)}${key({ sessionId, id: r.slice(at + 1) })}`);
        }),
    )
    .map(([sessionId]) => sessionId);
};

/**
 * `held` with the records `missed` names of one session added from `whole` (that session's whole conversation, read
 * after `held`, so never older). What `held` has stays as it is; added records go before it, as an older history page
 * does, and messages are then in time order (as the renderer keeps them when it adds a page).
 */
export const addMissed = (held: Conversation, whole: Conversation, missed: MissedSession): Conversation => {
  const wanted = (kind: RecordKind, r: { id: string; turnId?: string | undefined }) =>
    missed.whole || (r.turnId !== undefined && missed.turns.has(r.turnId)) || missed.records.has(`${kind}:${r.id}`);
  const add = <T extends { sessionId: string; id: string }>(current: T[], from: T[], take: (r: T) => boolean): T[] => {
    const have = new Set(current.map(key));
    const added = from.filter((r) => take(r) && !have.has(key(r)));
    return added.length === 0 ? current : [...added, ...current];
  };
  const messages = add(held.messages, whole.messages, (r) => wanted('m', r));
  return {
    turns: add(held.turns, whole.turns, (t) => missed.whole || missed.turns.has(t.id)),
    messages: messages === held.messages ? messages : [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    items: add(held.items, whole.items, (r) => wanted('i', r)),
    permissionRequests: add(held.permissionRequests, whole.permissionRequests, (r) => wanted('p', r)),
    nativeTasks: add(held.nativeTasks, whole.nativeTasks, (r) => missed.whole || missed.records.has(`n:${r.id}`)),
    artifacts: add(held.artifacts, whole.artifacts, (r) => wanted('a', r)),
  };
};
