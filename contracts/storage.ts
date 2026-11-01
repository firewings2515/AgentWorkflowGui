// Backups and the state of the app's own data (C-28, C-29; V-17, D-16). Backups hold only the app's
// database: never runtime credentials or a runtime's native home.
import { z } from 'zod';
import { BackupId, Timestamp } from './common';
import { addRuleIssue } from './rules';

/** How long automatic backups are kept (user decision 2026-11-01): older ones are deleted, newer never. */
export const BACKUP_RETENTION_DAYS = 30;

/**
 * Why a backup was made. `daily`: the first start of a day. `pre-migration`: before the database schema is
 * changed (always, whatever `daily` did). `pre-restore`: the data in use, saved before a restore replaces it.
 */
export const BackupReason = z.enum(['daily', 'pre-migration', 'pre-restore']);
export type BackupReason = z.infer<typeof BackupReason>;

/**
 * A backup that passed its integrity check after it was written; one that did not is never listed.
 * `storageVersion` is the database schema version it holds (the migration number, not the contracts
 * version): a restored older one is migrated forward at the next start, with its own pre-migration backup.
 */
export const BackupInfo = z.strictObject({
  id: BackupId,
  createdAt: Timestamp,
  reason: BackupReason,
  storageVersion: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

/** A restore the user asked for; it replaces the data at the next start, after its checks pass. */
export const PendingRestore = z.strictObject({ backupId: BackupId, requestedAt: Timestamp });
export type PendingRestore = z.infer<typeof PendingRestore>;

/**
 * Why a restore did not happen at start (the data in use was kept): the backup was gone, failed its
 * integrity check, or holds a schema newer than this app.
 */
export const RestoreFailure = z.enum(['backup-missing', 'integrity-failed', 'newer-schema', 'io-failed']);
export type RestoreFailure = z.infer<typeof RestoreFailure>;

/** What the views show about the app's data besides its status (C-28). */
export const StorageInfo = z
  .strictObject({
    lastBackupAt: Timestamp.optional(),
    pendingRestore: PendingRestore.optional(),
    /** The last start's restore that did not happen, until another restore is asked for. */
    lastRestoreFailure: z.strictObject({ backupId: BackupId, reason: RestoreFailure, at: Timestamp }).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.pendingRestore && s.lastRestoreFailure) addRuleIssue(ctx, 'storage.restore-pending-or-failed');
  });
export type StorageInfo = z.infer<typeof StorageInfo>;

/**
 * Why the data can be read but not written (C-29). `disk-full`: a write failed for lack of space; what was
 * committed before is intact and nothing was half written. `newer-schema`: the database was written by a
 * newer app. `migration-failed`: a schema change failed and was rolled back to the state before it.
 */
export const ReadOnlyReason = z.enum(['disk-full', 'newer-schema', 'migration-failed']);
export type ReadOnlyReason = z.infer<typeof ReadOnlyReason>;
