// Test-only port (T037 r1 P1-2): fault injection for the storage adapter's and the crash tests (T038, T039).
// Not exported from core/ports: production code never imports it.
/**
 * Fault injection: production code never creates one. Each fault applies to the
 * next matching operation, as the real failure would: the transaction rolls back.
 */
export interface StorageFaults {
  /** The next write (or the `n`-th from now) fails with SQLITE_FULL / ENOSPC. */
  failNextWrite(kind: 'disk-full' | 'io', n?: number): void;
  /** Every write waits this long before it runs (a slow disk); 0 turns it off. */
  delayWrites(ms: number): void;
  /** The next migration fails after its first statement. */
  failNextMigration(): void;
}
