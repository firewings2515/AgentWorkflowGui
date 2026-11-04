import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupId, Timestamp } from '../../contracts';
import { StorageReadOnlyError } from '../../core/ports/storage';
import { SqliteBackupStore, schemaVersion, verifyDatabase } from './backups';
import { MIGRATIONS, latestVersion } from './migrations';
import { openStorage } from './open-storage';
import { createRepositories } from './repositories';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), lstatSync: vi.fn(fs.lstatSync) };
});

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) close();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('test:unsafe-cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const path = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t038-r2-')); directories.push(dir);
  return join(dir, 'app.sqlite');
};
const at = (day: number) => Timestamp.parse(new Date(Date.UTC(2026, 0, day, 12)).toISOString());
const open = async (file: string, day = 1, extra: Parameters<typeof openStorage>[1] = {}) => {
  const storage = await openStorage(file, { now: at(day), ...extra });
  closers.push(storage.close); return storage;
};
const ownedId = () => BackupId.parse('backup-' + randomUUID());

it('daily verification failure after 44 days skips prune and preserves all recovery points', async () => {
  const file = path(); let s = await open(file);
  const before = await s.backups.list();
  s.db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE broken (ref TEXT REFERENCES logical_session(id)); INSERT INTO broken VALUES ('missing')");
  s.close();
  const prune = vi.spyOn(SqliteBackupStore.prototype, 'prune');
  s = await open(file, 45);
  expect(s.report.backupFailures).toEqual([{ operation: 'daily', reason: 'io' }]);
  expect(s.report.pruned).toEqual([]);
  expect(prune).not.toHaveBeenCalled();
  expect(await s.backups.list()).toEqual(before);
  expect(before.length).toBeGreaterThan(0);
  const daily = before.find((b) => b.reason === 'daily')!;
  expect(verifyDatabase(s.backups.file(daily.id), true)).toBe(latestVersion());
  expect(readdirSync(s.backups.directory).filter((name) => name.startsWith('backup-')).sort())
    .toEqual(before.map((b) => `${b.id}.sqlite`).sort());
});

it('prune retains the newest verified backup beyond retention even when newer entries are damaged', async () => {
  const s = await open(path());
  const older = await s.backups.create('daily', at(2));
  const keeper = await s.backups.create('daily', at(3));
  const damaged = await s.backups.create('daily', at(4));
  writeFileSync(s.backups.file(damaged.id), Buffer.alloc(damaged.sizeBytes, 88));
  const removed = await s.backups.prune(at(45));
  expect(removed).toEqual(expect.arrayContaining([older.id, damaged.id]));
  expect(removed).not.toContain(keeper.id);
  expect(await s.backups.list()).toEqual([keeper]);
  expect(verifyDatabase(s.backups.file(keeper.id), true)).toBe(latestVersion());
  expect(await s.backups.prune(at(90))).toEqual([]);
  expect(await s.backups.list()).toEqual([keeper]);
});

it('reconciliation deletes empty and schema-less orphans but accepts a schema_migration table at version zero', async () => {
  const file = path(); let s = await open(file);
  const empty = s.backups.file(ownedId()); writeFileSync(empty, '');
  const unrelated = s.backups.file(ownedId());
  const other = new DatabaseSync(unrelated); other.exec('CREATE TABLE unrelated (id INTEGER)'); other.close();
  const validId = ownedId(); const valid = s.backups.file(validId);
  const db = new DatabaseSync(valid);
  db.exec('CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)'); db.close();
  s.close(); s = await open(file);
  expect(existsSync(empty)).toBe(false);
  expect(existsSync(unrelated)).toBe(false);
  expect(await s.backups.list()).toContainEqual(expect.objectContaining({ id: validId, storageVersion: 0 }));
  expect(await s.backups.scheduleRestore(validId, at(1))).toBe('scheduled');
});

it.each(['empty', 'schema-less'] as const)('verified rejects a registered %s backup even when size and version match', async (kind) => {
  const file = path(); const s = await open(file);
  const id = ownedId(); const backup = s.backups.file(id);
  writeFileSync(backup, '');
  if (kind === 'schema-less') {
    const db = new DatabaseSync(backup); db.exec('CREATE TABLE unrelated (id INTEGER)'); db.close();
  }
  const record = { id, reason: 'pre-restore', createdAt: at(1), storageVersion: 0, sizeBytes: lstatSync(backup).size };
  const catalog = new DatabaseSync(join(s.backups.directory, 'catalog.sqlite'));
  try { catalog.prepare('INSERT INTO backup VALUES (?, ?)').run(id, JSON.stringify(record)); }
  finally { catalog.close(); }
  expect(await s.backups.scheduleRestore(id, at(1))).toBe('not-found');
  expect((await s.backups.info()).pendingRestore).toBeUndefined();
  if (kind === 'empty') expect(await s.backups.list()).not.toContainEqual(record);
  expect(await s.backups.prune(at(45))).toContain(id);
  expect(existsSync(backup)).toBe(false);
});

it('migration foreign-key violations roll back the entire upgrade and reopen the original schema read-only', async () => {
  const file = path(); let s = await open(file);
  const before = s.db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(); s.close();
  const migrations = [...MIGRATIONS,
    { version: latestVersion() + 1, name: 'first', sql: 'CREATE TABLE earlier_upgrade (id INTEGER)' },
    { version: latestVersion() + 2, name: 'foreign-key-violation', sql: "CREATE TABLE invalid_upgrade (ref TEXT REFERENCES logical_session(id)); INSERT INTO invalid_upgrade VALUES ('missing')" },
  ];
  s = await open(file, 1, { migrations });
  expect(s.report.state).toEqual({ status: 'read-only', reason: 'migration-failed' });
  expect(s.report.failedMigrationVersion).toBe(latestVersion() + 2);
  expect(schemaVersion(s.db)).toBe(latestVersion());
  expect(s.db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(before);
  expect(s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(s.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  expect(() => s.db.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow();
  await expect(createRepositories(s.db).preferences.set(null as never)).rejects.toBeInstanceOf(StorageReadOnlyError);
});

it('failed restore stage rename undoes preservation of the damaged main and both sidecars', async () => {
  const file = path(); const s = await open(file);
  const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
  await s.backups.scheduleRestore(backup.id, at(1)); s.close();
  for (const suffix of ['', '-wal', '-shm']) writeFileSync(file + suffix, 'damaged original ' + suffix);
  const actualRename = vi.mocked(renameSync).getMockImplementation()!;
  let failed = false;
  vi.mocked(renameSync).mockImplementation((source, target) => {
    if (target === file && basename(String(source)).startsWith('.restore-')) {
      failed = true; throw Object.assign(new Error('stage rename failed'), { code: 'EIO' });
    }
    actualRename(source, target);
  });
  try {
    await expect(open(file)).rejects.toMatchObject({
      message: 'storage:open-failed', report: { restoreFailure: { backupId: backup.id, reason: 'io-failed' } },
    });
    expect(failed).toBe(true);
    for (const suffix of ['', '-wal', '-shm']) expect(readFileSync(file + suffix, 'utf8')).toBe('damaged original ' + suffix);
    expect(readdirSync(dirname(file)).some((name) => name.includes('.damaged-') || name.startsWith('.restore-'))).toBe(false);
    const catalog = new SqliteBackupStore(s.backups.directory, () => { throw new Error('main stays closed'); });
    try { expect(await catalog.info()).toMatchObject({ lastRestoreFailure: { backupId: backup.id, reason: 'io-failed' } }); }
    finally { catalog.close(); }
  } finally { vi.mocked(renameSync).mockImplementation(actualRename); }
});

it('catalog write SQLITE_FULL rolls back metadata and latches main storage read-only', async () => {
  const s = await open(path()); const before = await s.backups.info();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with the intercepted database as this.
  const prepare = DatabaseSync.prototype.prepare;
  const failure = Object.assign(new Error('catalog full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('INSERT INTO info')) vi.spyOn(statement, 'run').mockImplementation(() => { throw failure; });
    return statement;
  });
  try {
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await expect(s.backups.scheduleRestore(backup.id, at(1))).rejects.toMatchObject({ kind: 'disk-full', cause: failure });
    expect(await s.backups.info()).toEqual(before);
    expect(s.health.state()).toEqual({ status: 'read-only', reason: 'disk-full' });
    await expect(createRepositories(s.db).preferences.set(null as never)).rejects.toBeInstanceOf(StorageReadOnlyError);
  } finally { spy.mockRestore(); }
});

it('startup cleanup leaves directories and symbolic links with owned restore names untouched', async () => {
  const file = path(); const s = await open(file); s.close();
  const directory = join(dirname(file), '.restore-' + randomUUID() + '.sqlite'); mkdirSync(directory);
  const target = join(dirname(file), 'user-directory'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'user');
  const junction = join(dirname(file), '.restore-' + randomUUID() + '.sqlite'); symlinkSync(target, junction, 'junction');
  // File symlinks require Windows privileges. Emulate lstat's file/link combination as well,
  // so deleting the explicit isSymbolicLink guard is detected independently of isFile.
  const link = join(dirname(file), '.restore-' + randomUUID() + '.sqlite'); writeFileSync(link, 'link placeholder');
  const actualStat = vi.mocked(lstatSync).getMockImplementation()!;
  vi.mocked(lstatSync).mockImplementation((...args) => {
    const stat = actualStat(...args);
    if (args[0] === link && stat) stat.isSymbolicLink = () => true;
    return stat;
  });
  try {
    const next = await open(file);
    expect(next.report.backupFailures).toEqual([]);
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('user');
    expect(readFileSync(link, 'utf8')).toBe('link placeholder');
  } finally { vi.mocked(lstatSync).mockImplementation(actualStat); }
});

it('reconcileFiles propagates non-corruption verification errors without deleting the orphan', async () => {
  const s = await open(path()); const id = ownedId(); const orphan = s.backups.file(id);
  s.db.prepare('VACUUM INTO ?').run(orphan); const bytes = readFileSync(orphan); s.close();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with the intercepted database as this.
  const prepare = DatabaseSync.prototype.prepare;
  const failure = Object.assign(new Error('transient read failure'), { code: 'EIO' });
  let checks = 0;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    const statement = prepare.call(this, sql);
    if (sql === 'PRAGMA integrity_check' && ++checks === 2) vi.spyOn(statement, 'all').mockImplementation(() => { throw failure; });
    return statement;
  });
  let catalog: SqliteBackupStore | undefined;
  try {
    catalog = new SqliteBackupStore(s.backups.directory, () => { throw new Error('main stays closed'); });
    expect(checks).toBe(2);
    expect(catalog.startupFailure).toMatchObject({ kind: 'io', cause: failure });
    expect(readFileSync(orphan)).toEqual(bytes);
  } finally { catalog?.close(); spy.mockRestore(); }
  const retry = new SqliteBackupStore(s.backups.directory, () => { throw new Error('main stays closed'); });
  try {
    expect(retry.startupFailure).toBeUndefined();
    expect(await retry.list()).toContainEqual(expect.objectContaining({ id }));
  } finally { retry.close(); }
});
