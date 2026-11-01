// Transactions on the app database (T007). Every write is one `BEGIN IMMEDIATE` transaction, so the
// conditional updates inside it cannot race another connection (CR2_DELIVERY_FIX §1).
import type { DatabaseSync } from 'node:sqlite';
import { CommitUncertainError } from '../../core/ports';
import { isDiskFull, storageHealth, writeFailure } from './health';

/** What a transaction body returns: commit its writes, or roll back because it wrote nothing. */
export type Outcome<T> = { value: T; commit: boolean };
export const committed = <T>(value: T): Outcome<T> => ({ value, commit: true });
export const unchanged = <T>(value: T): Outcome<T> => ({ value, commit: false });

const rollback = (db: DatabaseSync) => {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Some errors (SQLITE_FULL, I/O errors) already rolled the transaction back.
  }
};

/**
 * Runs `body` in one `BEGIN IMMEDIATE` transaction. Pre-commit SQLite/I/O errors are classified after
 * rollback; domain validation errors retain their safe rule codes. SQLITE_FULL also latches read-only.
 * Other COMMIT errors retain CR-2's uncertain-outcome semantics: callers must not dispatch or resend.
 */
export const writeTransaction = <T>(db: DatabaseSync, body: () => Outcome<T>): T => {
  const health = storageHealth(db);
  health.assertWritable();
  health.hooks?.beforeWrite();
  let outcome: Outcome<T>;
  try {
    db.exec('BEGIN IMMEDIATE');
    outcome = body();
    if (outcome.commit) health.hooks?.beforeCommit();
  } catch (error) {
    rollback(db);
    throw writeFailure(db, error);
  }
  if (!outcome.commit) {
    rollback(db);
    return outcome.value;
  }
  try {
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    if (isDiskFull(error)) throw writeFailure(db, error);
    throw new CommitUncertainError('storage:commit-uncertain', { cause: error });
  }
  return outcome.value;
};

/** Runs `body` on one consistent snapshot; it must not write. */
export const readTransaction = <T>(db: DatabaseSync, body: () => T): T => {
  db.exec('BEGIN');
  try {
    return body();
  } finally {
    rollback(db);
  }
};
