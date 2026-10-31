// The file lock table of same-folder mode (T033, R-07, SP-06), the `FileLockTable` port's implementation.
// Memory only: a restart starts with no locks. Every method but `wait` is synchronous, so a check and the
// change it decides happen with nothing in between: two sessions can never both hold one path.
import type { FileLock, LockWaiter, PayloadHash, SessionId, Timestamp, TurnId } from '../../contracts';
import type { AcquireResult, FileLockTable, LockRequest, ReleaseReason, WaitResult, WriteOutcome } from '../ports';

export interface LockTableOptions {
  now(): Timestamp;
  /** Runs `fn` after `ms` (core has no timers of its own); returns what cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
  /**
   * Whether a path no lock covers is in same-folder mode (`fileChanged`): inside the folder of a
   * same-folder session that is at work. Defaults to no.
   */
  inSameFolderScope?(path: string): boolean;
  log?(message: string): void;
}

/** One session's wait for one path; a second wait of the same session joins it (waiters are distinct). */
interface Wait {
  waiter: LockWaiter;
  listeners: ((result: WaitResult) => void)[];
  cancelTimer: () => void;
}

interface Entry {
  path: string;
  holderSessionId: SessionId;
  holderTurnId?: TurnId;
  acquiredAt: Timestamp;
  waitingForBackground: boolean;
  writing: number;
  lastWrite?: FileLock['lastWrite'];
  waits: Wait[];
}

interface SessionState {
  /** In a turn that has not been seen to end: its locks stay. */
  inTurn: boolean;
  /** The turn the session's last acquire named, when it named one. */
  turnId?: TurnId;
  /** Turns seen to end, so a late acquire naming one does not reopen it. */
  endedTurns: TurnId[];
  /** Background work still running (SP-06 W3). */
  background: number;
  /** What the session last read or wrote of each path (SP-06 W4). */
  reads: Map<string, PayloadHash>;
}

export class MemoryLockTable implements FileLockTable {
  private readonly locks = new Map<string, Entry>();
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly listeners = new Set<(locks: FileLock[]) => void>();

  constructor(private readonly options: LockTableOptions) {}

  acquire(request: LockRequest, currentHash: PayloadHash | undefined): AcquireResult {
    const { path, sessionId, turnId } = request;
    const lock = this.locks.get(path);
    if (lock !== undefined && lock.holderSessionId !== sessionId) return { status: 'held', lock: view(lock) };
    const state = this.state(sessionId);
    const read = state.reads.get(path);
    // A read recorded and the file no longer what was read: refused before anything is taken.
    if (read !== undefined && read !== currentHash) return { status: 'changed-since-read', path };
    if (turnId !== undefined && !state.endedTurns.includes(turnId)) {
      state.inTurn = true;
      state.turnId = turnId;
    }
    let status: 'acquired' | 'held-by-self' = 'held-by-self';
    let entry = lock;
    if (entry === undefined) {
      status = 'acquired';
      entry = { path, holderSessionId: sessionId, ...(turnId !== undefined && { holderTurnId: turnId }), acquiredAt: request.at, waitingForBackground: false, writing: 0, waits: [] };
      this.locks.set(path, entry);
    } else if (turnId !== undefined && state.inTurn && entry.holderTurnId !== turnId) {
      // Held on from an earlier turn's background work: the new turn holds it now.
      entry.holderTurnId = turnId;
    }
    entry.waitingForBackground = false;
    entry.writing += 1;
    this.changed();
    return { status, lock: view(entry) };
  }

  writeEnded(sessionId: SessionId, path: string, outcome: WriteOutcome): void {
    const lock = this.locks.get(path);
    if (lock === undefined || lock.holderSessionId !== sessionId || lock.writing === 0) {
      this.options.log?.(`[locks] a write of ${sessionId} ended that was not in progress`);
      return;
    }
    lock.writing -= 1;
    const reads = this.state(sessionId).reads;
    if (outcome.kind === 'written') {
      lock.lastWrite = { kind: 'written', hash: outcome.hash };
      // The holder knows what it wrote: its next write checks against this, not its older read.
      reads.set(path, outcome.hash);
    } else if (outcome.kind === 'deleted') {
      lock.lastWrite = { kind: 'deleted' };
      reads.delete(path);
    }
    this.releaseIfDone(sessionId);
    this.changed();
  }

  wait(path: string, waiter: LockWaiter): Promise<WaitResult> {
    const lock = this.locks.get(path);
    if (lock === undefined) return Promise.resolve({ status: 'not-locked' });
    if (lock.holderSessionId === waiter.sessionId) return Promise.resolve({ status: 'free' });
    const cycle = this.cycleThrough(waiter.sessionId, lock.holderSessionId);
    if (cycle !== undefined) return Promise.resolve({ status: 'deadlock', cycle });
    const remaining = Date.parse(waiter.deadline) - Date.parse(this.options.now());
    if (!(remaining > 0)) return Promise.resolve({ status: 'timeout' });
    return new Promise<WaitResult>((resolve) => {
      const joined = lock.waits.find((w) => w.waiter.sessionId === waiter.sessionId);
      if (joined !== undefined) {
        joined.listeners.push(resolve);
        return;
      }
      const wait: Wait = { waiter, listeners: [resolve], cancelTimer: () => undefined };
      lock.waits.push(wait);
      wait.cancelTimer = this.options.setTimer(remaining, () => {
        this.endWait(path, wait, { status: 'timeout' });
        this.changed();
      });
      this.changed();
    });
  }

  /** Ends the session's waits (for `path`, or all) as `cancelled`: its request went, or its call was aborted. */
  cancelWait(sessionId: SessionId, path?: string): void {
    let any = false;
    for (const lock of this.locks.values()) {
      if (path !== undefined && lock.path !== path) continue;
      for (const wait of lock.waits.filter((w) => w.waiter.sessionId === sessionId)) {
        this.endWait(lock.path, wait, { status: 'cancelled' });
        any = true;
      }
    }
    if (any) this.changed();
  }

  recordRead(sessionId: SessionId, path: string, hash: PayloadHash): void {
    this.state(sessionId).reads.set(path, hash);
  }

  turnEnded(sessionId: SessionId, turnId: TurnId | undefined): void {
    const state = this.state(sessionId);
    if (turnId !== undefined) {
      state.endedTurns = [...state.endedTurns.filter((t) => t !== turnId), turnId].slice(-50);
      // The end of another, older turn than the one writing now changes nothing.
      if (state.turnId !== undefined && state.turnId !== turnId) return;
    }
    state.inTurn = false;
    this.releaseIfDone(sessionId);
    this.changed();
  }

  backgroundCommands(sessionId: SessionId, running: number): void {
    const state = this.state(sessionId);
    state.background = Math.max(0, running);
    this.releaseIfDone(sessionId);
    this.changed();
  }

  releaseAll(sessionId: SessionId, reason: ReleaseReason): void {
    let held = 0;
    for (const lock of [...this.locks.values()]) {
      for (const wait of lock.waits.filter((w) => w.waiter.sessionId === sessionId)) this.endWait(lock.path, wait, { status: 'cancelled' });
      if (lock.holderSessionId !== sessionId) continue;
      // Its writes in progress end as failed: nothing more of them is expected.
      lock.writing = 0;
      this.release(lock);
      held += 1;
    }
    this.sessions.delete(sessionId);
    if (held > 0) this.options.log?.(`[locks] released ${String(held)} lock(s) of ${sessionId} (${reason})`);
    this.changed();
  }

  fileChanged(path: string, hash: PayloadHash | undefined): boolean {
    const lock = this.locks.get(path);
    if (lock === undefined) return this.options.inSameFolderScope?.(path) ?? false;
    if (lock.writing > 0) return false;
    const last = lock.lastWrite;
    if (last === undefined) return true;
    return last.kind === 'written' ? hash !== last.hash : hash !== undefined;
  }

  list(): FileLock[] {
    return [...this.locks.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(view);
  }

  subscribe(listener: (locks: FileLock[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether the session holds any lock (it is at work, for the same-folder scope). */
  holdsAny(sessionId: SessionId): boolean {
    for (const lock of this.locks.values()) if (lock.holderSessionId === sessionId) return true;
    return false;
  }

  private state(sessionId: SessionId): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { inTurn: false, endedTurns: [], background: 0, reads: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Releases the session's locks once its turn ended and its background work too (SP-06 W3). */
  private releaseIfDone(sessionId: SessionId): void {
    const state = this.state(sessionId);
    if (state.inTurn) return;
    for (const lock of [...this.locks.values()]) {
      if (lock.holderSessionId !== sessionId) continue;
      // A write still in progress keeps its lock until it ended (e.g. a sub-agent's, after the turn).
      if (state.background > 0 || lock.writing > 0) lock.waitingForBackground = state.background > 0;
      else this.release(lock);
    }
  }

  private release(lock: Entry): void {
    this.locks.delete(lock.path);
    for (const wait of [...lock.waits]) this.endWait(lock.path, wait, { status: 'free' }, lock);
  }

  private endWait(path: string, wait: Wait, result: WaitResult, from?: Entry): void {
    const lock = from ?? this.locks.get(path);
    if (lock !== undefined) lock.waits = lock.waits.filter((w) => w !== wait);
    wait.cancelTimer();
    for (const listener of wait.listeners) listener(result);
    wait.listeners = [];
  }

  /**
   * The sessions in the cycle that `waiter` waiting for `holder` would close, if any: `holder` waits (through
   * other holders) for a lock `waiter` holds.
   */
  private cycleThrough(waiter: SessionId, holder: SessionId): SessionId[] | undefined {
    const waitsFor = new Map<SessionId, SessionId[]>();
    for (const lock of this.locks.values()) {
      for (const w of lock.waits) waitsFor.set(w.waiter.sessionId, [...(waitsFor.get(w.waiter.sessionId) ?? []), lock.holderSessionId]);
    }
    const seen = new Set<SessionId>();
    // `trail`: the sessions from `holder` to `at`; the cycle is the waiter followed by the trail.
    const walk = (at: SessionId, trail: SessionId[]): SessionId[] | undefined => {
      if (seen.has(at)) return undefined;
      seen.add(at);
      for (const next of waitsFor.get(at) ?? []) {
        if (next === waiter) return [waiter, ...trail];
        const found = walk(next, [...trail, next]);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(holder, [holder]);
  }

  private changed(): void {
    const locks = this.list();
    for (const listener of this.listeners) {
      try {
        listener(locks);
      } catch {
        this.options.log?.('[locks] a lock listener threw');
      }
    }
  }
}

const view = (lock: Entry): FileLock => ({
  path: lock.path,
  holderSessionId: lock.holderSessionId,
  ...(lock.holderTurnId !== undefined && { holderTurnId: lock.holderTurnId }),
  acquiredAt: lock.acquiredAt,
  waitingForBackground: lock.waitingForBackground,
  writing: lock.writing,
  ...(lock.lastWrite !== undefined && { lastWrite: lock.lastWrite }),
  waiters: lock.waits.map((w) => w.waiter),
});
