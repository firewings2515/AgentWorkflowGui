// Storage under contracts 0.12 (T070): a v14 database written by 0.11 opens after migration v15. The versioned records carry
// 0.12.0 and read as they were (the template pinned in a run too); the marks stay as they were, so an install that had the
// starter set offered is not offered it again, and nothing of the template library is added by a migration.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t070-'));
  path = join(dir, 'awg.sqlite');
});
// Only the temporary directory this test made.
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const as11 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.11.0' });

/** A v14 database with what 0.11 wrote. */
const v14 = (mark: boolean) => {
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 14));
  const agent = fixtureSnapshotInput.agents[0]!;
  const workflow = fixtureSnapshotInput.workflows[0]!;
  const project = fixtureSnapshotInput.projects?.[0];
  const instance = fixtureSnapshotInput.instances[0]!;
  old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as11(agent)));
  old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as11(workflow)));
  if (project !== undefined) old.prepare('INSERT INTO project (id, revision, body) VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(as11(project)));
  old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as11(instance.template) }));
  // v14 marked only what held data when it ran (here the database was empty then): the mark as 0.11 left it.
  if (mark) old.prepare('INSERT INTO app_marker (name, at) VALUES (?, ?)').run('starter-offered', '2026-11-06T00:00:00.000Z');
  old.close();
};

describe('v15: data stored under contracts 0.11', () => {
  it('is the latest migration, for contracts 0.12', () => {
    expect(latestVersion()).toBe(15);
    expect(MIGRATIONS.at(-1)).toMatchObject({ version: 15, name: 'contracts-0.12' });
    expect(CONTRACTS_VERSION).toBe('0.12.0');
  });

  it('reads every record as it was, at 0.12.0; the template pinned in a run too', async () => {
    v14(true);
    const db = openDatabase(path);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_migration').get()?.v).toBe(15);
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual(['0.12.0']);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual(['0.12.0']);
      expect(data.projects.every((p) => p.schemaVersion === '0.12.0')).toBe(true);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual(['0.12.0']);
      const workflow = fixtureSnapshotInput.workflows[0]!;
      expect(data.workflows[0]).toMatchObject({ id: workflow.id, name: workflow.name, revision: workflow.revision });
      expect(data.agents.map((a) => a.id)).toEqual([fixtureSnapshotInput.agents[0]!.id]);
    } finally {
      db.close();
    }
  });

  it('keeps the marks: set before, still set; absent before, still absent', async () => {
    v14(true);
    let db = openDatabase(path);
    try {
      expect(await createRepositories(db).markers.has('starter-offered')).toBe(true);
    } finally {
      db.close();
    }
    rmSync(path, { force: true });
    v14(false);
    db = openDatabase(path);
    try {
      expect(await createRepositories(db).markers.has('starter-offered')).toBe(false);
    } finally {
      db.close();
    }
  });
});
