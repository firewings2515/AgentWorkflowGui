// Transactions on the app database (T007). Every write is one `BEGIN IMMEDIATE` transaction, so the
// conditional updates inside it cannot race another connection (CR2_DELIVERY_FIX §1).
import type { DatabaseSync } from 'node:sqlite';
import { CommitUncertainError } from '../../core/ports';

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
 * Runs `body` in one `BEGIN IMMEDIATE` transaction. An error before COMMIT rolls back and is rethrown as
 * it is: nothing was committed. An error from COMMIT itself means the outcome cannot be confirmed, so it
 * becomes `CommitUncertainError` and the caller must not act on the transaction (CR2_DELIVERY_FIX §1).
 */
export const writeTransaction = <T>(db: DatabaseSync, body: () => Outcome<T>): T => {
  db.exec('BEGIN IMMEDIATE');
  let outcome: Outcome<T>;
  try {
    outcome = body();
  } catch (error) {
    rollback(db);
    throw error;
  }
  if (!outcome.commit) {
    rollback(db);
    return outcome.value;
  }
  try {
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw new CommitUncertainError(`commit could not be confirmed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
