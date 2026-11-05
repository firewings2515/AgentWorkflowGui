// Archive (U4 §3, T060): what the sidebar, the banner and the menu know of archived conversations and runs. One source
// for all of them, so the 「已封存」 section, the pinned section and the list never show the same item.
// - A conversation is archived when its top session (walking up ordinary parents, as the backend's `topOf`) carries
//   `archivedAt`; the sessions below it never do (T059 report §4).
// - A run is archived when its instance carries `archivedAt`; its node sessions never do.
// What `archiveBlock` finds is only a forecast for the menu: the backend's answer always has the last word.
import type { CommandRefusal, InstanceId, LogicalSession, SessionId, Snapshot } from '../../../../contracts';
import type { StoredRead } from './local-store';

export type ArchiveTarget = { kind: 'session'; id: SessionId } | { kind: 'run'; id: InstanceId };

export interface ArchivedIndex {
  /** Top sessions of archived conversations. */
  roots: ReadonlySet<string>;
  /** Every session of an archived conversation (its top included). */
  sessions: ReadonlySet<string>;
  /** Archived runs. */
  runs: ReadonlySet<string>;
  /** Every node session of an archived run. */
  runSessions: ReadonlySet<string>;
  /** The top session of each ordinary session; filled only when some conversation is archived. */
  tops: ReadonlyMap<string, LogicalSession>;
}

/**
 * The top session of every ordinary session, in one pass: the parent chain is walked once and remembered for each
 * session on it. A parent that is missing or not ordinary ends the chain (that session is the top); a cycle in bad data
 * ends it too.
 */
export function topsOf(sessions: readonly LogicalSession[]): ReadonlyMap<string, LogicalSession> {
  const byId = new Map(sessions.map(session => [session.id as string, session]));
  const tops = new Map<string, LogicalSession>();
  for (const session of sessions) {
    if (session.kind !== 'ordinary' || tops.has(session.id)) continue;
    const path: LogicalSession[] = [];
    const onPath = new Set<string>();
    let cursor = session;
    let top: LogicalSession | undefined;
    for (;;) {
      top = tops.get(cursor.id);
      if (top) break;
      path.push(cursor);
      onPath.add(cursor.id);
      const parent = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
      if (!parent || parent.kind !== 'ordinary' || onPath.has(parent.id)) { top = cursor; break; }
      cursor = parent;
    }
    for (const item of path) tops.set(item.id, top);
  }
  return tops;
}

export function archivedIndex(snapshot: { sessions: readonly LogicalSession[]; instances?: Snapshot['instances'] | undefined }): ArchivedIndex {
  const roots = new Set<string>();
  const sessions = new Set<string>();
  const runs = new Set<string>((snapshot.instances ?? []).filter(instance => instance.archivedAt !== undefined).map(instance => instance.id));
  const runSessions = new Set<string>();
  // Most data has nothing archived: then no parent chain is walked at all.
  const anyRoot = snapshot.sessions.some(session => session.kind === 'ordinary' && session.archivedAt !== undefined);
  const tops = anyRoot ? topsOf(snapshot.sessions) : undefined;
  for (const session of snapshot.sessions) {
    if (session.kind === 'workflow') { if (runs.has(session.workflow.instanceId)) runSessions.add(session.id); continue; }
    const top = tops?.get(session.id);
    if (top?.kind !== 'ordinary' || top.archivedAt === undefined) continue;
    sessions.add(session.id);
    if (top === session) roots.add(session.id);
  }
  return { roots, sessions, runs, runSessions, tops: tops ?? new Map() };
}

/** The archived conversation or run this session is in; undefined when it is in none. Cheap: no Snapshot scan. */
export function archivedTargetIn(index: ArchivedIndex, session: LogicalSession): ArchiveTarget | undefined {
  if (session.kind === 'workflow') return index.runs.has(session.workflow.instanceId) ? { kind: 'run', id: session.workflow.instanceId } : undefined;
  const top = index.sessions.has(session.id) ? index.tops.get(session.id) : undefined;
  return top ? { kind: 'session', id: top.id } : undefined;
}

export const isArchived = (index: ArchivedIndex, id: string) => index.sessions.has(id) || index.runs.has(id) || index.runSessions.has(id);

/** What archiving or unarchiving `sessionId` acts on: the top of its conversation, or its run. */
export function archiveTargetOf(snapshot: Pick<Snapshot, 'sessions'>, sessionId: string): ArchiveTarget | undefined {
  const session = snapshot.sessions.find(item => item.id === sessionId);
  if (!session) return undefined;
  if (session.kind === 'workflow') return { kind: 'run', id: session.workflow.instanceId };
  const top = topsOf(snapshot.sessions).get(session.id);
  return top ? { kind: 'session', id: top.id } : undefined;
}

/** Whether the target is archived now; undefined when it is not in the Snapshot. */
export function targetArchived(snapshot: Pick<Snapshot, 'sessions' | 'instances'>, target: ArchiveTarget): boolean | undefined {
  if (target.kind === 'run') {
    const instance = snapshot.instances.find(item => item.id === target.id);
    return instance ? instance.archivedAt !== undefined : undefined;
  }
  const session = snapshot.sessions.find(item => item.id === target.id);
  return session?.kind === 'ordinary' ? session.archivedAt !== undefined : undefined;
}

/** The target's revision in this Snapshot (the top session's, or the run's). */
export function targetRevision(snapshot: Pick<Snapshot, 'sessions' | 'instances'>, target: ArchiveTarget): number | undefined {
  return target.kind === 'run' ? snapshot.instances.find(item => item.id === target.id)?.revision
    : snapshot.sessions.find(item => item.id === target.id)?.revision;
}

/** A session doing something (T059: running, waiting for the user or a lock, or its last delivery unknown). */
const busy = (session: Pick<LogicalSession, 'activity'>) =>
  session.activity === 'running' || session.activity === 'waiting-user' || session.activity === 'waiting-lock' || session.activity === 'reconciling';

/**
 * Why archiving the target would be refused, as far as this Snapshot shows (T059 report §4, r1, r2); undefined when
 * nothing shows. Only for the menu: a payload waiting to be sent is not in the Snapshot, so the backend may still refuse.
 */
export function archiveBlock(snapshot: Pick<Snapshot, 'sessions' | 'instances' | 'turns' | 'escalations' | 'transfers'>, target: ArchiveTarget): CommandRefusal | undefined {
  let members: LogicalSession[];
  let instanceId: string | undefined;
  if (target.kind === 'run') {
    const instance = snapshot.instances.find(item => item.id === target.id);
    if (!instance) return undefined;
    if (instance.state !== 'completed' && instance.state !== 'cancelled') return 'run-not-ended';
    instanceId = instance.id;
    members = snapshot.sessions.filter(session => session.kind === 'workflow' && session.workflow.instanceId === instance.id);
  } else {
    const session = snapshot.sessions.find(item => item.id === target.id);
    if (!session) return undefined;
    if (session.kind !== 'ordinary') return 'workflow-session';
    const tops = topsOf(snapshot.sessions);
    if (tops.get(session.id) !== session) return 'not-top-level';
    members = snapshot.sessions.filter(item => tops.get(item.id) === session);
  }
  const ids = new Set<string>(members.map(session => session.id));
  const transfers = snapshot.transfers.filter(proposal => ids.has(proposal.sourceSessionId) || (proposal.createdSessionId !== undefined && ids.has(proposal.createdSessionId)));
  if (members.some(busy) || snapshot.turns.some(turn => ids.has(turn.sessionId) && turn.state === 'running' && turn.nativeTaskId === undefined)
    || transfers.some(proposal => proposal.state === 'draft' || (proposal.state === 'approved' && proposal.delivery?.state !== 'sent'))) return 'turn-running';
  if (snapshot.escalations.some(item => item.state === 'open' && (ids.has(item.fromSessionId) || ids.has(item.rootSessionId) || (instanceId !== undefined && item.instanceId === instanceId)))
    || transfers.some(proposal => proposal.state === 'awaiting-confirmation')) return 'escalation-open';
  return undefined;
}

/** Whether any of these sessions is doing something now (the 「已封存」 heading's mark, T059 ★D). */
export const anyBusy = (sessions: Iterable<LogicalSession>) => { for (const session of sessions) if (busy(session)) return true; return false; };

/** localStorage key of the 「已封存」 sections' open state, one per sidebar mode (T054's way: renderer-only memory). */
export const ARCHIVED_OPEN_KEY = 'awg.archived-open.v1';
export interface ArchivedOpen { chat: boolean; workflow: boolean }
export const ARCHIVED_CLOSED: ArchivedOpen = { chat: false, workflow: false };
/** The stored open state; anything missing or malformed is closed (the default). */
export function readArchivedOpen(read: StoredRead): ArchivedOpen {
  if (!read.ok || typeof read.value !== 'object' || read.value === null) return ARCHIVED_CLOSED;
  const value = read.value as Record<string, unknown>;
  return { chat: value['chat'] === true, workflow: value['workflow'] === true };
}
