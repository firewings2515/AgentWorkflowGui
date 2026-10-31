// Same-folder file locks put to work (T033, R-07, SP-06): the permission gate's last step before a write
// is approved, the runtime events that end writes and turns, `wait_for_file`, and the folder watcher's
// after-the-fact check. Worktree-mode sessions never lock.
//
// The order is always: the policy (or the user) decides first; the lock is taken at the moment of the
// approval, with nothing awaited between hashing the file, `acquire` and `answer` (KNOWLEDGE §5). A lock can
// make an approval wait or turn it into a refusal, never turn a refusal or an escalation into an approval.
import type {
  EscalationId,
  FileLock,
  LockWaiter,
  LogicalSession,
  NativeTaskId,
  PayloadHash,
  PermissionDecision,
  PermissionRequest,
  SessionId,
  Timestamp,
  TurnId,
  WaitForFileToolInput,
  WaitForFileToolResult,
} from '../../contracts';
import type { PermissionHandle, RuntimeEvent, WaitResult, WriteOutcome } from '../ports';
import { foldPath, isIgnoredChange, isInside, lockPath } from './paths';
import { MemoryLockTable } from './table';

/** A file as `hashFile` finds it: its hash, gone, or not a file that can be read (a folder, no access). */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- a PayloadHash is `sha256:<hex>`, never one of these words
export type FileState = PayloadHash | 'missing' | 'unreadable';

export interface LockEscalation {
  kind: 'lock-timeout' | 'unlocked-write';
  /** The session that waited, or the one suspected of the write. */
  sessionId: SessionId;
  path: string;
  holderSessionId?: SessionId;
  title: string;
  detail: string;
}

export interface LockCoordinatorOptions {
  now(): Timestamp;
  /** Runs `fn` after `ms`; returns what cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
  /** The file as it is now, read synchronously so nothing runs between the read and the lock (core has no fs). */
  hashFile(path: string): FileState;
  resolveRealPath(absolutePath: string): string | null;
  /** Opens a lock escalation at the session's root (R-05); its ID, or undefined when it could not be stored. */
  escalate(escalation: LockEscalation): Promise<EscalationId | undefined>;
  /** Every lock, after each change (`locks.updated`). */
  publish(locks: FileLock[]): void;
  /** How long a Codex file-change approval is held for a lock (default 5 minutes). */
  holdMs?: number;
  /** `wait_for_file` without `timeoutMs` (default 2 minutes). */
  waitMs?: number;
  /** Whether git ignores the path (build output, node_modules, ...): such a change is no unlocked write. */
  isIgnored?(path: string): boolean;
  log?(message: string): void;
}

interface Tracked {
  id: SessionId;
  title: string;
  cwd: string;
  /** Folded workspace root. */
  root: string;
  sameFolder: boolean;
}

/** A write the GUI approved and that has not ended yet: which files, in which turn. */
interface PendingWrite {
  sessionId: SessionId;
  paths: string[];
  turnId?: TurnId;
  nativeTaskId?: NativeTaskId;
}

/** The part of an AbortSignal used here (core's lib has no DOM types). */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** What a lock step did: approved and answered, refused (answered with a decline), or the request was gone. */
export type LockStep = 'approved' | 'refused' | 'gone';

const DEFAULT_HOLD_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 2 * 60_000;

/** Claude's PreToolUse requests carry the tool name; Codex requests have none (contracts). */
const isClaude = (request: PermissionRequest) => request.tool !== undefined;
const itemKey = (sessionId: SessionId, itemId: string) => `${sessionId}\n${itemId}`;
const toHash = (state: FileState): PayloadHash | undefined => (state === 'missing' || state === 'unreadable' ? undefined : state);
const later = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();

export const isWriteRequest = (request: PermissionRequest): boolean => request.kind === 'fileChange';

export class LockCoordinator {
  readonly table: MemoryLockTable;
  private readonly sessions = new Map<SessionId, Tracked>();
  /** Paths of each file-change item as announced (Codex `item/started`, Claude's tool call). */
  private readonly itemPaths = new Map<string, string[]>();
  private readonly writes = new Map<string, PendingWrite>();
  /** Claude Reads approved and not finished: the file's hash right before the read. */
  private readonly reads = new Map<string, { path: string; before: FileState }>();
  private readonly background = new Map<SessionId, { commands: Set<string>; tasks: Set<string> }>();
  /** Held Codex approvals waiting for a lock, by request: to cancel when the runtime withdraws one. */
  private readonly waiting = new Map<string, { sessionId: SessionId; path: string }>();
  /** The last content seen of each path (a write's result or a watcher event), so a repeat is no change. */
  private readonly seen = new Map<string, FileState>();
  /** Open unlocked-write escalations by path: one at a time per file. */
  private readonly unlockedOpen = new Map<string, EscalationId | 'opening'>();
  private closing = false;

  constructor(private readonly options: LockCoordinatorOptions) {
    this.table = new MemoryLockTable({
      now: () => options.now(),
      setTimer: (ms, fn) => options.setTimer(ms, fn),
      // Build output, node_modules and the like are nobody's work on a file (main session's G8 ruling).
      inSameFolderScope: (path) => this.suspects(path).length > 0 && options.isIgnored?.(path) !== true,
      ...(options.log !== undefined && { log: (m: string) => options.log!(m) }),
    });
    this.table.subscribe((locks) => options.publish(locks));
  }

  /** Same-folder mode: an ordinary session, or a workflow session without its own worktree (R-07). */
  static sameFolder(session: Pick<LogicalSession, 'folderScope'>): boolean {
    return session.folderScope.source !== 'task-worktree';
  }

  /** Remembers what the locks need of a session (its folder, its mode, its title for refusals). */
  track(session: LogicalSession): void {
    this.sessions.set(session.id, {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      root: foldPath(session.folderScope.workspaceRoot),
      sameFolder: LockCoordinator.sameFolder(session),
    });
  }

  /**
   * Before the policy is asked (Claude only): a write to a file another session holds is refused at once
   * with who holds it, instead of escalating a write that would be refused anyway. Changes nothing.
   */
  screen(request: PermissionRequest, session: LogicalSession): string | undefined {
    if (!isWriteRequest(request) || !isClaude(request) || !LockCoordinator.sameFolder(session)) return undefined;
    for (const path of this.writePaths(request, session)) {
      const lock = this.table.list().find((l) => l.path === path);
      if (lock !== undefined && lock.holderSessionId !== session.id) return this.heldMessage(lock);
    }
    return undefined;
  }

  /**
   * Answers `handle` with `decision` (an approval of the policy or the user) once the locks allow it. Not a
   * write, or worktree mode: answered at once. A Claude write that meets another's lock is refused with
   * who holds it; a Codex one is held until the lock frees, then every file is acquired again (read check
   * included), and refused and escalated past its limit (R-07). Synchronous unless it has to wait.
   */
  approve(handle: PermissionHandle, decision: PermissionDecision, session: LogicalSession): LockStep | Promise<LockStep> {
    const { request } = handle;
    this.track(session);
    if (!LockCoordinator.sameFolder(session)) return this.answer(handle, decision);
    if (request.kind === 'permissions' && request.tool === 'Read' && request.itemId !== undefined) return this.approveRead(handle, decision, session);
    if (!isWriteRequest(request)) return this.answer(handle, decision);
    const paths = this.writePaths(request, session);
    if (paths.length === 0) return this.refuse(handle, 'AgentWorkflowGui: the files of this change are not known, so they cannot be locked (same-folder mode)');
    const step = this.tryWrite(handle, decision, session, paths);
    if (step !== 'held') return step;
    if (isClaude(request)) return this.refuse(handle, this.heldMessage(this.blocking(session.id, paths)!));
    return this.holdForLock(handle, decision, session, paths);
  }

  /** Every runtime event, synchronously as it arrives and before it is stored (no await in between). */
  observe(event: RuntimeEvent): void {
    switch (event.type) {
      case 'turn.updated': {
        const { turn } = event;
        if (turn.nativeTaskId !== undefined) return;
        if (turn.state === 'running') {
          // A turn that ended stays ended: the table drops a late running of it (T024 r2-P1-3).
          this.table.turnStarted(turn.sessionId, turn.id);
          return;
        }
        // A write of the turn that never reported its end was interrupted with it: nothing more is expected.
        for (const [key, write] of [...this.writes]) {
          if (write.sessionId !== turn.sessionId || write.nativeTaskId !== undefined) continue;
          if (write.turnId !== undefined && write.turnId !== turn.id) continue;
          this.writes.delete(key);
          for (const path of write.paths) this.table.writeEnded(write.sessionId, path, { kind: 'failed' });
        }
        this.table.turnEnded(turn.sessionId, turn.id);
        return;
      }
      case 'item.updated': {
        const { item } = event;
        const key = itemKey(item.sessionId, item.id);
        if (item.kind === 'fileChange') {
          const cwd = this.sessions.get(item.sessionId)?.cwd ?? '';
          if (item.state === 'proposed') {
            this.itemPaths.set(key, [...new Set(item.changes.flatMap((c) => [c.path, ...(c.movePath !== undefined ? [c.movePath] : [])]).map((p) => this.key(p, cwd)))]);
            return;
          }
          this.itemPaths.delete(key);
          const write = this.writes.get(key);
          if (write === undefined) return;
          this.writes.delete(key);
          const outcomes = new Map<string, WriteOutcome>();
          if (item.state === 'applied') {
            for (const change of item.changes) {
              const from = this.key(change.path, cwd);
              if (change.change === 'delete' || change.movePath !== undefined) outcomes.set(from, { kind: 'deleted' });
              if (change.movePath !== undefined) outcomes.set(this.key(change.movePath, cwd), this.outcomeNow(this.key(change.movePath, cwd)));
              else if (change.change !== 'delete') outcomes.set(from, this.outcomeNow(from));
            }
          }
          // A file of the write the item does not name (or a declined / failed item): nothing applied to it.
          for (const path of write.paths) this.ended(write.sessionId, path, outcomes.get(path) ?? { kind: 'failed' });
          return;
        }
        if (item.kind === 'command') {
          if (item.background !== true) return;
          const work = this.work(item.sessionId);
          if (item.state === 'running') work.commands.add(item.id);
          else work.commands.delete(item.id);
          this.table.backgroundCommands(item.sessionId, work.commands.size + work.tasks.size);
          return;
        }
        const read = this.reads.get(key);
        if (read === undefined || item.state === 'running') return;
        this.reads.delete(key);
        if (item.state !== 'completed') return;
        // Read twice: when the file changed while it was read, what was read is unknown, and the older hash
        // makes the next write ask for a new read (SP-06 W4).
        const after = this.options.hashFile(read.path);
        const hash = toHash(read.before) ?? toHash(after);
        // No hash (too large, unreadable): nothing to check against, and an older read no longer holds.
        if (hash !== undefined) this.table.recordRead(item.sessionId, read.path, hash);
        else this.table.forgetRead(item.sessionId, read.path);
        return;
      }
      case 'nativeTask.updated': {
        const { task } = event;
        const work = this.work(task.sessionId);
        if (task.state === 'running') work.tasks.add(task.id);
        else work.tasks.delete(task.id);
        this.table.backgroundCommands(task.sessionId, work.commands.size + work.tasks.size);
        return;
      }
      case 'permission.updated':
        if (event.request.state === 'withdrawn') {
          const wait = this.waiting.get(event.request.id);
          if (wait !== undefined) this.table.cancelWait(wait.sessionId, wait.path);
        }
        return;
      case 'runtime.exited':
        for (const sessionId of event.sessionIds) this.release(sessionId, 'runtime-exited');
        return;
      default:
        return;
    }
  }

  /** The user stopped the session: its locks go, background work or not (R-07). */
  stopped(sessionId: SessionId): void {
    this.release(sessionId, 'stopped');
  }

  /** The session's runtime was released. */
  closed(sessionId: SessionId): void {
    this.release(sessionId, 'closed');
  }

  /** The GUI began closing: every wait ends, and its held request is declined. */
  beginClose(): void {
    this.closing = true;
    for (const wait of [...this.waiting.values()]) this.table.cancelWait(wait.sessionId, wait.path);
  }

  /** `wait_for_file` of `sessionId` (R-07): the lock is free, was not there, or the wait timed out and was escalated. */
  async waitForFile(input: WaitForFileToolInput, sessionId: SessionId, signal?: AbortLike): Promise<WaitForFileToolResult> {
    if (this.closing) return { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } };
    const session = this.sessions.get(sessionId);
    if (session === undefined || !session.sameFolder) return { status: 'not-locked' };
    const path = this.key(input.path, session.cwd);
    const since = this.options.now();
    const waiter: LockWaiter = { sessionId, via: 'wait_for_file', since, deadline: later(since, input.timeoutMs ?? this.options.waitMs ?? DEFAULT_WAIT_MS) };
    const abort = () => this.table.cancelWait(sessionId, path);
    signal?.addEventListener('abort', abort, { once: true });
    let result: WaitResult;
    try {
      result = signal?.aborted === true ? { status: 'cancelled' } : await this.table.wait(path, waiter);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    switch (result.status) {
      case 'free':
      case 'not-locked':
        return { status: result.status };
      case 'cancelled':
        return this.closing ? { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } } : { status: 'timeout' };
      case 'timeout':
      case 'deadlock': {
        const holder = this.table.list().find((l) => l.path === path)?.holderSessionId;
        const escalationId = await this.escalateWait(sessionId, path, holder, result);
        return { status: 'timeout', ...(escalationId !== undefined && { escalationId }) };
      }
    }
  }

  /**
   * A file changed in a watched folder. An unlocked write (R-07, SP-06 W5/W6) is escalated to root: the
   * holder had no write in progress and the file is not what its last write left, or no lock covers it
   * while a same-folder session works in that folder. `watcher`: the session whose watch saw it.
   */
  fileChanged(watcher: SessionId, changedPath: string): void {
    const path = foldPath(changedPath);
    if (isIgnoredChange(path)) return;
    const state = this.options.hashFile(path);
    if (state === 'unreadable') return;
    // Several sessions watch one folder, and one write fires several events: only a new content counts.
    if (this.seen.get(path) === state) return;
    this.remember(path, state);
    if (!this.table.fileChanged(path, toHash(state))) return;
    if (this.unlockedOpen.has(path)) return;
    const holder = this.table.list().find((l) => l.path === path)?.holderSessionId;
    const suspects = this.suspects(path);
    const suspect = suspects.find((s) => s !== holder) ?? holder ?? suspects[0] ?? watcher;
    this.unlockedOpen.set(path, 'opening');
    const others = suspects.length > 1 ? ` ${String(suspects.length)} sessions were at work in that folder.` : '';
    void this.options
      .escalate({
        kind: 'unlocked-write',
        sessionId: suspect,
        path,
        ...(holder !== undefined && { holderSessionId: holder }),
        title: 'A file changed without its lock',
        detail:
          (holder !== undefined
            ? 'A locked file changed while its holder had no write in progress (for example a shell command wrote it).'
            : 'A file changed in same-folder mode without a lock (for example a shell command wrote it).') + others,
      })
      .then((id) => {
        if (id === undefined) this.unlockedOpen.delete(path);
        else this.unlockedOpen.set(path, id);
      })
      .catch(() => this.unlockedOpen.delete(path));
  }

  /** A lock escalation was closed: a later unlocked write of its file is escalated again. */
  escalationClosed(id: EscalationId): void {
    for (const [path, open] of this.unlockedOpen) if (open === id) this.unlockedOpen.delete(path);
  }

  list(): FileLock[] {
    return this.table.list();
  }

  // ---- internals ------------------------------------------------------------------------------------

  /** One try at taking every file of a write; `held` leaves nothing started (T028 r2 P2). */
  private tryWrite(handle: PermissionHandle, decision: PermissionDecision, session: LogicalSession, paths: string[]): LockStep | 'held' {
    const { request } = handle;
    const at = this.options.now();
    const turnId = request.turnId ?? (request.nativeTaskId === undefined ? this.table.turnOf(session.id) : undefined);
    const started: string[] = [];
    const undo = () => {
      for (const path of started) this.table.writeEnded(session.id, path, { kind: 'failed' });
    };
    for (const path of paths) {
      const result = this.table.acquire({ path, sessionId: session.id, ...(turnId !== undefined && { turnId }), at }, toHash(this.options.hashFile(path)));
      if (result.status === 'acquired' || result.status === 'held-by-self') {
        started.push(path);
        continue;
      }
      // The writes already started end as failed before the request waits or is refused, so a change of
      // those files meanwhile is someone else's.
      undo();
      if (result.status === 'changed-since-read') {
        return this.refuse(handle, `AgentWorkflowGui: ${result.path} changed after this session last read it. Read the file again, then make the change.`);
      }
      return 'held';
    }
    const key = itemKey(session.id, request.itemId ?? request.id);
    this.writes.set(key, {
      sessionId: session.id,
      paths: started,
      ...(turnId !== undefined && { turnId }),
      ...(request.nativeTaskId !== undefined && { nativeTaskId: request.nativeTaskId }),
    });
    if (this.answer(handle, decision) === 'approved') return 'approved';
    // The runtime withdrew it meanwhile: nothing will be written.
    this.writes.delete(key);
    undo();
    return 'gone';
  }

  /** Holds a Codex approval until every file can be taken, or refuses and escalates past the limit. */
  private async holdForLock(handle: PermissionHandle, decision: PermissionDecision, session: LogicalSession, paths: string[]): Promise<LockStep> {
    const { request } = handle;
    const since = this.options.now();
    const deadline = later(since, this.options.holdMs ?? DEFAULT_HOLD_MS);
    for (;;) {
      const lock = this.blocking(session.id, paths);
      if (lock === undefined) {
        // Free between two events: try again at once.
      } else {
        if (this.closing) return this.refuse(handle, 'the GUI is closing');
        if (!handle.hold({ reason: 'file-lock', until: deadline, lockPath: lock.path })) return 'gone';
        this.waiting.set(request.id, { sessionId: session.id, path: lock.path });
        const result = await this.table.wait(lock.path, { sessionId: session.id, via: 'codex-approval', permissionRequestId: request.id, since, deadline });
        this.waiting.delete(request.id);
        if (this.closing) return this.refuse(handle, 'the GUI is closing');
        if (result.status === 'cancelled') return this.refuse(handle, 'AgentWorkflowGui: the wait for a file lock was cancelled');
        if (result.status === 'timeout' || result.status === 'deadlock') {
          const step = this.refuse(handle, `AgentWorkflowGui: ${lock.path} is locked by another session; the change was declined and the user was told.`);
          if (step !== 'gone') void this.escalateWait(session.id, lock.path, lock.holderSessionId, result, request.id);
          return step;
        }
      }
      if (Date.parse(this.options.now()) >= Date.parse(deadline)) {
        const step = this.refuse(handle, 'AgentWorkflowGui: the files of this change stayed locked past the wait limit; the change was declined.');
        if (step !== 'gone') void this.escalateWait(session.id, lock?.path ?? paths[0]!, lock?.holderSessionId, { status: 'timeout' }, request.id);
        return step;
      }
      // Free now: every file is taken again, its read check included, as if the request had just come.
      const step = this.tryWrite(handle, decision, session, paths);
      if (step !== 'held') return step;
    }
  }

  private approveRead(handle: PermissionHandle, decision: PermissionDecision, session: LogicalSession): LockStep {
    const { request } = handle;
    const path = request.paths[0];
    if (path === undefined) return this.answer(handle, decision);
    const key = itemKey(session.id, request.itemId!);
    const file = this.key(path, request.cwd ?? session.cwd);
    this.reads.set(key, { path: file, before: this.options.hashFile(file) });
    const step = this.answer(handle, decision);
    if (step !== 'approved') this.reads.delete(key);
    return step;
  }

  private escalateWait(sessionId: SessionId, path: string, holder: SessionId | undefined, result: WaitResult, requestId?: string): Promise<EscalationId | undefined> {
    const deadlock = result.status === 'deadlock';
    return this.options
      .escalate({
        kind: 'lock-timeout',
        sessionId,
        path,
        ...(holder !== undefined && { holderSessionId: holder }),
        title: deadlock ? 'File lock deadlock' : 'File lock wait timed out',
        detail: deadlock
          ? `Waiting for this file would close a cycle of ${String(result.cycle.length)} sessions waiting on each other; the write was refused.`
          : `The file stayed locked past the wait limit; ${requestId !== undefined ? 'the held change was declined' : 'the agent was told to try later'}.`,
      })
      .catch(() => undefined);
  }

  /** The first lock another session holds on these files. */
  private blocking(sessionId: SessionId, paths: string[]): FileLock | undefined {
    const locks = this.table.list();
    for (const path of paths) {
      const lock = locks.find((l) => l.path === path);
      if (lock !== undefined && lock.holderSessionId !== sessionId) return lock;
    }
    return undefined;
  }

  private heldMessage(lock: FileLock): string {
    const holder = this.sessions.get(lock.holderSessionId);
    const who = holder !== undefined && holder.title !== '' ? `session "${holder.title}" (${lock.holderSessionId})` : `session ${lock.holderSessionId}`;
    return (
      `AgentWorkflowGui: ${lock.path} is locked by ${who}, which is still working on it. ` +
      'Call the mcp__gui__wait_for_file tool with this path, and make the change again once it returns free.'
    );
  }

  /** The files a write request names, as lock keys: the item's own list when it was announced (not `grantRoot`). */
  private writePaths(request: PermissionRequest, session: LogicalSession): string[] {
    const cwd = request.cwd ?? session.cwd;
    const announced = request.itemId !== undefined ? this.itemPaths.get(itemKey(session.id, request.itemId)) : undefined;
    return announced ?? [...new Set(request.paths.map((p) => this.key(p, cwd)))];
  }

  private key(path: string, cwd: string): string {
    return lockPath(path, cwd, (p) => this.options.resolveRealPath(p));
  }

  private outcomeNow(path: string): WriteOutcome {
    const state = this.options.hashFile(path);
    if (state === 'missing') return { kind: 'deleted' };
    // Applied but unreadable now: nothing to compare later changes with, so it counts as not applied.
    if (state === 'unreadable') return { kind: 'failed' };
    return { kind: 'written', hash: state };
  }

  private ended(sessionId: SessionId, path: string, outcome: WriteOutcome): void {
    if (outcome.kind === 'written') this.remember(path, outcome.hash);
    else if (outcome.kind === 'deleted') this.remember(path, 'missing');
    this.table.writeEnded(sessionId, path, outcome);
  }

  /** Bounded: the oldest paths are forgotten first (a forgotten one only means its next event is checked). */
  private remember(path: string, state: FileState): void {
    this.seen.delete(path);
    this.seen.set(path, state);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
  }

  private work(sessionId: SessionId): { commands: Set<string>; tasks: Set<string> } {
    let work = this.background.get(sessionId);
    if (work === undefined) {
      work = { commands: new Set(), tasks: new Set() };
      this.background.set(sessionId, work);
    }
    return work;
  }

  /** Same-folder sessions at work (`MemoryLockTable.atWork`) whose folder holds `path`. */
  private suspects(path: string): SessionId[] {
    const out: SessionId[] = [];
    for (const s of this.sessions.values()) {
      if (!s.sameFolder || !isInside(path, s.root)) continue;
      // At work by the same definition that keeps its locks: a turn runs or background work does.
      if (this.table.atWork(s.id)) out.push(s.id);
    }
    return out;
  }

  private release(sessionId: SessionId, reason: 'stopped' | 'runtime-exited' | 'closed'): void {
    for (const [key, write] of [...this.writes]) if (write.sessionId === sessionId) this.writes.delete(key);
    for (const key of [...this.reads.keys()]) if (key.startsWith(`${sessionId}\n`)) this.reads.delete(key);
    this.background.delete(sessionId);
    this.table.releaseAll(sessionId, reason);
  }

  private answer(handle: PermissionHandle, decision: PermissionDecision): LockStep {
    return handle.answer(decision) ? (decision.outcome === 'approve' || decision.outcome === 'approve-for-session' ? 'approved' : 'refused') : 'gone';
  }

  private refuse(handle: PermissionHandle, reason: string): LockStep {
    return handle.answer({ outcome: 'decline', decidedBy: 'policy', reason, at: this.options.now() }) ? 'refused' : 'gone';
  }
}

