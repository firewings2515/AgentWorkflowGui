import { randomUUID } from 'node:crypto';
import { copyFileSync, renameSync, unlinkSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Timestamp, type RestoreFailure } from '../../contracts';
import type { StorageStartReport, StorageState } from '../../core/ports/storage';
import { preserveDamagedDatabase, schemaVersion, SqliteBackupStore, syncFile, verifyDatabase } from './backups';
import { isDiskFull, storageHealth, type StorageHooks } from './health';
import { latestVersion, MIGRATIONS, migrate, type Migration } from './migrations';

export interface OpenStorageOptions {
  now?: Timestamp;
  busyTimeoutMs?: number;
  /** Alternate migration sequence / hooks are for adapter tests. Production omits both. */
  migrations?: readonly Migration[];
  hooks?: StorageHooks;
}

/** Safe adapter diagnostics; ports/contracts remain unchanged. */
export interface AdapterStartReport extends StorageStartReport {
  backupFailures: { operation: 'catalog' | 'cleanup' | 'daily' | 'prune'; reason: 'disk-full' | 'io' }[];
  catalogRecovered?: boolean;
  failedMigrationVersion?: number;
}

/** No readable database can be returned. A restore failure is already persisted in the catalog. */
export class StorageOpenError extends Error {
  override name = 'StorageOpenError';
  constructor(readonly report: AdapterStartReport, cause: unknown) { super('storage:open-failed', { cause }); }
}

/** Call before constructing repositories or dispatching anything. No runtime home is ever accessed. */
export const openStorage = async (path: string, options: OpenStorageOptions = {}) => {
  const now = options.now ?? Timestamp.parse(new Date().toISOString());
  Timestamp.parse(now);
  const migrations = options.migrations ?? MIGRATIONS;
  const report: AdapterStartReport = { backupsMade: [], pruned: [], state: { status: 'ready' }, backupFailures: [] };
  const auxiliaryFailure = (operation: AdapterStartReport['backupFailures'][number]['operation'], error: unknown) => {
    report.backupFailures.push({ operation, reason: isDiskFull(error) ? 'disk-full' : 'io' });
  };
  const connect = (readOnly = false) => {
    const connection = new DatabaseSync(path, { readOnly });
    try {
      connection.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000)));
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec('PRAGMA synchronous = FULL');
      if (options.hooks) storageHealth(connection).hooks = options.hooks;
      return connection;
    } catch (error) { connection.close(); throw error; }
  };
  let db: DatabaseSync | undefined;
  const database = (): DatabaseSync => { if (!db) throw new Error('storage:closed'); return db; };
  const closeDatabase = () => { if (db) { db.close(); db = undefined; } };
  const mainIsDamaged = (): boolean => {
    // Even a read-only SQLite open can rebuild SHM. Inspect an isolated copy so a damaged database
    // family is preserved byte-for-byte. Startup owns these files; no other connection may be active.
    const probe = join(dirname(path), '.restore-' + randomUUID() + '.sqlite');
    try {
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) copyFileSync(path + suffix, probe + suffix);
      try { verifyDatabase(probe); return false; } catch { return true; }
    } finally {
      for (const suffix of ['-wal', '-shm', '']) if (existsSync(probe + suffix)) unlinkSync(probe + suffix);
    }
  };
  // Catalog access precedes any attempt to open the potentially damaged main database.
  const backups = new SqliteBackupStore(join(dirname(path), 'backups'), database);
  if (backups.startupFailure) auxiliaryFailure('catalog', backups.startupFailure);
  if (backups.catalogRecovered) report.catalogRecovered = true;
  try {
    try {
      for (const name of readdirSync(dirname(path))) {
        if (!/^\.restore-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.sqlite(?:-wal|-shm)?$/.test(name)) continue;
        const file = join(dirname(path), name);
        if (lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) unlinkSync(file);
      }
    } catch (error) { auxiliaryFailure('cleanup', error); }
    const pending = (await backups.info()).pendingRestore;
    if (pending) {
      let failure: RestoreFailure | undefined;
      let stage: string | undefined;
      let undoPreservation: (() => void) | undefined;
      try {
        if (!backups.hasFile(pending.backupId)) failure = 'backup-missing';
        else {
          stage = join(dirname(path), '.restore-' + randomUUID() + '.sqlite');
          copyFileSync(backups.file(pending.backupId), stage);
          let version: number | undefined;
          try { version = verifyDatabase(stage, true); } catch { failure = 'integrity-failed'; }
          if (version !== undefined && version > latestVersion(migrations)) failure = 'newer-schema';
          if (!failure) {
            syncFile(stage);
            let damaged = false;
            if (existsSync(path)) {
              damaged = mainIsDamaged();
              if (!damaged) {
                try { db = connect(); } catch { damaged = true; }
              }
              if (!damaged) {
                // A failure to back up a readable DB must still abort restoration.
                report.backupsMade.push(await backups.create('pre-restore', now));
                const checkpoint = database().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
                if (checkpoint?.busy !== undefined && checkpoint.busy !== 0) throw new Error('restore:busy');
                closeDatabase();
              }
            }
            if (damaged) undoPreservation = preserveDamagedDatabase(path);
            else {
              // All handles are closed. Only this database's exact sidecar paths are touched.
              for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) unlinkSync(path + suffix);
            }
            renameSync(stage, path); stage = undefined; report.restored = pending.backupId;
            undoPreservation = undefined;
          }
        }
      } catch (error) {
        if (report.restored) throw error;
        undoPreservation?.();
        failure = 'io-failed';
      } finally {
        if (stage && existsSync(stage)) {
          try { unlinkSync(stage); } catch (error) { auxiliaryFailure('cleanup', error); }
        }
      }
      if (failure) {
        report.restoreFailure = { backupId: pending.backupId, reason: failure };
        backups.finishRestore({ ...report.restoreFailure, at: now });
      } else backups.finishRestore();
    }
    // A rejected candidate must not cause SQLite to touch the damaged original's sidecars either.
    if (report.restoreFailure && !db && existsSync(path) && mainIsDamaged()) throw new Error('storage:damaged');
    db ??= connect();
    if (isDiskFull(backups.startupFailure)) storageHealth(db).makeReadOnly('disk-full');
    // Never inspect schemaVersion on the damaged original before a pending restore.
    const current = schemaVersion(db);
    let state: StorageState = storageHealth(db).state();
    if (current > latestVersion(migrations)) state = { status: 'read-only', reason: 'newer-schema' };
    if (state.status === 'ready' && current < latestVersion(migrations)) {
      try {
        report.backupsMade.push(await backups.create('pre-migration', now));
        migrate(db, migrations);
      } catch {
        const health = storageHealth(db);
        if (health.failedMigrationVersion !== undefined) report.failedMigrationVersion = health.failedMigrationVersion;
        const healthState = health.state();
        state = healthState.status === 'read-only' ? healthState : { status: 'read-only', reason: 'migration-failed' };
      }
    }
    if (state.status === 'read-only') {
      closeDatabase(); db = connect(true); storageHealth(db).makeReadOnly(state.reason);
      storageHealth(db).failedMigrationVersion = report.failedMigrationVersion;
    } else {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      const day = (at: string) => {
        const date = new Date(at);
        return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
      };
      let dailyFailed = false;
      try {
        if (!(await backups.list()).some((b) => b.reason === 'daily' && day(b.createdAt) === day(now))) {
          report.backupsMade.push(await backups.create('daily', now));
        }
      } catch (error) { dailyFailed = true; auxiliaryFailure('daily', error); }
      if (!dailyFailed) {
        try { report.pruned = await backups.prune(now); }
        catch (error) { auxiliaryFailure('prune', error); }
      }
    }
    report.state = storageHealth(db).state();
    let closed = false;
    return { db, report, health: storageHealth(db), backups, close: () => {
      if (closed) return;
      closed = true;
      try { backups.close(); } finally { closeDatabase(); }
    } };
  } catch (error) {
    try { backups.close(); } finally { closeDatabase(); }
    throw new StorageOpenError(report, error);
  }
};
