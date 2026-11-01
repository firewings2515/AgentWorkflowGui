import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerMessageId, SessionId, TransferProposal, WorkflowInstance } from '../../contracts';
import { fixtureSnapshot as fx } from '../../contracts/fixtures/snapshot';
import { StoredDataError } from './codec';
import { DELIVERY_BY_TARGET_SQL } from './delivery-target-query';
import { SqliteDeliveryStore } from './delivery-store';
import { MIGRATIONS, latestVersion, migrate } from './migrations';
import { createRepositories } from './repositories';
import { at, claimInput, op, payloadInput, provisionInput } from './testing/fixtures';

const databases: DatabaseSync[] = [];
const oldDatabase = (version = 5) => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS.slice(0, version));
  return db;
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const omit = (record: object, ...keys: string[]) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const version = (db: DatabaseSync) => db.prepare('SELECT max(version) AS version FROM schema_migration').get()?.version;
const schema = (db: DatabaseSync) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all();

/**
 * The index exactly as migration v7 created it (T029 r1 P2-3). Migrations are never edited: if this text
 * changes, a database upgraded earlier keeps the old index and its target query falls back to a scan.
 */
const V7_INDEX = `CREATE INDEX delivery_by_target ON delivery (CASE WHEN json_valid(target) THEN
  CASE WHEN json_type(target) = 'object' AND json_type(target, '$.sessionId') = 'text'
    AND json_extract(target, '$.sessionId') <> '' THEN json_extract(target, '$.sessionId') END
  END, accepted_ms)`;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

describe('v7 index (T029 r1 P2-3, P2-4)', () => {
  it.each([0, 5, 6])('from version %i the index is the frozen v7 text and the target query seeks it', (from) => {
    const db = oldDatabase(from);
    migrate(db, MIGRATIONS);
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'delivery_by_target'").get();
    expect(flat(row?.sql)).toBe(flat(V7_INDEX));
    const details = db.prepare(`EXPLAIN QUERY PLAN ${DELIVERY_BY_TARGET_SQL}`).all('session-x').map((r) => String(r.detail));
    expect(details.filter((d) => /SEARCH delivery USING INDEX delivery_by_target/.test(d))).toHaveLength(2);
  });
});

describe('v5 → v6 → v7 compatibility', () => {
  it('reads all 64 legacy run/task/cycle shapes, including old worktrees and ended runs with unfinished work', async () => {
    const db = oldDatabase();
    const base = fx.instances[0]!;
    const template = { ...omit(base.template, 'setupOverride'), schemaVersion: '0.5.0' };
    const expected: WorkflowInstance[] = [];
    const write = db.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)');
    for (const state of ['running', 'blocked', 'completed', 'cancelled'] as const) {
      for (const status of ['pending', 'running', 'blocked', 'awaiting-merge', 'merging', 'merged', 'failed', 'cancelled'] as const) {
        for (const cycle of [false, true]) {
          const id = `old-${state}-${status}-${cycle}`;
          // Explicit 0.5 fields: no new instance/task fields or worktree cleanup/baseCommit.
          const instance = {
            id, revision: 3, workflowId: base.workflowId, workflowRevision: base.workflowRevision,
            title: 'legacy', rootSessionId: base.rootSessionId, state, template, createdAt: base.createdAt,
            tasks: ['a', 'b'].map((task, i) => ({ id: task, instanceId: id, title: task, status,
              dependsOn: cycle ? [i === 0 ? 'b' : 'a'] : [], reworkCount: i,
              ...(i === 0 && { worktree: { path: 'E:/legacy/task', branch: 'task/legacy' } }),
            })),
          };
          write.run(id, instance.revision, expected.length, JSON.stringify(instance));
          expected.push(WorkflowInstance.parse({ ...instance, template: { ...template, schemaVersion: '0.7.0' } }));
        }
      }
    }
    expect(migrate(db)).toBe(latestVersion());
    expect(migrate(db)).toBe(latestVersion());
    const repos = createRepositories(db);
    expect(expected).toHaveLength(64);
    expect(await repos.instances.list()).toEqual(expected);
    for (const instance of expected) {
      expect(await repos.instances.get(instance.id)).toEqual(instance);
      expect(instance).toMatchObject({ rounds: [], mergeQueue: [], taskPlans: [], taskLimit: 3 });
      expect(instance.endedAt).toBeUndefined();
      expect(instance.targetBranch).toBeUndefined();
      expect(instance.tasks[0]?.worktree?.cleanup).toBe('active');
      expect(instance.tasks[0]?.completedAt).toBeUndefined();
    }
    expect((await repos.readSnapshotData()).instances).toEqual(expected);
  });

  it('preserves 0.5 transfer states and all five delivery kinds in pending/unknown/sent states', async () => {
    const db = oldDatabase();
    const store = new SqliteDeliveryStore(db);
    const deliveryBefore = [];
    for (const kind of ['handoff', 'peer-message', 'transfer', 'user-message', 'provision'] as const) {
      for (const state of ['pending', 'unknown', 'sent'] as const) {
        const id = `${kind}-${state}`;
        const input = kind === 'provision' ? provisionInput({}, id) : payloadInput({ kind, operationId: op(id), counts: undefined,
          ...(kind === 'peer-message' && { peer: { peerMessageId: PeerMessageId.parse(id), fromSessionId: SessionId.parse('sender'), toSessionId: SessionId.parse('session-target') } }),
        });
        expect((await store.accept(input)).status).toBe('accepted');
        if (state !== 'pending') {
          const claim = claimInput(input.operationId, { expectedNativeSessionRef: kind === 'provision' ? undefined : input.target.nativeSessionRef });
          expect((await store.claim(claim)).status).toBe('claimed');
          if (state === 'sent') {
            const sessionRef = input.kind === 'provision' ? input.spec.preallocatedRef! : input.target.nativeSessionRef!;
            expect(await store.recordSent(input.operationId, claim.attemptId, { sessionRef }, { kind: 'live-ack', at: at(11), detail: 'ack' })).toBe('recorded');
          }
        }
        deliveryBefore.push(await store.get(input.operationId));
      }
    }
    const proposals: TransferProposal[] = [];
    for (const state of ['draft', 'awaiting-confirmation', 'stale', 'approved', 'failed', 'cancelled'] as const) {
      const approved = state === 'approved' || state === 'failed';
      const proposal = TransferProposal.parse({ ...fx.transfers[1], id: `legacy-${state}`, operationId: `legacy-op-${state}`, state, revision: approved ? 1 : 0,
        ...(approved && { approvedRevision: 1, approvedAt: at(), provision: provisionInput({}, `unaccepted-${state}`).target.provision }),
        ...(state === 'failed' && { failure: { message: 'creation failed' } }),
        ...(state === 'cancelled' && { cancelledAt: at() }),
      });
      db.prepare('INSERT INTO transfer_proposal (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(proposal.id, proposal.revision, proposals.length, JSON.stringify(proposal));
      proposals.push(proposal);
    }
    const before = { deliveries: db.prepare('SELECT * FROM delivery').all(), attempts: db.prepare('SELECT * FROM dispatch_attempt').all(), proposals: db.prepare('SELECT * FROM transfer_proposal').all() };
    expect(migrate(db)).toBe(latestVersion());
    expect(db.prepare('SELECT * FROM delivery').all()).toEqual(before.deliveries);
    expect(db.prepare('SELECT * FROM dispatch_attempt').all()).toEqual(before.attempts);
    expect(db.prepare('SELECT * FROM transfer_proposal').all()).toEqual(before.proposals);
    for (const record of deliveryBefore) {
      expect(await store.get(record!.operationId)).toEqual(record);
      expect(await store.listByTarget(record!.target.sessionId!)).toContainEqual(record);
    }
    const repos = createRepositories(db);
    expect(await repos.transfers.list()).toEqual(proposals);
    for (const proposal of proposals) expect(await repos.transfers.get(proposal.id)).toEqual(proposal);
    const snapshot = await repos.readSnapshotData();
    expect(snapshot.transfers).toEqual(proposals);
    expect(snapshot.handoffs).toHaveLength(3);
    expect(snapshot.peerMessages).toHaveLength(3);
    expect(snapshot.projects).toEqual([]);
  });

  it.each(['{', 'null', '{"sessionId":""}', '{"provision":null}'])('indexes legacy damaged target %s safely, then reads fail closed', async (target) => {
    const db = oldDatabase();
    const store = new SqliteDeliveryStore(db);
    await store.accept(payloadInput());
    db.prepare('UPDATE delivery SET target = ?').run(target);
    expect(migrate(db)).toBe(latestVersion());
    await expect(store.listByTarget(SessionId.parse('anyone'))).rejects.toBeInstanceOf(StoredDataError);
    await expect(createRepositories(db).readSnapshotData()).rejects.toBeInstanceOf(StoredDataError);
  });
});

describe('v7 migration rollback', () => {
  it.each([5, 6])('rolls back data, schema and versions from v%i when v7 cannot be recorded', async (start) => {
    const db = oldDatabase(start);
    const agent = { ...fx.agents[0]!, schemaVersion: start === 5 ? '0.5.0' : '0.6.0' };
    db.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(agent));
    await new SqliteDeliveryStore(db).accept(payloadInput());
    // Fail after CREATE INDEX, at the version write: the index and earlier pending v6 changes must roll back.
    db.exec("CREATE TRIGGER fail_v7 BEFORE INSERT ON schema_migration WHEN NEW.version = 7 BEGIN SELECT RAISE(ABORT, 'migration:test-failure'); END");
    const before = { schema: schema(db), agent: db.prepare('SELECT * FROM agent').all(), delivery: db.prepare('SELECT * FROM delivery').all(), versions: db.prepare('SELECT * FROM schema_migration').all() };
    expect(() => migrate(db)).toThrow('migration:test-failure');
    expect(version(db)).toBe(start);
    expect(schema(db)).toEqual(before.schema);
    expect(db.prepare('SELECT * FROM agent').all()).toEqual(before.agent);
    expect(db.prepare('SELECT * FROM delivery').all()).toEqual(before.delivery);
    expect(db.prepare('SELECT * FROM schema_migration').all()).toEqual(before.versions);
    db.exec('DROP TRIGGER fail_v7');
    expect(migrate(db)).toBe(latestVersion());
    expect((await createRepositories(db).agents.get(agent.id))?.schemaVersion).toBe('0.7.0');
  });

  it('fails closed on damaged v5 JSON during v6, leaving v7 unapplied and original bytes intact', () => {
    const db = oldDatabase();
    db.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, 0, 0, ?)').run('damaged', 'SECRET invalid JSON');
    const before = schema(db);
    expect(() => migrate(db)).toThrow(/malformed JSON/);
    expect(() => migrate(db)).not.toThrow(/SECRET/);
    expect(version(db)).toBe(5);
    expect(schema(db)).toEqual(before);
    expect(db.prepare('SELECT body FROM workflow_instance').get()?.body).toBe('SECRET invalid JSON');
  });
});
