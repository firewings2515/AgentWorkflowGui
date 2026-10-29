// Opening the app database: pragmas, the version table, and migrations that apply once and atomically.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

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
      expect(tables).toEqual([
        'agent',
        'artifact',
        'blob',
        'delivery',
        'dispatch_attempt',
        'escalation',
        'logical_session',
        'message',
        'native_task',
        'owned_process',
        'permission_request',
        'preference',
        'provision',
        'receive_admission',
        'schema_migration',
        'session_item',
        'turn',
        'workflow',
      ]);
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

describe('v3: data stored under contracts 0.4 (T020 review r1 P1-5)', () => {
  it('reads an Agent, a workflow template and an MCP elicitation written by 0.4', async () => {
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 2));
    const as04 = <T extends object>(record: T) => JSON.stringify({ ...record, schemaVersion: '0.4.0' });
    const agent = fixtureSnapshotInput.agents[0]!;
    const workflow = fixtureSnapshotInput.workflows[0]!;
    const session = fixtureSnapshotInput.sessions.find((s) => s.id === 's-plan-notes')!;
    // As 0.4 wrote it: no `server` (JSON drops the undefined field).
    const elicitation = { ...fixtureSnapshotInput.permissionRequests.find((p) => p.kind === 'mcpElicitation')!, server: undefined };
    old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, as04(agent));
    old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, as04(workflow));
    old.prepare('INSERT INTO logical_session (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(session.id, session.revision, 0, JSON.stringify(session));
    old.prepare('INSERT INTO permission_request (id, session_id, at_ms, body) VALUES (?, ?, ?, ?)').run(elicitation.id, session.id, 0, JSON.stringify({ ...elicitation, sessionId: session.id }));
    old.close();

    const db = openDatabase(path);
    try {
      expect(versions(db).map((v) => v.version)).toEqual([1, 2, 3]);
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual(['0.5.0']);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual(['0.5.0']);
      expect(data.conversations.permissionRequests[0]).toMatchObject({ kind: 'mcpElicitation', server: elicitation.elicitation?.serverName });
    } finally {
      db.close();
    }
  });
});
