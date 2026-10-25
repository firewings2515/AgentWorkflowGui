// Opening the app database: pragmas, the version table, and migrations that apply once and atomically.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';

let dir = '';
let path = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t007-migrate-'));
  path = join(dir, 'app.sqlite');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const versions = (db: DatabaseSync) => db.prepare('SELECT version, name FROM schema_migration ORDER BY version').all();

describe('openDatabase', () => {
  it('creates the schema at the latest version with WAL, full sync, foreign keys and a busy timeout', () => {
    const db = openDatabase(path, { busyTimeoutMs: 1234 });
    try {
      expect(versions(db)).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
      expect(tables).toEqual(['delivery', 'dispatch_attempt', 'provision', 'receive_admission', 'schema_migration']);
    } finally {
      db.close();
    }
  });

  it('applies nothing again when reopened', () => {
    openDatabase(path).close();
    const db = openDatabase(path);
    try {
      expect(versions(db)).toHaveLength(MIGRATIONS.length);
      expect(migrate(db)).toBe(latestVersion());
    } finally {
      db.close();
    }
  });

  it('refuses a database written by a newer app', () => {
    const db = openDatabase(path);
    db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(latestVersion() + 1, 'future', new Date().toISOString());
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer than this app supports/);
  });
});

describe('migrate', () => {
  it('applies only the new migrations, in order', () => {
    const db = openDatabase(path);
    try {
      const next = [...MIGRATIONS, { version: latestVersion() + 1, name: 'extra', sql: 'CREATE TABLE extra (id TEXT PRIMARY KEY) STRICT;' }];
      expect(migrate(db, next)).toBe(latestVersion() + 1);
      expect(versions(db)).toEqual(next.map((m) => ({ version: m.version, name: m.name })));
    } finally {
      db.close();
    }
  });

  it('rolls a failing migration back completely', () => {
    const db = openDatabase(path);
    try {
      const broken = [...MIGRATIONS, { version: latestVersion() + 1, name: 'broken', sql: 'CREATE TABLE half (id TEXT); INSERT INTO nowhere VALUES (1);' }];
      expect(() => migrate(db, broken)).toThrow(/no such table: nowhere/);
      expect(versions(db)).toHaveLength(MIGRATIONS.length);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
