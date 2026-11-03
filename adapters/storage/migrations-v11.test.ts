// Storage under contracts 0.8 (T048): a v10 database written by 0.7 opens after migration v11. Agents, workflow
// templates, projects and the template pinned in each instance carry 0.8.0; sessions (each with an Agent and a
// folder), runs with one folder and preferences without a work folder location read as they were; the work folder
// claims table is there and keeps one claim per session and per folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, SessionId, type Timestamp } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t048-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const as07 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.7.0' });

/** A v10 database with what 0.7 wrote. */
const v10 = () => {
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 10));
  const agent = fixtureSnapshotInput.agents[0]!;
  const workflow = fixtureSnapshotInput.workflows[0]!;
  const project = fixtureSnapshotInput.projects![0]!;
  const instance = fixtureSnapshotInput.instances[0]!;
  const session = fixtureSnapshotInput.sessions.find((s) => s.kind === 'ordinary')!;
  old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as07(agent)));
  old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as07(workflow)));
  old.prepare('INSERT INTO project (id, revision, body) VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(as07(project)));
  old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as07(instance.template) }));
  old.prepare('INSERT INTO logical_session (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(session.id, session.revision, 0, JSON.stringify(session));
  old.prepare('INSERT INTO preference (id, body) VALUES (1, ?)').run(JSON.stringify({ theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 } }));
  old.close();
  return { agent, session, instance };
};

describe('v11: data stored under contracts 0.7', () => {
  it('reads every record as it was, the versioned ones at 0.8.0', async () => {
    const { session, instance } = v10();
    const db = openDatabase(path);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_migration').get()?.v).toBe(latestVersion());
      const data = await createRepositories(db).readSnapshotData();
      expect(CONTRACTS_VERSION).toBe('0.8.0');
      expect(data.agents.map((a) => a.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.projects.map((p) => p.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual([CONTRACTS_VERSION]);
      // A run with one folder: neither of the 0.8 folders recorded.
      expect(data.instances[0]).toMatchObject({ id: instance.id });
      expect(data.instances[0]?.workFolder).toBeUndefined();
      expect(data.instances[0]?.projectFolder).toBeUndefined();
      // The session keeps its Agent, folder and title, and is not waiting for one.
      const read = data.sessions.find((s) => s.id === session.id);
      expect(read).toMatchObject({ agent: session.agent, cwd: session.cwd, title: session.title });
      expect(read?.autoTitle).toBeUndefined();
      expect(data.preferences).toEqual({ theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 } });
    } finally {
      db.close();
    }
  });

  it('the claims table: one claim per session and per folder (compared without case); a second migrate changes nothing', async () => {
    v10();
    const db = openDatabase(path);
    try {
      const claims = createRepositories(db).workFolders;
      const at = '2026-11-04T01:00:00.000Z' as Timestamp;
      const claim = (id: string, folder: string, seq: number) => claims.claim({ sessionId: SessionId.parse(id), path: folder, day: '2026-11-04', seq, createdAt: at });
      expect(await claim('s-1', 'C:\\W\\2026-11-04-001', 1)).toBe('claimed');
      expect(await claim('s-2', 'c:\\w\\2026-11-04-001', 1)).toBe('taken');
      expect(await claim('s-1', 'C:\\W\\2026-11-04-002', 2)).toBe('taken');
      expect(await claims.listDay('2026-11-04')).toHaveLength(1);
      expect(await claims.listDay('2026-11-05')).toEqual([]);
      const before = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
      expect(migrate(db)).toBe(latestVersion());
      expect(db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()).toEqual(before);
      await claims.remove(SessionId.parse('s-1'));
      expect(await claims.list()).toEqual([]);
      expect(await claim('s-2', 'c:\\w\\2026-11-04-001', 1)).toBe('claimed');
    } finally {
      db.close();
    }
  });
});
