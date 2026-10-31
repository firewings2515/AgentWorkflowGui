// Storage under contracts 0.6 (T028): records written by 0.5 read after migration v6, projects are saved,
// and the delivery store answers by target session (C-20). The memory store answers the same.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import type { DeliveryStore } from '../../core/ports';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
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
      expect(data.agents.map((a) => a.schemaVersion)).toEqual(['0.6.0']);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual(['0.6.0']);
      expect(data.instances).toHaveLength(1);
      expect(data.instances[0]).toMatchObject({ template: { schemaVersion: '0.6.0' }, rounds: [], mergeQueue: [], taskPlans: [], taskLimit: 3 });
      expect(data.projects).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('saves projects with compare-and-set, kept across a reopen', async () => {
    const project = { ...fixtureSnapshotInput.projects![0]!, schemaVersion: '0.6.0' as const };
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
