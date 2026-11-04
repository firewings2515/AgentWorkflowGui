// Storage under contracts 0.9 (T050): a v11 database written by 0.8 opens after migration v12. Agents, workflow
// templates, projects and the template pinned in each instance carry 0.9.0; sessions, runs and preferences without
// pinned lists read as they were (no pinned lists: both empty). The pinned lists are saved in the preferences body and
// a run's title is renamed by the instance's compare-and-set update, so v12 adds no table or column.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, InstanceId, pinnedOf, SessionId, UiPreferences } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t050-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const as08 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.8.0' });
const oldPreferences = { theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 }, workFolderRoot: 'D:\\Work' };

/** A v11 database with what 0.8 wrote: a run with its two folders, preferences with a location and no pinned lists. */
const v11 = () => {
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 11));
  const agent = fixtureSnapshotInput.agents[0]!;
  const workflow = fixtureSnapshotInput.workflows[0]!;
  const project = fixtureSnapshotInput.projects![0]!;
  const instance = { ...fixtureSnapshotInput.instances[0]!, workFolder: 'E:\\reports', projectFolder: 'E:\\repo' };
  const session = fixtureSnapshotInput.sessions.find((s) => s.kind === 'ordinary')!;
  old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as08(agent)));
  old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as08(workflow)));
  old.prepare('INSERT INTO project (id, revision, body) VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(as08(project)));
  old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as08(instance.template) }));
  old.prepare('INSERT INTO logical_session (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(session.id, session.revision, 0, JSON.stringify(session));
  old.prepare('INSERT INTO preference (id, body) VALUES (1, ?)').run(JSON.stringify(oldPreferences));
  old.close();
  return { session, instance };
};

describe('v12: data stored under contracts 0.8', () => {
  it('reads every record as it was, the versioned ones at 0.9.0; the preferences have no pinned lists', async () => {
    const { session, instance } = v11();
    const db = openDatabase(path);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_migration').get()?.v).toBe(12);
      expect(latestVersion()).toBe(12);
      expect(CONTRACTS_VERSION).toBe('0.9.0');
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.projects.map((p) => p.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances[0]).toMatchObject({ id: instance.id, title: instance.title, workFolder: 'E:\\reports', projectFolder: 'E:\\repo' });
      expect(data.sessions.find((s) => s.id === session.id)).toMatchObject({ title: session.title, cwd: session.cwd });
      expect(data.preferences).toEqual(oldPreferences);
      expect(pinnedOf(data.preferences)).toEqual({ chat: [], workflow: [] });
    } finally {
      db.close();
    }
  });

  it('pinned lists are saved and read back in order; a run is renamed in place; a second migrate changes nothing', async () => {
    const { instance } = v11();
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      const pinned = { chat: [SessionId.parse('s-2'), SessionId.parse('gone')], workflow: [InstanceId.parse(instance.id)] };
      await repos.preferences.set(UiPreferences.parse({ ...oldPreferences, pinned }));
      expect(await repos.preferences.get()).toEqual({ ...oldPreferences, pinned });
      // A list that breaks the contract is never stored (the storage checks the record too).
      await expect(repos.preferences.set({ ...(await repos.preferences.get()), pinned: { chat: [SessionId.parse('s-1'), SessionId.parse('s-1')], workflow: [] } })).rejects.toThrow();
      expect(pinnedOf(await repos.preferences.get())).toEqual(pinned);
      const run = (await repos.instances.get(InstanceId.parse(instance.id)))!;
      expect(await repos.instances.update({ ...run, revision: run.revision + 1, title: 'Renamed' }, run.revision)).toMatchObject({ status: 'saved' });
      expect(await repos.instances.get(run.id)).toMatchObject({ title: 'Renamed', revision: run.revision + 1 });
      const before = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
      expect(migrate(db)).toBe(latestVersion());
      expect(db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()).toEqual(before);
      expect(await repos.preferences.get()).toEqual({ ...oldPreferences, pinned });
    } finally {
      db.close();
    }
  });
});
