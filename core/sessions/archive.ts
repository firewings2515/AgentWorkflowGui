// Archiving (U4, T059): what a conversation (the tree below an ordinary top session) and a run are, when they were last
// written to, and what keeps them from being archived. The commands live in the session service (they need its queues);
// the auto-archive's scan lives here and goes through the service's own command path, re-checked inside its locks.
import {
  autoArchiveDaysOf,
  type CommandResult,
  type Escalation,
  type InstanceId,
  type LogicalSession,
  pinnedOf,
  type SessionId,
  type Timestamp,
  type UiPreferences,
  type WorkflowInstance,
} from '../../contracts';
import type { AppRepositories } from '../ports';

const DAY_MS = 86_400_000;

type Lookup = (id: SessionId) => LogicalSession | undefined;

/** The session's parent in the chat tree: an ordinary session that exists (as the sidebar builds the tree). */
const ordinaryParentId = (session: LogicalSession, lookup: Lookup): SessionId | undefined => {
  if (session.kind !== 'ordinary' || session.parentId === undefined) return undefined;
  return lookup(session.parentId)?.kind === 'ordinary' ? session.parentId : undefined;
};

/** The top session of an ordinary tree: an ordinary session without an ordinary parent that exists. */
export const isTopLevel = (session: LogicalSession, lookup: Lookup): boolean => session.kind === 'ordinary' && ordinaryParentId(session, lookup) === undefined;

/** The top session of the tree an ordinary session is in (itself when it is top); undefined for a workflow session. */
export function topOf(session: LogicalSession, lookup: Lookup): LogicalSession | undefined {
  if (session.kind !== 'ordinary') return undefined;
  const seen = new Set<SessionId>();
  let cursor: LogicalSession = session;
  for (;;) {
    seen.add(cursor.id);
    const parentId = ordinaryParentId(cursor, lookup);
    const parent = parentId === undefined || seen.has(parentId) ? undefined : lookup(parentId);
    if (parent === undefined) return cursor;
    cursor = parent;
  }
}

/** As `topOf`, reading each parent from the repository (a send walks up its own tree only). */
export async function topOfStored(session: LogicalSession, get: (id: SessionId) => Promise<LogicalSession | undefined>): Promise<LogicalSession | undefined> {
  if (session.kind !== 'ordinary') return undefined;
  const seen = new Set<SessionId>([session.id]);
  let cursor: LogicalSession = session;
  while (cursor.kind === 'ordinary' && cursor.parentId !== undefined && !seen.has(cursor.parentId)) {
    const parent = await get(cursor.parentId);
    if (parent?.kind !== 'ordinary') break;
    seen.add(parent.id);
    cursor = parent;
  }
  return cursor;
}

/** The top session and every ordinary session below it. */
export function treeOf(topId: SessionId, sessions: readonly LogicalSession[]): LogicalSession[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const top = byId.get(topId);
  if (top === undefined) return [];
  const children = new Map<SessionId, LogicalSession[]>();
  for (const s of sessions) {
    const parentId = ordinaryParentId(s, (id) => byId.get(id));
    if (parentId !== undefined) children.set(parentId, [...(children.get(parentId) ?? []), s]);
  }
  const tree: LogicalSession[] = [];
  const seen = new Set<SessionId>();
  const queue = [top];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    tree.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }
  return tree;
}

/** The sessions of a run: its root and every node session. */
export const runSessionsOf = (instanceId: InstanceId, sessions: readonly LogicalSession[]): LogicalSession[] =>
  sessions.filter((s) => s.kind === 'workflow' && s.workflow.instanceId === instanceId);

export const runEnded = (instance: Pick<WorkflowInstance, 'state'>): boolean => instance.state === 'completed' || instance.state === 'cancelled';

/** Whether an escalation of these sessions (or of this run) is still open. */
export const escalationOpenIn = (open: readonly Escalation[], sessionIds: ReadonlySet<string>, instanceId?: InstanceId): boolean =>
  open.some((e) => e.state === 'open' && (sessionIds.has(e.fromSessionId) || sessionIds.has(e.rootSessionId) || (instanceId !== undefined && e.instanceId === instanceId)));

const instant = (at: Timestamp): number => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * A conversation's last-message time (Q-17), in epoch milliseconds: the newest of its sessions' last messages, where a
 * session without a counted message goes by its createdAt (as each sidebar row does).
 */
export async function treeLastMessageMs(repos: Pick<AppRepositories, 'conversations'>, tree: readonly LogicalSession[]): Promise<number> {
  let newest = -Infinity;
  for (const session of tree) newest = Math.max(newest, (await repos.conversations.latestMessageMs(session.id)) ?? instant(session.createdAt));
  return newest;
}

/**
 * A run's last-message time (Q-17): the newest counted message of any of its sessions; only when none has one, the newest
 * of their and the run's createdAt (as the sidebar's `runLastMessageAt`).
 */
export async function runLastMessageMs(repos: Pick<AppRepositories, 'conversations'>, instance: Pick<WorkflowInstance, 'createdAt'>, nodes: readonly LogicalSession[]): Promise<number> {
  let newest = -Infinity;
  for (const session of nodes) newest = Math.max(newest, (await repos.conversations.latestMessageMs(session.id)) ?? -Infinity);
  if (newest > -Infinity) return newest;
  return nodes.reduce((latest, node) => Math.max(latest, instant(node.createdAt)), instant(instance.createdAt));
}

/** Whether any of a conversation's sessions is pinned in the chat list. */
export const treePinned = (preferences: UiPreferences, tree: readonly LogicalSession[]): boolean => {
  const pinned = new Set<string>(pinnedOf(preferences).chat);
  return tree.some((s) => pinned.has(s.id));
};

/** Whether a run, or one of its node sessions, is pinned in the workflow list (WB-11). */
export const runPinned = (preferences: UiPreferences, instanceId: InstanceId, nodes: readonly LogicalSession[]): boolean => {
  const pinned = new Set<string>(pinnedOf(preferences).workflow);
  return pinned.has(instanceId) || nodes.some((s) => pinned.has(s.id));
};

/**
 * What the auto-archive asks again inside the command's locks (U4): the newest message must still be older than
 * `cutoffMs` and nothing of it pinned. A failing check is a skip, never a retry.
 */
export interface AutoArchiveCheck {
  cutoffMs: number;
}

/** What one auto-archive pass did: how many it archived, skipped (refused when re-checked) and found failing. */
export interface AutoArchiveReport {
  archived: number;
  skipped: number;
  failed: number;
}

/** The session service's side of the auto-archive. */
export interface AutoArchiveCommands {
  /** The same command path as `session.archive` and `workflow.archive`, with the auto-archive's checks inside the locks. */
  archiveTree(requestId: string, sessionId: SessionId, expectedRevision: number, auto: AutoArchiveCheck): Promise<CommandResult>;
  archiveRun(requestId: string, instanceId: InstanceId, expectedRevision: number, auto: AutoArchiveCheck): Promise<CommandResult>;
  /** Whether a turn of this session runs now (as the archive commands judge it). */
  turnRunning(session: LogicalSession): boolean;
  /** Takes archived conversations and runs out of the pinned lists, when an earlier archive could not (H). */
  unpinArchived(): Promise<void>;
  isClosing(): boolean;
}

export interface AutoArchiverOptions {
  repositories: Pick<AppRepositories, 'sessions' | 'instances' | 'escalations' | 'preferences' | 'conversations'>;
  commands: AutoArchiveCommands;
  /** Epoch milliseconds now (the backend's clock, injected in tests). */
  now(): number;
  /** Request IDs of its commands (fixed prefix, never shown). */
  requestId(): string;
  /** Asked before each command: false stops the pass (read-only data, closing). */
  mayWrite(): boolean;
  log(message: string): void;
}

/**
 * The auto-archive (U4): every conversation and ended run whose last message is older than `autoArchiveDays`, with no
 * turn running, no escalation open and nothing of it pinned, is archived through the archive commands, with the
 * revision this scan read; any refusal (another revision, a new message, a turn started, pinned meanwhile) skips it until
 * the next pass. One pass at a time; `stop()` ends a pass before its next command.
 */
export class AutoArchiver {
  private running: Promise<AutoArchiveReport> | undefined;
  private stopped = false;

  constructor(private readonly options: AutoArchiverOptions) {}

  stop(): void {
    this.stopped = true;
  }

  /** One pass; a pass already under way is not started again (its report is returned for it). */
  run(): Promise<AutoArchiveReport> {
    if (this.running !== undefined) return this.running;
    const pass = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = pass;
    return pass;
  }

  private active(): boolean {
    return !this.stopped && !this.options.commands.isClosing() && this.options.mayWrite();
  }

  private async pass(): Promise<AutoArchiveReport> {
    const report: AutoArchiveReport = { archived: 0, skipped: 0, failed: 0 };
    if (!this.active()) return report;
    const { repositories: repos, commands } = this.options;
    const log = (message: string) => this.options.log(message);
    try {
      // Pins an earlier archive left (its preferences write failed): taken out first, so they never keep failing (H).
      await commands.unpinArchived();
      const preferences = await repos.preferences.get();
      const days = autoArchiveDaysOf(preferences);
      if (days === null) return report;
      const cutoffMs = this.options.now() - days * DAY_MS;
      const sessions = await repos.sessions.list();
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const open = await repos.escalations.list({ state: 'open' });
      const candidates: { kind: 'tree' | 'run'; id: string; revision: number }[] = [];
      for (const top of sessions) {
        if (top.kind !== 'ordinary' || top.archivedAt !== undefined || !isTopLevel(top, (id) => byId.get(id))) continue;
        const tree = treeOf(top.id, sessions);
        if (tree.some((s) => commands.turnRunning(s)) || escalationOpenIn(open, new Set(tree.map((s) => s.id))) || treePinned(preferences, tree)) continue;
        if ((await treeLastMessageMs(repos, tree)) >= cutoffMs) continue;
        candidates.push({ kind: 'tree', id: top.id, revision: top.revision });
      }
      for (const instance of await repos.instances.list()) {
        if (instance.archivedAt !== undefined || !runEnded(instance)) continue;
        const nodes = runSessionsOf(instance.id, sessions);
        if (nodes.some((s) => commands.turnRunning(s)) || escalationOpenIn(open, new Set(nodes.map((s) => s.id)), instance.id) || runPinned(preferences, instance.id, nodes)) continue;
        if ((await runLastMessageMs(repos, instance, nodes)) >= cutoffMs) continue;
        candidates.push({ kind: 'run', id: instance.id, revision: instance.revision });
      }
      for (const candidate of candidates) {
        if (!this.active()) break;
        try {
          const auto = { cutoffMs };
          const result =
            candidate.kind === 'tree'
              ? await commands.archiveTree(this.options.requestId(), candidate.id as SessionId, candidate.revision, auto)
              : await commands.archiveRun(this.options.requestId(), candidate.id as InstanceId, candidate.revision, auto);
          if (result.ok) report.archived++;
          else report.skipped++;
        } catch (error) {
          report.failed++;
          log(`[archive] archiving a ${candidate.kind === 'tree' ? 'conversation' : 'run'} failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
        }
      }
    } catch (error) {
      report.failed++;
      log(`[archive] the auto-archive pass failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
    }
    if (report.archived + report.skipped + report.failed > 0)
      log(`[archive] auto-archive: ${String(report.archived)} archived, ${String(report.skipped)} skipped, ${String(report.failed)} failed`);
    return report;
  }
}
