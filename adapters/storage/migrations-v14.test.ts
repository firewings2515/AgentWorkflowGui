// Storage under contracts 0.11 (T063): a v13 database written by 0.10 opens after migration v14. The versioned records
// carry 0.11.0 and read as they were; the one-time marks table is new. An install in use (any Agent or workflow template)
// gets `starter-offered` at once, so the starter set is never added to it at start; an empty one gets nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, InstanceId, WorkflowId } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t063-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const as10 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.10.0' });
const agent = fixtureSnapshotInput.agents[0]!;
const workflow = fixtureSnapshotInput.workflows[0]!;

/** A v13 database with what 0.10 wrote: `with` says which definitions it holds. */
const v13 = (with_: { agent?: boolean; workflow?: boolean; instance?: boolean }) => {
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 13));
  if (with_.agent) old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as10(agent)));
  if (with_.workflow) old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as10(workflow)));
  if (with_.instance) {
    const instance = fixtureSnapshotInput.instances[0]!;
    old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as10(instance.template) }));
  }
  old.close();
};

const offered = async (db: DatabaseSync) => createRepositories(db).markers.has('starter-offered');

describe('v14: data stored under contracts 0.10', () => {
  it('reads every record as it was, the versioned ones at the current version (0.11.0 by v14, moved on by later migrations); the template pinned in a run too', async () => {
    v13({ agent: true, workflow: true, instance: true });
    const db = openDatabase(path);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_migration').get()?.v).toBe(latestVersion());
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows[0]).toMatchObject({ id: workflow.id, name: workflow.name, revision: workflow.revision });
    } finally {
      db.close();
    }
  });

  it('an empty database gets no mark', async () => {
    v13({});
    const db = openDatabase(path);
    try {
      expect(await offered(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a database with an Agent gets the mark', async () => {
    v13({ agent: true });
    const db = openDatabase(path);
    try {
      expect(await offered(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a database with a workflow template gets the mark', async () => {
    v13({ workflow: true });
    const db = openDatabase(path);
    try {
      expect(await offered(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a new database gets no mark; a mark is set once, keeps its first time and survives a second migrate', async () => {
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      expect(await repos.markers.has('starter-offered')).toBe(false);
      await repos.markers.set('starter-offered', '2026-11-05T10:00:00.000Z');
      await repos.markers.set('starter-offered', '2026-11-06T10:00:00.000Z');
      expect(await repos.markers.has('starter-offered')).toBe(true);
      expect(db.prepare('SELECT at FROM app_marker WHERE name = ?').get('starter-offered')?.at).toBe('2026-11-05T10:00:00.000Z');
      expect(await repos.markers.has('other')).toBe(false);
      const before = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
      expect(migrate(db)).toBe(latestVersion());
      expect(db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()).toEqual(before);
      await expect(repos.markers.set('x', 'not a time')).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it('a template deleted with its revision leaves the run that pinned it whole', async () => {
    v13({ workflow: true, instance: true });
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      const id = WorkflowId.parse(workflow.id);
      expect(await repos.workflows.delete(id, workflow.revision + 5)).toBe('stale');
      expect(await repos.workflows.delete(id, workflow.revision)).toBe('deleted');
      expect(await repos.workflows.get(id)).toBeUndefined();
      const run = await repos.instances.get(InstanceId.parse(fixtureSnapshotInput.instances[0]!.id));
      expect(run?.template).toMatchObject({ id: fixtureSnapshotInput.instances[0]!.template.id, name: fixtureSnapshotInput.instances[0]!.template.name });
    } finally {
      db.close();
    }
  });
});
