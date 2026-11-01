// Storage ports of contracts 0.7 (T037): backups and restores, read-only mode, and how a write failure is
// classified (C-28, C-29; V-17). The storage adapter (T038) implements them; the main process (T040) uses them.
import type { BackupId, BackupInfo, BackupReason, ReadOnlyReason, RestoreFailure, StorageInfo, Timestamp } from '../../contracts';

/**
 * The app's backups. Only the app's database is backed up, consistently (WAL included, never a copy of a
 * database in use), into the app's own backup folder; nothing of a runtime's credentials or native home.
 */
export interface BackupStore {
  /** Verified backups, newest first. A backup that failed its integrity check is never listed. */
  list(): Promise<BackupInfo[]>;
  /** Makes a backup now; resolves once it is written and verified. Throws `StorageWriteError` when it cannot. */
  create(reason: BackupReason, at: Timestamp): Promise<BackupInfo>;
  /**
   * Deletes backups older than BACKUP_RETENTION_DAYS before `now`, only files this store made and listed;
   * newer ones are never deleted, however many there are. Returns what was deleted.
   */
  prune(now: Timestamp): Promise<BackupId[]>;
  /** Asks for a restore at the next start; a later call replaces it. */
  scheduleRestore(id: BackupId, at: Timestamp): Promise<'scheduled' | 'not-found'>;
  cancelRestore(): Promise<void>;
  info(): Promise<StorageInfo>;
}

/**
 * What opening the data at start did (C-28, C-29), in order: a pending restore was applied or failed (the data
 * in use kept, `pre-restore` backed up first), pending migrations ran after a `pre-migration` backup, the day's
 * `daily` backup was made, old backups were pruned.
 */
export interface StorageStartReport {
  restored?: BackupId;
  restoreFailure?: { backupId: BackupId; reason: RestoreFailure };
  backupsMade: BackupInfo[];
  pruned: BackupId[];
  state: StorageState;
}

export type StorageState = { status: 'ready' } | { status: 'read-only'; reason: ReadOnlyReason };

/**
 * Whether the data can be written now. It turns `read-only` when a write fails for lack of space (and stays so
 * until a restart), or opens that way; it never turns back to `ready` while the app runs. A write refused in
 * read-only mode throws `StorageReadOnlyError` and changes nothing.
 */
export interface StorageHealth {
  state(): StorageState;
  /** Called once, when the data turns read-only while the app runs. Returns the function that unsubscribes. */
  onReadOnly(listener: (reason: ReadOnlyReason) => void): () => void;
}

/**
 * A write that did not commit, classified (C-29). `disk-full`: SQLITE_FULL or ENOSPC; the transaction rolled
 * back, nothing of it is stored (a blob and its row are in one transaction), and the data is read-only now.
 * `io`: any other failure; the caller treats the write as not done.
 */
export class StorageWriteError extends Error {
  override name = 'StorageWriteError';
  constructor(
    readonly kind: 'disk-full' | 'io',
    message: string,
  ) {
    super(message);
  }
}

/** A write refused because the data is read-only; nothing was attempted. */
export class StorageReadOnlyError extends Error {
  override name = 'StorageReadOnlyError';
  constructor(readonly reason: ReadOnlyReason) {
    super(`The data is read-only (${reason})`);
  }
}
