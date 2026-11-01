import type { DatabaseSync } from 'node:sqlite';
import type { ReadOnlyReason } from '../../contracts';
import { StorageReadOnlyError, StorageWriteError, type StorageHealth, type StorageState } from '../../core/ports/storage';

/** Hooks have no implementation in production; only testing/ installs them. */
export interface StorageHooks {
  beforeWrite(): void;
  beforeCommit(): void;
  migration(db: DatabaseSync, sql: string): boolean;
}

export class DatabaseHealth implements StorageHealth {
  /** Adapter diagnostic only; never includes SQL or data. */
  failedMigrationVersion?: number | undefined;
  private current: StorageState = { status: 'ready' };
  private readonly listeners = new Set<(reason: ReadOnlyReason) => void>();
  hooks?: StorageHooks;
  state(): StorageState { return { ...this.current }; }
  onReadOnly(listener: (reason: ReadOnlyReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  assertWritable(): void {
    if (this.current.status === 'read-only') throw new StorageReadOnlyError(this.current.reason);
  }
  makeReadOnly(reason: ReadOnlyReason): void {
    if (this.current.status === 'read-only') return;
    this.current = { status: 'read-only', reason };
    for (const listener of this.listeners) {
      try { listener(reason); } catch { /* Observers cannot change a transaction's outcome. */ }
    }
  }
}

const states = new WeakMap<DatabaseSync, DatabaseHealth>();
export const storageHealth = (db: DatabaseSync): DatabaseHealth => {
  let health = states.get(db);
  if (!health) { health = new DatabaseHealth(); states.set(db, health); }
  return health;
};

export const isDiskFull = (error: unknown): boolean => {
  if (error instanceof StorageWriteError) return error.kind === 'disk-full';
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; errcode?: unknown };
  return e.code === 'ENOSPC' || e.code === 'SQLITE_FULL' || (typeof e.errcode === 'number' && (e.errcode & 255) === 13);
};

export const writeFailure = (db: DatabaseSync, error: unknown): unknown => {
  if (isDiskFull(error)) {
    storageHealth(db).makeReadOnly('disk-full');
    return causedWriteError('disk-full', 'storage:disk-full', error);
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: string; errcode?: number };
    if (/^(SQLITE_IOERR(?:_.*)?|SQLITE_CANTOPEN(?:_.*)?|EIO|EACCES|EPERM|EROFS)$/.test(e.code ?? '') ||
      (typeof e.errcode === 'number' && [10, 14].includes(e.errcode & 255))) {
      return causedWriteError('io', 'storage:io', error);
    }
  }
  return error;
};

/** Match native Error.cause: available for diagnostics, omitted from JSON reports. */
export const causedWriteError = (kind: 'disk-full' | 'io', message: string, cause: unknown): StorageWriteError =>
  Object.defineProperty(new StorageWriteError(kind, message), 'cause', { value: cause, configurable: true, writable: true });
