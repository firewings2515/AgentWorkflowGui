// Storage under contracts 0.6 (T028): records written by 0.5 read after migration v6, projects are saved,
// and the delivery store answers by target session (C-20). The memory store answers the same.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTRACTS_VERSION } from '../../contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import type { DeliveryStore } from '../../core/ports';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { StoredDataError } from './codec';
import { SqliteDeliveryStore } from './delivery-store';
import { MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';
import { op, payloadInput, provisionInput } from './testing/fixtures';

/** The record without `keys`, as an older version wrote it. */
const omit = <T extends object>(record: T, ...keys: string[]) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t028-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('v6: data stored under contracts 0.5', () => {
  it('reads Agents, workflow templates and the template pinned in an instance written by 0.5', async () => {
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 5));
    const as05 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.5.0' });
    const agent = fixtureSnapshotInput.agents[0]!;
    const workflow = fixtureSnapshotInput.workflows[0]!;
    // As 0.5 wrote it: none of the 0.6 lists or limits.
    const docs = fixtureSnapshotInput.instances[1]!;
    const instance = { ...omit(docs, 'rounds', 'mergeQueue', 'taskPlans', 'taskLimit', 'projectId', 'targetBranch'), template: as05(docs.template) };
    old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as05(agent)));
    old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as05(workflow)));
    old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(docs.id, docs.revision, 0, JSON.stringify(instance));
    old.close();

    const db = openDatabase(path);
    try {
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances).toHaveLength(1);
      expect(data.instances[0]).toMatchObject({ template: { schemaVersion: CONTRACTS_VERSION }, rounds: [], mergeQueue: [], taskPlans: [], taskLimit: 3 });
      expect(data.projects).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('saves projects with compare-and-set, kept across a reopen', async () => {
    const project = { ...fixtureSnapshotInput.projects![0]!, schemaVersion: CONTRACTS_VERSION };
    let db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      const saved = await repos.projects.save(project as never, null);
      expect(saved).toMatchObject({ status: 'saved', record: { revision: 0 } });
      expect(await repos.projects.save(project as never, null)).toMatchObject({ status: 'stale' });
      expect(await repos.projects.save({ ...project, name: 'renamed' } as never, 0)).toMatchObject({ status: 'saved', record: { revision: 1, name: 'renamed' } });
    } finally {
      db.close();
    }
    db = openDatabase(path);
    try {
      expect((await createRepositories(db).readSnapshotData()).projects.map((p) => [p.name, p.revision])).toEqual([['renamed', 1]]);
    } finally {
      db.close();
    }
  });
});

describe('C-20: delivery records by target session', () => {
  const run = async (store: DeliveryStore) => {
    const target = SessionId.parse('session-target');
    await store.accept(payloadInput());
    await store.accept(payloadInput({ operationId: op('op-2'), target: { sessionId: SessionId.parse('session-other'), nativeSessionRef: 'thread-B' } }));
    const provision = provisionInput();
    await store.accept(provision);
    expect((await store.listByTarget(target)).map((r) => r.operationId)).toEqual(['op-1']);
    expect((await store.listByTarget(provision.spec.sessionId)).map((r) => r.operationId)).toEqual([provision.operationId]);
    expect(await store.listByTarget(SessionId.parse('nobody'))).toEqual([]);
  };

  it('SQLite', async () => {
    const db = openDatabase(path);
    try {
      await run(new SqliteDeliveryStore(db));
    } finally {
      db.close();
    }
  });

  it('memory', async () => {
    await run(new MemoryDeliveryStore());
  });
});

// T028 review r1: the reviewer's repros.
describe('T028 r1', () => {
  it('P1-1: runs 0.5 could store still read after v6 (worktree without target branch, merged without completedAt, ended with running tasks)', async () => {
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 5));
    const login = fixtureSnapshotInput.instances[0]!;
    const as05 = { ...login.template, schemaVersion: '0.5.0' };
    const tasks = login.tasks.map((t) => omit(t, 'completedAt', 'setup', 'blockedReason'));
    const base = omit(login, 'rounds', 'mergeQueue', 'taskPlans', 'taskLimit', 'projectId', 'targetBranch');
    const runs = [
      { ...base, id: 'old-running', template: as05, tasks: tasks.map((t) => ({ ...t, instanceId: 'old-running' })) },
      { ...base, id: 'old-completed', state: 'completed', template: as05, tasks: tasks.map((t) => ({ ...t, instanceId: 'old-completed' })) },
      { ...base, id: 'old-cancelled', state: 'cancelled', template: as05, tasks: tasks.map((t) => ({ ...t, instanceId: 'old-cancelled' })) },
    ];
    for (const [i, run] of runs.entries()) old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(run.id, login.revision, i, JSON.stringify(run));
    old.close();

    const db = openDatabase(path);
    try {
      const instances = (await createRepositories(db).readSnapshotData()).instances;
      expect(instances.map((i) => [i.id, i.state, i.targetBranch])).toEqual([['old-running', 'running', undefined], ['old-completed', 'completed', undefined], ['old-cancelled', 'cancelled', undefined]]);
      expect(instances[0]?.tasks.find((t) => t.status === 'merged')?.completedAt).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('P1-2: settings with an exec-only write policy are stored for payloads and provisions', async () => {
    const db = openDatabase(path);
    try {
      const store = new SqliteDeliveryStore(db);
      const payload = payloadInput();
      const execOnly = { ...payload.context, session: { ...payload.context.session, readOnly: true, writePolicy: 'exec-only' as const } };
      expect((await store.accept({ ...payload, context: execOnly })).status).toBe('accepted');
      const provision = provisionInput();
      expect((await store.accept({ ...provision, spec: { ...provision.spec, writePolicy: 'exec-only' } })).status).toBe('accepted');
      const stored = await store.get(payload.operationId);
      expect(stored?.kind !== 'provision' && stored?.context.session.writePolicy).toBe('exec-only');
      const created = await store.get(provision.operationId);
      expect(created?.kind === 'provision' && created.spec.writePolicy).toBe('exec-only');
    } finally {
      db.close();
    }
  });

  it('P1-3: a damaged target fails the query instead of reading as no record', async () => {
    const db = openDatabase(path);
    try {
      const store = new SqliteDeliveryStore(db);
      await store.accept(payloadInput());
      db.prepare("UPDATE delivery SET target = '{' WHERE operation_id = ?").run('op-1');
      await expect(store.listByTarget(SessionId.parse('session-target'))).rejects.toThrow();
      await expect(store.listByTarget(SessionId.parse('anyone'))).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('T028 r2', () => {
  it('P1: a target that is JSON but cannot name its session fails the query; an unbound one is no one\'s', async () => {
    const db = openDatabase(path);
    try {
      const store = new SqliteDeliveryStore(db);
      await store.accept(payloadInput({ operationId: op('op-unbound'), target: {} }));
      expect(await store.listByTarget(SessionId.parse('session-target'))).toEqual([]);
      await store.accept(payloadInput());
      // r3 P1: also an empty sessionId, and objects without one that are not a valid unbound target.
      for (const damaged of ['{', 'null', '{"sessionId":42}', '[]', '{"sessionId":""}', '{"nativeSessionRef":42}', '{"provision":null}']) {
        db.prepare('UPDATE delivery SET target = ? WHERE operation_id = ?').run(damaged, 'op-1');
        await expect(store.listByTarget(SessionId.parse('session-target'))).rejects.toThrow(StoredDataError);
        await expect(store.listByTarget(SessionId.parse('anyone'))).rejects.toThrow(StoredDataError);
      }
      // Another session's record is still left out, and this session's is found.
      db.prepare('UPDATE delivery SET target = ? WHERE operation_id = ?').run('{"sessionId":"session-other","nativeSessionRef":"thread-B"}', 'op-1');
      expect(await store.listByTarget(SessionId.parse('session-target'))).toEqual([]);
      expect((await store.listByTarget(SessionId.parse('session-other'))).map((r) => r.operationId)).toEqual(['op-1']);
    } finally {
      db.close();
    }
  });
});
