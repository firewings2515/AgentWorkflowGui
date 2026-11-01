import type { DatabaseSync } from 'node:sqlite';
import type { StorageFaults } from '../../../core/ports/testing/storage-faults';
import { storageHealth, type StorageHooks } from '../health';

/** Attach only in tests. Failure is injected after rows AND blobs, before commit. */
export class InjectedStorageFaults implements StorageFaults, StorageHooks {
  private remaining = 0;
  private kind: 'disk-full' | 'io' = 'io';
  private delay = 0;
  private migrationPending = false;
  constructor(db?: DatabaseSync) { if (db) storageHealth(db).hooks = this; }
  failNextWrite(kind: 'disk-full' | 'io', n = 1): void {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('fault:write-count');
    this.kind = kind; this.remaining = n;
  }
  delayWrites(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('fault:delay');
    this.delay = ms;
  }
  failNextMigration(): void { this.migrationPending = true; }
  beforeWrite(): void {
    if (this.delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.delay);
  }
  beforeCommit(): void {
    if (this.remaining > 0 && --this.remaining === 0) {
      throw Object.assign(new Error('injected:write'), { code: this.kind === 'disk-full' ? 'ENOSPC' : 'EIO' });
    }
  }
  migration(db: DatabaseSync, sql: string): boolean {
    if (!this.migrationPending) return false;
    this.migrationPending = false;
    const statements = sql.replace(/--[^\n]*/g, '');
    db.exec(statements.slice(0, statements.indexOf(';') + 1));
    throw new Error('injected:migration');
  }
}
