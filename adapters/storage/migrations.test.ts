// Opening the app database: pragmas, the version table, and migrations that apply once and atomically.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { TransferId } from '../../contracts';
import { fixtureSnapshot, fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';
import { canonicalJson, SqliteDeliveryStore } from './delivery-store';
import { at, claimInput, COUNT_KEY, op, payloadInput, provisionInput, THREAD } from './testing/fixtures';

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
        'node_session',
        'owned_process',
        'permission_request',
        'preference',
        'provision',
        'receive_admission',
        'schema_migration',
        'session_item',
        'transfer_proposal',
        'turn',
        'workflow',
        'workflow_instance',
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
  it.each([4, 5])('v%i rolls back schema, data and version after a mid-migration failure', (version) => {
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, version - 1));
      const input = payloadInput();
      db.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
        accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(input.operationId, input.kind, input.sourceCallRef!, input.payloadHash, input.proposalRevision,
          canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ payload: input.payload, context: input.context }), input.at);
      if (version === 4) {
        db.prepare('INSERT INTO receive_admission (operation_id, count_key) VALUES (?, ?)').run(input.operationId, COUNT_KEY);
        db.exec('CREATE TABLE transfer_proposal (sentinel TEXT) STRICT');
      } else {
        db.prepare('INSERT INTO receive_admission (operation_id, count_key, ordinal) VALUES (?, ?, 0)').run(input.operationId, COUNT_KEY);
        db.exec('CREATE INDEX delivery_peer_id ON delivery (payload_hash)');
      }
      const schema = () => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all();
      const before = { schema: schema(), versions: versions(db), delivery: db.prepare('SELECT * FROM delivery').all(), counts: db.prepare('SELECT * FROM receive_admission').all() };
      expect(() => migrate(db, MIGRATIONS.slice(0, version))).toThrow(/already exists/);
      expect(schema()).toEqual(before.schema);
      expect(versions(db)).toEqual(before.versions);
      expect(db.prepare('SELECT * FROM delivery').all()).toEqual(before.delivery);
      expect(db.prepare('SELECT * FROM receive_admission').all()).toEqual(before.counts);
    } finally { db.close(); }
  });

  it('v5 backfills epoch milliseconds across offsets and fractional precision, preserving tie order', async () => {
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, 4));
      const times = [
        '2026-10-26T09:00:00.002+08:00', '2026-10-26T01:00:00.001Z', '2026-10-26T09:00:00.001+08:00',
        '2026-10-26T01:00:00.999999Z', '2026-10-26T01:00:00.1Z', '2026-10-26T09:00:00.12+08:00', '2026-10-26T01:00:00Z',
        '2026-10-26T16:30:00+15:30', '2026-10-25T22:30:00.003-02:30',
      ];
      for (const [i, timestamp] of times.entries()) {
        const input = payloadInput({ operationId: op(`old-${i}`), at: timestamp });
        db.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
          accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(input.operationId, input.kind, input.sourceCallRef!, input.payloadHash, input.proposalRevision,
            canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ payload: input.payload, context: input.context }), timestamp);
      }
      migrate(db);
      expect(db.prepare('SELECT accepted_ms FROM delivery ORDER BY rowid').all()).toEqual(times.map((time) => ({ accepted_ms: Date.parse(time) })));
      expect((await new SqliteDeliveryStore(db).listByState('pending')).map((r) => r.operationId))
        .toEqual(['old-6', 'old-7', 'old-1', 'old-2', 'old-0', 'old-8', 'old-4', 'old-5', 'old-3']);
    } finally { db.close(); }
  });

  it('T022 r2 P2-2 an unparsable accepted_at still opens the database; reading that record fails closed', async () => {
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, 4));
      const input = payloadInput({ operationId: op('bad-time') });
      db.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
        accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not-a-time')`)
        .run(input.operationId, input.kind, input.sourceCallRef!, input.payloadHash, input.proposalRevision,
          canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ payload: input.payload, context: input.context }));
      expect(migrate(db)).toBe(latestVersion());
      expect(db.prepare('SELECT accepted_ms FROM delivery').get()).toEqual({ accepted_ms: 0 });
      await expect(new SqliteDeliveryStore(db).get(op('bad-time'))).rejects.toMatchObject({ name: 'StoredDataError' });
    } finally { db.close(); }
  });

  it('v5 upgrades v4 transfer links to pending records with known preallocation facts', async () => {
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, 4));
      const input = provisionInput();
      db.prepare(`INSERT INTO delivery (operation_id, kind, payload_hash, proposal_revision,
        accepted_target, target, body, state, accepted_at) VALUES (?, 'provision', ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(input.operationId, input.payloadHash, input.proposalRevision, canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ spec: input.spec }), input.at);
      db.prepare('INSERT INTO provision (operation_id, binding_key) VALUES (?, ?)').run(input.operationId, input.target.provision!.bindingKey);
      for (const known of [true, false]) {
        const proposal = { ...fixtureSnapshot.transfers[1]!, id: TransferId.parse(known ? 'known' : 'not-accepted'), revision: 1,
          state: 'approved', approvedRevision: 1, approvedAt: at(),
          provision: { operationId: known ? input.operationId : op('not-accepted'), bindingKey: input.target.provision!.bindingKey } };
        db.prepare('INSERT INTO transfer_proposal (id, revision, created_ms, body) VALUES (?, ?, ?, ?)')
          .run(proposal.id, proposal.revision, Date.parse(proposal.createdAt), JSON.stringify(proposal));
      }
      migrate(db);
      const transfers = createRepositories(db).transfers;
      expect((await transfers.get(TransferId.parse('known')))?.provision).toEqual(input.target.provision);
      expect((await transfers.get(TransferId.parse('not-accepted')))?.provision)
        .toEqual({ operationId: 'not-accepted', bindingKey: input.target.provision!.bindingKey, state: 'pending', preallocated: false });
    } finally { db.close(); }
  });

  it('v5 refuses legacy duplicate source calls without partial migration or deleting records', () => {
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, 4));
      for (const id of ['a', 'b']) {
        const input = payloadInput();
        db.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
          accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(id, input.kind, 'same-call', input.payloadHash, input.proposalRevision,
            canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ payload: input.payload, context: input.context }), input.at);
      }
      expect(() => migrate(db)).toThrow(/UNIQUE/);
      expect(versions(db)).toHaveLength(4);
      expect(db.prepare('SELECT operation_id FROM delivery ORDER BY rowid').all()).toEqual([{ operation_id: 'a' }, { operation_id: 'b' }]);
      expect(db.prepare('PRAGMA table_info(delivery)').all().some((r) => r.name === 'accepted_ms')).toBe(false);
    } finally { db.close(); }
  });

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
  it('v4 preserves 0.4 pending/unknown/sent deliveries, attempts and single-count admissions', async () => {
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 2));
    const records = ['pending', 'unknown', 'sent'].map((state) => {
      const input = payloadInput({ operationId: op(`old-${state}`) });
      const claim = claimInput(input.operationId);
      const nativeRef = { sessionRef: THREAD };
      const evidence = { kind: 'live-ack', at: at(11), detail: 'accepted' };
      old.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
        accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.operationId, input.kind, `call-${state}`, input.payloadHash, input.proposalRevision,
          canonicalJson(input.target), canonicalJson(input.target), canonicalJson({ payload: input.payload, context: input.context }), state, input.at);
      old.prepare('INSERT INTO receive_admission (operation_id, count_key) VALUES (?, ?)').run(input.operationId, COUNT_KEY);
      if (state !== 'pending') old.prepare(`INSERT INTO dispatch_attempt
        (attempt_id, operation_id, seq, client_message_id, state, dispatch_started_at, native_ref, evidence)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(claim.attemptId, input.operationId, claim.clientMessageId, state, claim.at,
          state === 'sent' ? canonicalJson(nativeRef) : null, state === 'sent' ? canonicalJson(evidence) : null);
      return { input, claim, state, nativeRef, evidence };
    });
    old.close();
    const upgraded = openDatabase(path);
    try {
      const store = new SqliteDeliveryStore(upgraded);
      for (const { input, claim, state, nativeRef, evidence } of records) {
        const record = await store.findBySourceCallRef(`call-${state}`);
        expect(record).toMatchObject({ operationId: input.operationId, delivery: { state }, payload: input.payload });
        expect(record).not.toHaveProperty('sender');
        expect(record).not.toHaveProperty('outcome');
        if (state !== 'pending') expect(record?.delivery.attempts[0]).toMatchObject({ attemptId: claim.attemptId, clientMessageId: claim.clientMessageId, state });
        if (state === 'sent') expect(record?.delivery.attempts[0]).toMatchObject({ nativeRef, evidence });
      }
      expect(upgraded.prepare('SELECT count(*) AS n FROM receive_admission WHERE ordinal = 0').get()).toEqual({ n: 3 });
      expect(await store.accept(payloadInput())).toMatchObject({ status: 'limit-exceeded', count: 3 });
      expect((await createRepositories(upgraded).readSnapshotData()).handoffs).toEqual([]);
      expect((await store.accept(payloadInput({ counts: [{ key: COUNT_KEY, limit: 4 }, { key: 'new-key' }] }))).status).toBe('accepted');
      expect(upgraded.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 5 });
    } finally { upgraded.close(); }
  });

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
      expect(versions(db).map((v) => v.version)).toEqual(MIGRATIONS.map((m) => m.version));
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual(['0.5.0']);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual(['0.5.0']);
      expect(data.conversations.permissionRequests[0]).toMatchObject({ kind: 'mcpElicitation', server: elicitation.elicitation?.serverName });
    } finally {
      db.close();
    }
  });
});
