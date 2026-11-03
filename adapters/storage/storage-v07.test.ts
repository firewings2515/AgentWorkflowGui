// Storage under contracts 0.7 (T037): records written by 0.6 read after migration v8 (T037 r1 P2-2): agents,
// workflow templates, projects, the template pinned in an instance, and preferences saved without `supervisor`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTRACTS_VERSION } from '../../contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t037-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('v8: data stored under contracts 0.6', () => {
  it('reads every record that carries the contracts version, and preferences without supervisor settings', async () => {
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 7));
    const as06 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.6.0' });
    const agent = fixtureSnapshotInput.agents[0]!;
    const workflow = fixtureSnapshotInput.workflows[0]!;
    const project = fixtureSnapshotInput.projects![0]!;
    const instance = fixtureSnapshotInput.instances[0]!;
    old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as06(agent)));
    old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as06(workflow)));
    old.prepare('INSERT INTO project (id, revision, body) VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(as06(project)));
    old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as06(instance.template) }));
    old.prepare('INSERT INTO preference (id, body) VALUES (1, ?)').run(JSON.stringify({ theme: 'light' }));
    old.close();

    const db = openDatabase(path);
    try {
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.projects.map((p) => p.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.preferences).toEqual({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    } finally {
      db.close();
    }
  });
});
