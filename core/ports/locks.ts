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

/**
 * How a write that `acquire` started ended (T028 r1 P1-4): `written` with the file's hash now, `deleted` when
 * the file is gone, `failed` when nothing was applied (refused, cancelled, the tool failed or its turn was
 * interrupted). Only then is the holder no longer writing, so a later change of the file is someone else's.
 */
export type WriteOutcome = { kind: 'written'; hash: PayloadHash } | { kind: 'deleted' } | { kind: 'failed' };

export interface FileLockTable {
  /**
   * Takes the lock for a write, after checking the session's read of the file against `currentHash`
   * (`undefined`: the file does not exist). `acquired` / `held-by-self` also start one write in progress,
   * which `writeEnded` ends exactly once; while any is in progress the holder's own changes are expected.
   * Codex's file-change approval names every file of the change: each is acquired and ended on its own. When
   * one of them is `held`, the writes already started for the others are ended as `failed` before the
   * request waits or is refused (so a change to those files meanwhile is someone else's), and every file is
   * acquired again, read check included, once the request may go (T028 r2 P2). A tool that failed after
   * writing some files ends each file with what it actually left.
   */
  acquire(request: LockRequest, currentHash: PayloadHash | undefined): AcquireResult;
  /** Ends one write `acquire` started for this session and file. */
  writeEnded(sessionId: SessionId, path: string, outcome: WriteOutcome): void;
  /**
   * Waits for `path` to be free, as `waiter` (a held Codex approval, or `wait_for_file`). Resolves at the
   * waiter's deadline at the latest; the caller then refuses the write and escalates to root (R-07).
   */
  wait(path: string, waiter: LockWaiter): Promise<WaitResult>;
  /** The session read the file (PostToolUse): its hash then, checked by its next `acquire` (SP-06 W4). */
  recordRead(sessionId: SessionId, path: string, hash: PayloadHash): void;
  /** A turn ended; its locks go once the session also has no background command running (SP-06 W3). */
  turnEnded(sessionId: SessionId, turnId: TurnId | undefined): void;
  /** How many background commands of the session still run; at 0 after its turn ended, its locks go. */
  backgroundCommands(sessionId: SessionId, running: number): void;
  /** Ends the session's writes in progress as `failed` and releases its locks. */
  releaseAll(sessionId: SessionId, reason: ReleaseReason): void;
  /**
   * The file changed on disk (`undefined`: deleted). True when it is an unlocked write, escalated to root: no
   * write is in progress for it, and it differs from what its holder's last write left (`FileLock.lastWrite`),
   * or it is not locked at all in same-folder mode (R-07, SP-06 W5).
   */
  fileChanged(path: string, hash: PayloadHash | undefined): boolean;
  list(): FileLock[];
  /** Called with every lock after each change, for the `locks.updated` event. */
  subscribe(listener: (locks: FileLock[]) => void): () => void;
}
