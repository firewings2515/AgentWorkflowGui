import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKUP_RETENTION_DAYS, BackupInfo, BackupReason, StorageInfo, Timestamp, type BackupId } from '../../contracts';
import { StorageWriteError, type BackupStore } from '../../core/ports/storage';
import { readRecord, run, StoredDataError } from './codec';
import { causedWriteError, isDiskFull, storageHealth } from './health';
import { readTransaction } from './transaction';

export const schemaVersion = (db: DatabaseSync): number => {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migration'").get()) return 0;
  const version = db.prepare('SELECT max(version) AS version FROM schema_migration').get()?.version ?? 0;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new StoredDataError('schema_migration', ['version:invalid']);
  return version;
};

export const verifyDatabase = (path: string, requireStorageSchema = false): number => {
  if (requireStorageSchema && statSync(path).size === 0) throw new StoredDataError('backup', ['file:empty']);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (requireStorageSchema && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migration'").get()) {
      throw new StoredDataError('backup', ['schema:missing']);
    }
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
      throw new StoredDataError('backup', ['integrity:failed']);
    }
    return schemaVersion(db);
  } finally { db.close(); }
};

export const syncFile = (path: string): void => {
  // Windows FlushFileBuffers requires a write-capable handle, even when no bytes are changed.
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** Never follow a link out of the app-owned backup directory. */
const regularFile = (path: string): boolean => {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return false; throw error; }
};

const backupName = /^backup-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.sqlite$/;

/** Preserve the exact database family, closing all handles before calling. Undo partial moves on error. */
export const preserveDamagedDatabase = (path: string): (() => void) => {
  const suffix = `.damaged-${Date.now()}-${randomUUID()}`;
  const moved: [string, string][] = [];
  const undo = () => { for (const [source, target] of [...moved].reverse()) renameSync(target, source); };
  try {
    for (const sidecar of ['', '-wal', '-shm']) {
      const source = path + sidecar;
      if (!existsSync(source)) continue;
      const target = source + suffix;
      renameSync(source, target); moved.push([source, target]);
    }
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
};

const isCorruption = (error: unknown): boolean => {
  const e = error as { errcode?: number; code?: string };
  return error instanceof StoredDataError || [11, 26].includes((e?.errcode ?? 0) & 255) ||
    /^(SQLITE_CORRUPT|SQLITE_NOTADB)/.test(e?.code ?? '');
};

/** Metadata lives in its own SQLite database, so restoring (or losing) app.sqlite cannot lose it.
 * Each port call uses one catalog transaction. VACUUM INTO supplies the main database's consistent read.
 */
export class SqliteBackupStore implements BackupStore {
  private readonly catalog: DatabaseSync;
  readonly catalogRecovered: boolean;
  /** An unavailable auxiliary directory must not prevent opening a healthy current schema. */
  readonly startupFailure?: unknown;
  constructor(readonly directory: string, private readonly database: () => DatabaseSync) {
    const initialize = (catalog: DatabaseSync) => catalog.exec(`PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS backup (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS info (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL) STRICT;`);
    let catalog: DatabaseSync | undefined;
    let recovered = false;
    try {
      mkdirSync(directory, { recursive: true });
      const folder = lstatSync(directory);
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw new StoredDataError('backup', ['directory:unsafe']);
      const path = join(directory, 'catalog.sqlite');
      if (existsSync(path) && !regularFile(path)) throw new StoredDataError('backup', ['catalog:unsafe']);
      try {
        catalog = new DatabaseSync(path);
        const check = catalog.prepare('PRAGMA integrity_check').all();
        if (check.length !== 1 || check[0]?.integrity_check !== 'ok') throw new StoredDataError('backup', ['catalog:integrity']);
        initialize(catalog);
      } catch (error) {
        catalog?.close(); catalog = undefined;
        if (!isCorruption(error)) throw error;
        preserveDamagedDatabase(path);
        catalog = new DatabaseSync(path); initialize(catalog); recovered = true;
      }
      this.catalog = catalog;
      this.reconcileFiles();
    } catch (error) {
      catalog?.close();
      this.startupFailure = error;
      // Only provide empty read views; every mutating call will reject, never claim it persisted.
      this.catalog = new DatabaseSync(':memory:'); initialize(this.catalog);
    }
    this.catalogRecovered = recovered;
  }
  close(): void { this.catalog.close(); }
  private transaction<T>(write: boolean, body: () => T): T {
    if (write && this.startupFailure) throw causedWriteError(isDiskFull(this.startupFailure) ? 'disk-full' : 'io', 'backup:unavailable', this.startupFailure);
    if (!write) return readTransaction(this.catalog, body);
    try {
      this.catalog.exec('BEGIN IMMEDIATE');
      const value = body();
      this.catalog.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.catalog.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (isDiskFull(error)) {
        // The catalog also operates before the main DB is open (or when it cannot be opened).
        let db: DatabaseSync | undefined;
        try { db = this.database(); } catch { /* Keep the catalog's original failure. */ }
        if (db) storageHealth(db).makeReadOnly('disk-full');
      }
      if (error instanceof StoredDataError) throw error;
      throw causedWriteError(isDiskFull(error) ? 'disk-full' : 'io', 'backup:write-failed', error);
    }
  }
  private loadInfo(): StorageInfo {
    const row = this.catalog.prepare('SELECT body FROM info WHERE id = 1').get();
    return row ? readRecord(StorageInfo, 'backup_info', row.body as string) : {};
  }
  private saveInfo(value: StorageInfo): void {
    this.catalog.prepare('INSERT INTO info VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body').run(JSON.stringify(value));
  }
  private records(): BackupInfo[] {
    return this.catalog.prepare('SELECT id, body FROM backup').all().map((r) => {
      const record = readRecord(BackupInfo, 'backup', r.body as string);
      if (record.id !== r.id) throw new StoredDataError('backup', ['identity:mismatch']);
      return record;
    })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  }
  /** ID is never used as an arbitrary path; only UUIDs minted by create are accepted. */
  file(id: BackupId): string {
    if (!/^backup-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new StoredDataError('backup', ['id:invalid']);
    return join(this.directory, `${id}.sqlite`);
  }
  private verified(record: BackupInfo): boolean {
    const path = this.file(record.id);
    if (!regularFile(path)) return false;
    try { return verifyDatabase(path, true) === record.storageVersion && statSync(path).size === record.sizeBytes; }
    catch (error) { if (isCorruption(error)) return false; throw error; }
  }
  /** Only unregistered, strictly owned names require full verification at startup. */
  private reconcileFiles(): void {
    this.transaction(true, () => {
      const known = new Set(this.records().map((r) => r.id as string));
      for (const name of readdirSync(this.directory)) {
        if (!backupName.test(name)) continue;
        const id = name.slice(0, -7) as BackupId;
        if (known.has(id)) continue;
        const path = this.file(id);
        if (!regularFile(path)) continue;
        let version: number;
        try { version = verifyDatabase(path, true); }
        catch (error) {
          if (!isCorruption(error)) throw error;
          unlinkSync(path); continue;
        }
        const stat = statSync(path);
        // Lost metadata cannot recover the original reason. Use a recovery snapshot label so this
        // entry cannot suppress today's daily backup; its file modification time bounds retention.
        const record = BackupInfo.parse({ id, reason: 'pre-restore', createdAt: stat.mtime.toISOString(), storageVersion: version, sizeBytes: stat.size });
        this.catalog.prepare('INSERT INTO backup VALUES (?, ?)').run(id, JSON.stringify(record));
      }
    });
  }
  list(): Promise<BackupInfo[]> {
    return run(() => this.transaction(false, () => this.records().filter((r) => {
      const path = this.file(r.id);
      return r.sizeBytes > 0 && regularFile(path) && statSync(path).size === r.sizeBytes;
    })));
  }
  create(reason: BackupReason, at: Timestamp): Promise<BackupInfo> {
    return run(() => {
      const db = this.database();
      const health = storageHealth(db);
      health.assertWritable();
      BackupReason.parse(reason); Timestamp.parse(at);
      const id = `backup-${randomUUID()}` as BackupId;
      const path = this.file(id);
      if (existsSync(path)) throw new StorageWriteError('io', 'backup:collision');
      try { return this.transaction(true, () => {
        health.hooks?.beforeWrite();
        // SQLite refuses to overwrite; an incomplete or unverified file is never registered.
        db.prepare('VACUUM INTO ?').run(path);
        const storageVersion = verifyDatabase(path);
        syncFile(path);
        health.hooks?.beforeCommit();
        const record = BackupInfo.parse({ id, reason, createdAt: at, storageVersion, sizeBytes: statSync(path).size });
        this.catalog.prepare('INSERT INTO backup VALUES (?, ?)').run(id, JSON.stringify(record));
        this.saveInfo({ ...this.loadInfo(), lastBackupAt: at });
        return record;
      }); } catch (error) {
        // This invocation owns this exact UUID path; never clean up by glob or by age here.
        try { if (regularFile(path)) unlinkSync(path); } catch { /* An unlisted file is harmless. */ }
        throw error instanceof StorageWriteError ? error : causedWriteError('io', 'backup:verification-failed', error);
      }
    });
  }
  prune(now: Timestamp): Promise<BackupId[]> {
    return run(() => {
      storageHealth(this.database()).assertWritable();
      Timestamp.parse(now);
      return this.transaction(true, () => {
        const deleted: BackupId[] = [];
        const pending = this.loadInfo().pendingRestore?.backupId;
        const records = this.records();
        // Verify newest first. Never discard the last usable recovery point, regardless of age.
        // Unexpected I/O errors abort pruning before any file is removed.
        const newestVerified = records.find((record) => this.verified(record))?.id;
        for (const record of records) {
          if (record.id === pending || record.id === newestVerified) continue;
          const path = this.file(record.id);
          const present = existsSync(path);
          if (present && Date.parse(record.createdAt) >= Date.parse(now) - BACKUP_RETENTION_DAYS * 86400000) continue;
          if (present && !regularFile(path)) continue;
          if (present) unlinkSync(path);
          this.catalog.prepare('DELETE FROM backup WHERE id = ?').run(record.id);
          deleted.push(record.id);
        }
        return deleted;
      });
    });
  }
  scheduleRestore(id: BackupId, at: Timestamp): Promise<'scheduled' | 'not-found'> {
    return run(() => this.transaction(true, () => {
      Timestamp.parse(at);
      if (!this.records().some((r) => r.id === id && this.verified(r))) return 'not-found';
      const info = this.loadInfo();
      delete info.lastRestoreFailure;
      this.saveInfo({ ...info, pendingRestore: { backupId: id, requestedAt: at } });
      return 'scheduled';
    }));
  }
  cancelRestore(): Promise<void> {
    return run(() => this.transaction(true, () => {
      const info = this.loadInfo(); delete info.pendingRestore; this.saveInfo(info);
    }));
  }
  info(): Promise<StorageInfo> { return run(() => this.transaction(false, () => this.loadInfo())); }
  /** Startup-only completion, persisted independently of the database being replaced. */
  finishRestore(failure?: NonNullable<StorageInfo['lastRestoreFailure']>): void {
    this.transaction(true, () => {
      const info = this.loadInfo(); delete info.pendingRestore; delete info.lastRestoreFailure;
      if (failure) info.lastRestoreFailure = failure;
      this.saveInfo(info);
    });
  }
  hasFile(id: BackupId): boolean { return regularFile(this.file(id)); }
}
