// The SQLite connection (T007, IMPLEMENTATION_DRAFT §5, D-05). One GUI main process is the single writer;
// every write is one `BEGIN IMMEDIATE` transaction (transaction.ts). Uses only the `node:sqlite` API
// shared by the system Node that runs the tests (22.x) and Electron's Node (24.x): no constructor
// `timeout` (ignored on 22.x) and no `isTransaction` (missing on 22.x).
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations';

export interface OpenDatabaseOptions {
  /** How long a writer waits for another connection's lock before failing; default 5000 ms. */
  busyTimeoutMs?: number;
}

/** Opens (creating when missing) and migrates the app database at `path`, or `:memory:`. */
export const openDatabase = (path: string, options: OpenDatabaseOptions = {}): DatabaseSync => {
  const db = new DatabaseSync(path);
  try {
    // busy_timeout first, so the pragmas and the migration below already wait for other connections.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    db.exec('PRAGMA journal_mode = WAL');
    // FULL: a committed claim survives power loss before the runtime is called (CR-2).
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
