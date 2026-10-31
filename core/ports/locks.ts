// File lock port (T028, R-07, SP-06): same-folder mode only; worktree mode never locks. The lock table
// (T033, `core/locks/`) implements it; the Claude hook, the Codex file-change approval and `wait_for_file`
// use it. **Memory only**: nothing is stored, and a restart starts with no locks (R-07). Checks and changes
// are synchronous so no other caller can slip in between a check and the change it decides.
import type { FileLock, LockWaiter, PayloadHash, SessionId, Timestamp, TurnId } from '../../contracts';

/** A write about to happen: the file, the session and its turn. Paths are compared as `FileLock.path`. */
export interface LockRequest {
  path: string;
  sessionId: SessionId;
  turnId?: TurnId;
  at: Timestamp;
}

/**
 * `acquired` / `held-by-self`: write. `held`: someone else holds it; `lock` says who. `changed-since-read`: the
 * file differs from what this session last read (SP-06 W4); the write is refused and the agent must read again.
 */
export type AcquireResult =
  | { status: 'acquired' | 'held-by-self'; lock: FileLock }
  | { status: 'held'; lock: FileLock }
  | { status: 'changed-since-read'; path: string };

/** How a wait ended. `deadlock`: waiting would close a cycle of sessions waiting on each other. */
export type WaitResult = { status: 'free' } | { status: 'not-locked' } | { status: 'timeout' } | { status: 'deadlock'; cycle: SessionId[] } | { status: 'cancelled' };

/** Why every lock of a session goes: it stopped, its runtime exited, or the session was closed. */
export type ReleaseReason = 'stopped' | 'runtime-exited' | 'closed';

export interface FileLockTable {
  /** Takes the lock for a write, after checking the session's read of the file against `currentHash`. */
  acquire(request: LockRequest, currentHash: PayloadHash | undefined): AcquireResult;
  /**
   * Waits for `path` to be free, as `waiter` (a held Codex approval, or `wait_for_file`). Resolves at the
   * waiter's deadline at the latest; the caller then refuses the write and escalates to root (R-07).
   */
  wait(path: string, waiter: LockWaiter): Promise<WaitResult>;
  /** The holder's write completed: the file's hash now, to spot a later write by someone else (SP-06 W5). */
  recordWrite(sessionId: SessionId, path: string, hash: PayloadHash): void;
  /** The session read the file (PostToolUse): its hash then, checked by its next `acquire` (SP-06 W4). */
  recordRead(sessionId: SessionId, path: string, hash: PayloadHash): void;
  /** A turn ended; its locks go once the session also has no background command running (SP-06 W3). */
  turnEnded(sessionId: SessionId, turnId: TurnId | undefined): void;
  /** How many background commands of the session still run; at 0 after its turn ended, its locks go. */
  backgroundCommands(sessionId: SessionId, running: number): void;
  releaseAll(sessionId: SessionId, reason: ReleaseReason): void;
  /** The file changed on disk; true when its holder had no write in progress (an unlocked write, escalated). */
  fileChanged(path: string, hash: PayloadHash | undefined): boolean;
  list(): FileLock[];
  /** Called with every lock after each change, for the `locks.updated` event. */
  subscribe(listener: (locks: FileLock[]) => void): () => void;
}
