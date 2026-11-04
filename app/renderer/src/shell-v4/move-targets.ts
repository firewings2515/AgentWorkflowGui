// Where an ordinary session can be moved (WB-04, T053): below another ordinary session that is not itself, not below
// it and not its current parent (U3 Q-18: never below a workflow session), or to the top when it has a parent.
import type { LogicalSession, SessionId, Snapshot } from '../../../../contracts';
import { byLastMessage, lastMessageTimes } from './last-message';
import type { LastMessageTimes } from './last-message';

/** True when `candidate` is `sessionId` or anywhere below it. Walks up the parent chain; a cycle in bad data stops. */
function inSubtree(sessions: ReadonlyMap<string, LogicalSession>, candidate: LogicalSession, sessionId: string) {
  const seen = new Set<string>();
  for (let cursor: LogicalSession | undefined = candidate; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? sessions.get(cursor.parentId) : undefined) {
    if (cursor.id === sessionId) return true;
    seen.add(cursor.id);
  }
  return false;
}

/**
 * The sessions `sessionId` can be moved below, newest last message first, filtered by title (trimmed, case-insensitive,
 * taken literally). Empty when the session is unknown or not ordinary.
 */
export function moveTargets(snapshot: Pick<Snapshot, 'sessions' | 'messages'>, sessionId: string, title: (session: LogicalSession) => string,
  query = '', times: LastMessageTimes = lastMessageTimes(snapshot)): LogicalSession[] {
  const byId = new Map(snapshot.sessions.map(session => [session.id as string, session]));
  const moving = byId.get(sessionId);
  if (moving?.kind !== 'ordinary') return [];
  const words = query.trim().toLowerCase();
  return snapshot.sessions.filter(session => session.kind === 'ordinary' && session.id !== moving.parentId && !inSubtree(byId, session, sessionId)
    && (!words || title(session).toLowerCase().includes(words))).sort(byLastMessage(times));
}

/** Whether moving `sessionId` below `parentId` (or to the top for null) still makes sense in this Snapshot. */
export function canMove(snapshot: Pick<Snapshot, 'sessions' | 'messages'>, sessionId: SessionId, parentId: SessionId | null): boolean {
  const moving = snapshot.sessions.find(session => session.id === sessionId);
  if (moving?.kind !== 'ordinary') return false;
  if (parentId === null) return moving.parentId !== undefined;
  return moveTargets(snapshot, sessionId, session => session.title, '', new Map()).some(session => session.id === parentId);
}
