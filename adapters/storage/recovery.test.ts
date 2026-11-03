import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupId, LogicalSession, Message, SessionId, Timestamp } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { StorageReadOnlyError, StorageWriteError } from '../../core/ports/storage';
import { openStorage } from './open-storage';
import { openDatabase } from './database';
import { SqliteBackupStore, schemaVersion, verifyDatabase } from './backups';
import { createRepositories } from './repositories';
import { MIGRATIONS, migrate, latestVersion } from './migrations';
import { storageHealth } from './health';
import { InjectedStorageFaults } from './testing/storage-faults';
import { SqliteDeliveryStore } from './delivery-store';
import { claimInput, op, payloadInput, THREAD } from './testing/fixtures';
import { committed, writeTransaction } from './transaction';

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('test:unsafe-cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const path = () => { const dir = mkdtempSync(join(tmpdir(), 'awg-t038-')); directories.push(dir); return join(dir, 'app.sqlite'); };
const at = (day: number) => Timestamp.parse(new Date(Date.UTC(2026, 0, day, 12)).toISOString());
const open = async (file: string, now = at(1), extra: Parameters<typeof openStorage>[1] = {}) => {
  const storage = await openStorage(file, { now, ...extra });
  let closed = false;
  const close = () => { if (!closed) { closed = true; storage.close(); } };
  closers.push(close);
  return { ...storage, close };
};

describe('backup and startup recovery', () => {
  it('never lists an unverified backup or leaves its partial file registered', async () => {
    const file = path(); const s = await open(file); const before = await s.backups.list();
    const filesBefore = readdirSync(s.backups.directory).sort();
    s.db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE broken (ref TEXT REFERENCES logical_session(id)); INSERT INTO broken VALUES ('missing')");
    await expect(s.backups.create('daily', at(2))).rejects.toMatchObject({ name: 'StorageWriteError', kind: 'io' });
    expect(await s.backups.list()).toEqual(before);
    expect(readdirSync(s.backups.directory).sort()).toEqual(filesBefore);
  });
  it('backs up before migration, once per day, verifies WAL content and survives reopen', async () => {
    const file = path(); let s = await open(file);
    expect(s.report.backupsMade.map((b) => [b.reason, b.storageVersion])).toEqual([['pre-migration', 0], ['daily', latestVersion()]]);
    const repos = createRepositories(s.db);
    await repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 12, maxOpenRuntimes: 3 } });
    const backup = await s.backups.create('pre-restore', at(1));
    const backupFile = s.backups.file(backup.id);
    expect(verifyDatabase(backupFile)).toBe(latestVersion());
    const reader = new DatabaseSync(backupFile, { readOnly: true });
    expect((await createRepositories(reader).preferences.get()).theme).toBe('light'); reader.close();
    s.close(); s = await open(file);
    expect(s.report.backupsMade).toEqual([]);
    expect((await s.backups.list()).some((b) => b.id === backup.id)).toBe(true);
    s.close(); s = await open(file, at(2));
    expect(s.report.backupsMade.map((b) => b.reason)).toEqual(['daily']);
  });

  it('restores only at the next start, saves current data first, and retains catalog metadata', async () => {
    const file = path(); let s = await open(file);
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await createRepositories(s.db).preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    expect(await s.backups.scheduleRestore(backup.id, at(1))).toBe('scheduled');
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('light');
    s.close(); s = await open(file);
    expect(s.report.restored).toBe(backup.id);
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('dark');
    expect(s.report.backupsMade.map((b) => b.reason)).toEqual(['pre-restore']);
    const before = s.report.backupsMade[0]!;
    const reader = new DatabaseSync(s.backups.file(before.id), { readOnly: true });
    expect((await createRepositories(reader).preferences.get()).theme).toBe('light'); reader.close();
    expect((await s.backups.info()).pendingRestore).toBeUndefined();
    expect((await s.backups.list()).some((b) => b.id === backup.id)).toBe(true);
    s.close();
    expect(existsSync(file + '-wal')).toBe(false);
    expect(existsSync(file + '-shm')).toBe(false);
  });

  it('restores over an unreadable main database and preserves its exact database/WAL/SHM family', async () => {
    const file = path(); let s = await open(file);
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await s.backups.scheduleRestore(backup.id, at(1)); s.close();
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(file + suffix, 'damaged bytes ' + suffix);
    s = await open(file);
    expect(s.report.restored).toBe(backup.id);
    expect(s.report.restoreFailure).toBeUndefined();
    expect(s.report.state).toEqual({ status: 'ready' });
    expect(schemaVersion(s.db)).toBe(latestVersion());
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('dark');
    const preserved = readdirSync(dirname(file)).filter((name) => name.includes('.damaged-'));
    for (const suffix of ['', '-wal', '-shm']) {
      const saved = preserved.find((name) => name.startsWith('app.sqlite' + suffix + '.damaged-'))!;
      expect(saved).toBeDefined();
      expect(readFileSync(join(dirname(file), saved), 'utf8')).toBe('damaged bytes ' + suffix);
    }
    s.close();
    expect(existsSync(file + '-wal')).toBe(false); expect(existsSync(file + '-shm')).toBe(false);
  });

  it('a damaged restore candidate leaves a damaged main untouched and records failure independently', async () => {
    const file = path(); const s = await open(file);
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await s.backups.scheduleRestore(backup.id, at(1));
    const candidate = s.backups.file(backup.id); const directory = s.backups.directory; s.close();
    writeFileSync(file, 'damaged original'); writeFileSync(candidate, 'damaged candidate');
    for (const suffix of ['-wal', '-shm']) writeFileSync(file + suffix, 'original sidecar ' + suffix);
    await expect(openStorage(file, { now: at(1) })).rejects.toMatchObject({
      message: 'storage:open-failed', report: { restoreFailure: { backupId: backup.id, reason: 'integrity-failed' } },
    });
    expect(readFileSync(file, 'utf8')).toBe('damaged original');
    for (const suffix of ['-wal', '-shm']) expect(readFileSync(file + suffix, 'utf8')).toBe('original sidecar ' + suffix);
    expect(readdirSync(dirname(file)).some((name) => name.includes('.damaged-') || name.startsWith('.restore-'))).toBe(false);
    const catalog = new SqliteBackupStore(directory, () => { throw new Error('main must stay closed'); });
    try {
      expect((await catalog.info()).lastRestoreFailure).toEqual({ backupId: backup.id, reason: 'integrity-failed', at: at(1) });
    } finally { catalog.close(); }
    // Windows detects leaked handles here even though SQLite's constructor itself succeeded.
    renameSync(file, file + '.kept'); unlinkSync(file + '.kept');
  });

  it('integrity failure in an otherwise openable main database does not prevent restore', async () => {
    const file = path(); let s = await open(file);
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await s.backups.scheduleRestore(backup.id, at(1));
    s.db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE broken (ref TEXT REFERENCES logical_session(id)); INSERT INTO broken VALUES ('missing')");
    s.close(); s = await open(file);
    expect(s.report.restored).toBe(backup.id);
    expect(s.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'broken'").get()).toBeUndefined();
    expect(readdirSync(dirname(file)).some((name) => name.startsWith('app.sqlite.damaged-'))).toBe(true);
  });

  it('closes a connection whose startup PRAGMAs fail, allowing immediate removal on Windows', async () => {
    const file = path(); writeFileSync(file, 'not a SQLite database');
    await expect(openStorage(file, { now: at(1) })).rejects.toMatchObject({ message: 'storage:open-failed' });
    unlinkSync(file);
    expect(existsSync(file)).toBe(false);
  });

  it('daily failure skips prune; prune failure after a successful daily backup permits a healthy startup', async () => {
    const file = path(); const first = await open(file); first.close();
    const faults = new InjectedStorageFaults(); faults.failNextWrite('io');
    const spy = vi.spyOn(SqliteBackupStore.prototype, 'prune').mockRejectedValue(new Error('SECRET prune failure'));
    try {
      const s = await open(file, at(2), { hooks: faults });
      expect(s.report.state).toEqual({ status: 'ready' });
      expect(s.report.backupFailures).toEqual([{ operation: 'daily', reason: 'io' }]);
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(s.report)).not.toContain('SECRET');
      await createRepositories(s.db).preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } });
      expect((await createRepositories(s.db).preferences.get()).theme).toBe('light');
      s.close();
      const next = await open(file, at(2));
      expect(spy).toHaveBeenCalledOnce();
      expect(next.report.backupFailures).toEqual([{ operation: 'prune', reason: 'io' }]);
      expect(next.report.state).toEqual({ status: 'ready' });
      expect(JSON.stringify(next.report)).not.toContain('SECRET');
    } finally { spy.mockRestore(); }
  });

  it('rebuilds a corrupt catalog from owned verified snapshots and preserves the broken catalog', async () => {
    const file = path(); let s = await open(file);
    const backups = await s.backups.list(); const directory = s.backups.directory; s.close();
    writeFileSync(join(directory, 'catalog.sqlite'), 'damaged catalog');
    const unknown = join(directory, 'user.sqlite'); writeFileSync(unknown, 'user');
    s = await open(file);
    expect(s.report.catalogRecovered).toBe(true);
    expect(s.report.backupFailures).toEqual([]);
    const listed = await s.backups.list();
    for (const backup of backups.filter((b) => b.storageVersion > 0)) expect(listed).toContainEqual(expect.objectContaining({ id: backup.id, storageVersion: backup.storageVersion, sizeBytes: backup.sizeBytes }));
    expect(readFileSync(unknown, 'utf8')).toBe('user');
    const saved = readdirSync(directory).find((name) => name.startsWith('catalog.sqlite.damaged-'))!;
    expect(readFileSync(join(directory, saved), 'utf8')).toBe('damaged catalog');
    expect(await s.backups.scheduleRestore(backups.find((b) => b.storageVersion > 0)!.id, at(1))).toBe('scheduled');
  });

  it('an unavailable backup folder leaves a healthy main usable and makes writes to the catalog fail', async () => {
    const file = path(); const first = await open(file); const directory = first.backups.directory; first.close();
    renameSync(directory, directory + '.saved'); writeFileSync(directory, 'blocked directory');
    const s = await open(file, at(2));
    expect(s.report.state).toEqual({ status: 'ready' });
    expect(s.report.backupFailures.map((f) => f.operation)).toEqual(['catalog', 'daily']);
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('dark');
    await expect(s.backups.cancelRestore()).rejects.toThrow('backup:unavailable');
    expect(readFileSync(directory, 'utf8')).toBe('blocked directory');
  });

  it('reconciles a VACUUM orphan and cleans only owned interrupted restore paths', async () => {
    const file = path(); let s = await open(file);
    const orphanId = BackupId.parse('backup-' + randomUUID());
    const orphan = s.backups.file(orphanId); s.db.prepare('VACUUM INTO ?').run(orphan);
    const invalid = s.backups.file(BackupId.parse('backup-' + randomUUID())); writeFileSync(invalid, 'partial');
    const stage = join(dirname(file), '.restore-' + randomUUID() + '.sqlite');
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(stage + suffix, 'interrupted');
    const unknown = join(dirname(file), '.restore-user.sqlite'); writeFileSync(unknown, 'user');
    s.close(); s = await open(file);
    expect(await s.backups.list()).toContainEqual(expect.objectContaining({ id: orphanId, storageVersion: latestVersion() }));
    expect(existsSync(invalid)).toBe(false);
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(stage + suffix)).toBe(false);
    expect(readFileSync(unknown, 'utf8')).toBe('user');
  });

  it('list checks metadata only; scheduleRestore fully verifies; prune removes corrupt expired and missing entries', async () => {
    const file = path(); const s = await open(file);
    const broken = await s.backups.create('pre-restore', at(1));
    const missing = await s.backups.create('pre-restore', at(31));
    writeFileSync(s.backups.file(broken.id), Buffer.alloc(broken.sizeBytes, 88));
    unlinkSync(s.backups.file(missing.id));
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      expect(await s.backups.list()).toContainEqual(broken);
      expect(prepare.mock.calls.some(([sql]) => /integrity_check|foreign_key_check/.test(sql))).toBe(false);
    } finally { prepare.mockRestore(); }
    expect(await s.backups.scheduleRestore(broken.id, at(32))).toBe('not-found');
    expect(await s.backups.prune(at(32))).toEqual(expect.arrayContaining([broken.id, missing.id]));
    expect(existsSync(s.backups.file(broken.id))).toBe(false);
    const catalog = new DatabaseSync(join(s.backups.directory, 'catalog.sqlite'), { readOnly: true });
    try { expect(catalog.prepare('SELECT id FROM backup WHERE id IN (?, ?)').all(broken.id, missing.id)).toEqual([]); }
    finally { catalog.close(); }
  });

  it.each(['backup-missing', 'integrity-failed', 'newer-schema', 'io-failed'] as const)('restore %s keeps current data and persists a safe failure', async (reason) => {
    const file = path(); let s = await open(file);
    const backup = s.report.backupsMade.find((b) => b.reason === 'daily')!;
    await s.backups.scheduleRestore(backup.id, at(1));
    await createRepositories(s.db).preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    const backupFile = s.backups.file(backup.id); s.close();
    const faults = new InjectedStorageFaults();
    if (reason === 'backup-missing') unlinkSync(backupFile);
    if (reason === 'integrity-failed') writeFileSync(backupFile, 'SECRET damaged backup');
    if (reason === 'newer-schema') {
      const db = new DatabaseSync(backupFile); db.prepare('INSERT INTO schema_migration VALUES (?, ?, ?)').run(latestVersion() + 1, 'future', at(1)); db.close();
    }
    if (reason === 'io-failed') faults.failNextWrite('io');
    s = await open(file, at(1), { hooks: faults });
    expect(s.report.restoreFailure).toEqual({ backupId: backup.id, reason });
    expect(s.report.restored).toBeUndefined();
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('light');
    expect((await s.backups.info()).lastRestoreFailure).toEqual({ backupId: backup.id, reason, at: at(1) });
    expect((await s.backups.info()).pendingRestore).toBeUndefined();
    expect(JSON.stringify(s.report)).not.toContain('SECRET');
  });

  it('restores an old version then backs it up before migrating', async () => {
    const file = path(); const db = new DatabaseSync(file); migrate(db, MIGRATIONS.slice(0, 8)); db.close();
    let s = await open(file);
    const old = s.report.backupsMade.find((b) => b.reason === 'pre-migration')!;
    expect(old.storageVersion).toBe(8);
    await s.backups.scheduleRestore(old.id, at(1)); s.close(); s = await open(file);
    expect(s.report.restored).toBe(old.id);
    expect(s.report.backupsMade.map((b) => b.reason)).toEqual(['pre-restore', 'pre-migration']);
    expect(schemaVersion(s.db)).toBe(latestVersion());
  });

  it('prunes only verified listed files strictly older than 30 days; retains unknown files and pending restores', async () => {
    const file = path(); const s = await open(file);
    const old = await s.backups.create('daily', at(1));
    const boundary = await s.backups.create('daily', at(2));
    const pending = await s.backups.create('daily', at(1));
    await s.backups.scheduleRestore(pending.id, at(1));
    const unknown = join(s.backups.directory, 'user.sqlite'); writeFileSync(unknown, 'user-owned');
    const pruned = await s.backups.prune(at(32));
    expect(pruned).toContain(old.id); expect(pruned).not.toContain(boundary.id); expect(pruned).not.toContain(pending.id);
    expect(existsSync(s.backups.file(old.id))).toBe(false); expect(readFileSync(unknown, 'utf8')).toBe('user-owned');
    expect((await s.backups.list()).some((b) => b.id === boundary.id)).toBe(true);
  });

  it('catalog lists verified backups with a damaged main DB; missing, corrupt and forged IDs are not offered', async () => {
    const file = path(); const s = await open(file);
    const listed = await s.backups.list(); const dir = s.backups.directory; s.close();
    writeFileSync(file, 'broken');
    const catalog = new SqliteBackupStore(dir, () => { throw new Error('must not read main'); });
    try {
      expect(await catalog.list()).toEqual(listed);
      expect(await catalog.scheduleRestore(BackupId.parse('../outside'), at(1))).toBe('not-found');
      const backup = listed.find((b) => b.storageVersion > 0)!;
      await catalog.scheduleRestore(backup.id, at(1)); await catalog.cancelRestore();
      expect((await catalog.info()).pendingRestore).toBeUndefined();
      writeFileSync(catalog.file(backup.id), 'corrupt');
      expect((await catalog.list()).some((b) => b.id === backup.id)).toBe(false);
    } finally { catalog.close(); }
  });
});

describe('read-only and injected faults', () => {
  it.each(['BEGIN IMMEDIATE', 'COMMIT'])('classifies native SQLITE_FULL at %s, rolls back, and notifies once', async (point) => {
    const db = openDatabase(':memory:'); closers.push(() => db.close()); const repos = createRepositories(db);
    const health = storageHealth(db); const listener = vi.fn();
    const unsubscribe = health.onReadOnly(listener); unsubscribe();
    const active = vi.fn(); health.onReadOnly(active); health.onReadOnly(() => { throw new Error('observer'); });
    const realExec = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === point) throw Object.assign(new Error('SECRET'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
      realExec(sql);
    });
    try {
      await expect(repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } })).rejects.toMatchObject({ name: 'StorageWriteError', kind: 'disk-full', message: 'storage:disk-full' });
      expect((await repos.preferences.get()).theme).toBe('dark');
      await expect(repos.preferences.set(null as never)).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(active).toHaveBeenCalledExactlyOnceWith('disk-full'); expect(listener).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['disk-full', 'io'] as const)('%s rolls back blob and row together; only disk-full latches read-only', async (kind) => {
    const db = openDatabase(':memory:'); closers.push(() => db.close());
    const repos = createRepositories(db, { blobThresholdBytes: 4 });
    const session = LogicalSession.parse(fixtureSnapshot.sessions[0]); await repos.sessions.create(session);
    const msg = Message.parse({ id: 'blob', sessionId: session.id, text: 'large payload', role: 'system', origin: { kind: 'system' }, createdAt: at(1) });
    const faults = new InjectedStorageFaults(db); const reasons: string[] = [];
    storageHealth(db).onReadOnly((reason) => reasons.push(reason));
    faults.failNextWrite(kind);
    await expect(repos.conversations.appendMessage(msg)).rejects.toMatchObject({ name: 'StorageWriteError', kind });
    expect(db.prepare('SELECT count(*) AS n FROM blob').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM message').get()?.n).toBe(0);
    expect((await repos.sessions.list())).toEqual([session]);
    if (kind === 'disk-full') {
      await expect(repos.conversations.appendMessage(msg)).rejects.toBeInstanceOf(StorageReadOnlyError);
      await expect(repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } })).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(reasons).toEqual(['disk-full']);
    } else {
      await repos.conversations.appendMessage(msg); expect((await repos.conversations.get(session.id)).messages).toEqual([msg]); expect(reasons).toEqual([]);
    }
  });

  it('n-th write and slow disk are local test hooks, with committed data preserved', async () => {
    const db = openDatabase(':memory:'); closers.push(() => db.close());
    const repos = createRepositories(db); const faults = new InjectedStorageFaults(db);
    faults.failNextWrite('disk-full', 2); faults.delayWrites(20);
    const start = performance.now();
    await repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } });
    expect(performance.now() - start).toBeGreaterThanOrEqual(18);
    await expect(repos.preferences.set({ theme: 'dark', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } })).rejects.toBeInstanceOf(StorageWriteError);
    expect((await repos.preferences.get()).theme).toBe('light');
  });

  it('opens a newer schema read-only without migrations and permits scheduling a restore', async () => {
    const file = path(); let s = await open(file);
    const backup = s.report.backupsMade[1]!;
    s.db.prepare('INSERT INTO schema_migration VALUES (?, ?, ?)').run(latestVersion() + 1, 'future', at(1)); s.close();
    s = await open(file);
    expect(s.report.state).toEqual({ status: 'read-only', reason: 'newer-schema' });
    expect(s.report.backupsMade).toEqual([]);
    expect(() => s.db.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow();
    await expect(createRepositories(s.db).preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: 1 } })).rejects.toBeInstanceOf(StorageReadOnlyError);
    expect(await s.backups.scheduleRestore(backup.id, at(1))).toBe('scheduled');
  });

  it('migration fault after first statement restores the entire previous schema/data and opens read-only', async () => {
    const file = path(); const db = new DatabaseSync(file); migrate(db, MIGRATIONS.slice(0, 8));
    db.exec("INSERT INTO preference VALUES (1, '{\"theme\":\"light\"}')");
    const before = db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(); db.close();
    const faults = new InjectedStorageFaults(); faults.failNextMigration();
    const s = await open(file, at(1), { hooks: faults });
    expect(s.report.state).toEqual({ status: 'read-only', reason: 'migration-failed' });
    expect(s.report.failedMigrationVersion).toBe(9);
    expect(s.health.failedMigrationVersion).toBe(9);
    expect(schemaVersion(s.db)).toBe(8);
    expect(s.db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(before);
    expect((await createRepositories(s.db).preferences.get()).theme).toBe('light');
    expect((await createRepositories(s.db).readSnapshotData({ recentTurns: 1 })).conversations.turns).toEqual([]);
    expect(s.report.backupsMade.map((b) => b.reason)).toEqual(['pre-migration']);
    expect(await new SqliteDeliveryStore(s.db).listByTarget(SessionId.parse('session-target'))).toEqual([]);
  });

  it.each(['accept', 'claim', 'recordSent'] as const)('%s rolls back on disk-full and every subsequent delivery write is refused', async (method) => {
    const db = openDatabase(':memory:'); closers.push(() => db.close());
    const store = new SqliteDeliveryStore(db);
    const claim = claimInput(op('op-1'));
    if (method !== 'accept') await store.accept(payloadInput());
    if (method === 'recordSent') await store.claim(claim);
    const rows = () => ['delivery', 'dispatch_attempt', 'receive_admission'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = rows();
    const faults = new InjectedStorageFaults(db); faults.failNextWrite('disk-full');
    const calls = {
      accept: () => store.accept(payloadInput()),
      claim: () => store.claim(claim),
      recordSent: () => store.recordSent(op('op-1'), claim.attemptId, { sessionRef: THREAD, turnRef: 'turn-1' }, { kind: 'live-ack', at: at(1), detail: 'accepted' }),
    };
    await expect(calls[method]()).rejects.toMatchObject({ kind: 'disk-full', cause: { code: 'ENOSPC' } });
    expect(rows()).toEqual(before);
    for (const call of Object.values(calls)) await expect(call()).rejects.toBeInstanceOf(StorageReadOnlyError);
    expect(rows()).toEqual(before);
  });

  it.each(['newer-schema', 'migration-failed'] as const)('%s permits delivery reads and refuses accept/claim/recordSent before BEGIN', async (reason) => {
    const file = path(); const db = new DatabaseSync(file);
    migrate(db, reason === 'migration-failed' ? MIGRATIONS.slice(0, 8) : MIGRATIONS);
    const store = new SqliteDeliveryStore(db);
    await store.accept(payloadInput());
    await store.accept(payloadInput({ operationId: op('pending') }));
    const claimed = claimInput(op('op-1')); await store.claim(claimed);
    const before = await store.listByTarget(SessionId.parse('session-target'));
    if (reason === 'newer-schema') db.prepare('INSERT INTO schema_migration VALUES (?, ?, ?)').run(latestVersion() + 1, 'future', at(1));
    db.close();
    const faults = new InjectedStorageFaults();
    if (reason === 'migration-failed') faults.failNextMigration();
    const s = await open(file, at(1), { hooks: faults });
    expect(s.report.state).toEqual({ status: 'read-only', reason });
    const readonly = new SqliteDeliveryStore(s.db);
    expect(await readonly.listByTarget(SessionId.parse('session-target'))).toEqual(before);
    const rows = () => ['delivery', 'dispatch_attempt', 'receive_admission'].map((table) => s.db.prepare(`SELECT * FROM ${table}`).all());
    const stored = rows();
    const exec = vi.spyOn(s.db, 'exec');
    try {
      await expect(readonly.accept(payloadInput({ operationId: op('new') }))).rejects.toBeInstanceOf(StorageReadOnlyError);
      await expect(readonly.claim(claimInput(op('pending')))).rejects.toBeInstanceOf(StorageReadOnlyError);
      await expect(readonly.recordSent(op('op-1'), claimed.attemptId, { sessionRef: THREAD }, { kind: 'live-ack', at: at(1), detail: 'accepted' })).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(exec).not.toHaveBeenCalled();
      expect(rows()).toEqual(stored);
    } finally { exec.mockRestore(); }
  });

  it('reports the failing migration version after earlier migrations in the same transaction roll back', async () => {
    const file = path(); const first = await open(file); first.close();
    const migrations = [...MIGRATIONS,
      { version: latestVersion() + 1, name: 'first', sql: 'CREATE TABLE temporary_upgrade (id INTEGER);' },
      { version: latestVersion() + 2, name: 'second', sql: 'CREATE TABLE other_upgrade (id INTEGER); SELECT * FROM secret_missing_table;' },
    ];
    const s = await open(file, at(1), { migrations });
    expect(s.report.failedMigrationVersion).toBe(latestVersion() + 2);
    expect(schemaVersion(s.db)).toBe(latestVersion());
    expect(s.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('temporary_upgrade', 'other_upgrade')").all()).toEqual([]);
    expect(JSON.stringify(s.report)).not.toContain('secret_missing_table');
  });

  it.each(['EIO', 'SQLITE_IOERR_FSYNC'])('retains the cause of %s and keeps commit uncertainty diagnostics', (code) => {
    const db = openDatabase(':memory:'); closers.push(() => db.close());
    const cause = Object.assign(new Error('specific failure'), { code });
    expect(() => writeTransaction(db, () => { throw cause; })).toThrow(expect.objectContaining({ message: 'storage:io', cause }));
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => { if (sql === 'COMMIT') throw cause; exec(sql); });
    try {
      expect(() => writeTransaction(db, () => committed(undefined))).toThrow(expect.objectContaining({ name: 'CommitUncertainError', cause }));
    } finally { spy.mockRestore(); }
  });
});
