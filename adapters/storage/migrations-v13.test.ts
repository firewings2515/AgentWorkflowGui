// Storage under contracts 0.10 (T059): a v12 database written by 0.9 opens after migration v13. Agents, workflow
// templates, projects and the template pinned in each instance carry 0.10.0; sessions, runs and preferences read as they
// were (not archived, autoArchiveDays 14). The archive marks live in the session and instance bodies and the days in the
// preferences body, so v13 adds no table, column or index. Also the last-message query of the auto-archive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoArchiveDaysOf, CONTRACTS_VERSION, InstanceId, MessageId, NativeTaskId, SessionId, UiPreferences, WorkflowInstance } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { openDatabase } from './database';
import { latestVersion, MIGRATIONS, migrate } from './migrations';
import { createRepositories } from './repositories';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t059-'));
  path = join(dir, 'awg.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const as09 = <T extends object>(record: T) => ({ ...record, schemaVersion: '0.9.0' });
const oldPreferences = { theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 }, pinned: { chat: ['s-1'], workflow: [] } };
const at = '2026-11-05T10:00:00.000Z';

/** A v12 database with what 0.9 wrote. */
const v12 = () => {
  const old = new DatabaseSync(path);
  migrate(old, MIGRATIONS.slice(0, 12));
  const agent = fixtureSnapshotInput.agents[0]!;
  const workflow = fixtureSnapshotInput.workflows[0]!;
  const project = fixtureSnapshotInput.projects![0]!;
  const instance = fixtureSnapshotInput.instances[0]!;
  const session = fixtureSnapshotInput.sessions.find((s) => s.kind === 'ordinary')!;
  old.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify(as09(agent)));
  old.prepare('INSERT INTO workflow (id, revision, body) VALUES (?, ?, ?)').run(workflow.id, workflow.revision, JSON.stringify(as09(workflow)));
  old.prepare('INSERT INTO project (id, revision, body) VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(as09(project)));
  old.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(instance.id, instance.revision ?? 0, 0, JSON.stringify({ ...instance, template: as09(instance.template) }));
  old.prepare('INSERT INTO logical_session (id, revision, created_ms, body) VALUES (?, ?, ?, ?)').run(session.id, session.revision, 0, JSON.stringify(session));
  old.prepare('INSERT INTO preference (id, body) VALUES (1, ?)').run(JSON.stringify(oldPreferences));
  old.close();
  return { session, instance };
};

describe('v13: data stored under contracts 0.9', () => {
  it('reads every record as it was, the versioned ones at 0.10.0; not archived; the auto-archive at 14 days', async () => {
    const { session, instance } = v12();
    const db = openDatabase(path);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_migration').get()?.v).toBe(13);
      expect(latestVersion()).toBe(13);
      expect(CONTRACTS_VERSION).toBe('0.10.0');
      const data = await createRepositories(db).readSnapshotData();
      expect(data.agents.map((a) => a.schemaVersion)).toEqual(['0.10.0']);
      expect(data.workflows.map((w) => w.schemaVersion)).toEqual(['0.10.0']);
      expect(data.projects.map((p) => p.schemaVersion)).toEqual(['0.10.0']);
      expect(data.instances.map((i) => i.template.schemaVersion)).toEqual(['0.10.0']);
      expect(data.instances[0]).toMatchObject({ id: instance.id, title: instance.title });
      expect(data.instances[0]!.archivedAt).toBeUndefined();
      const read = data.sessions.find((s) => s.id === session.id)!;
      expect(read).toMatchObject({ title: session.title, cwd: session.cwd });
      expect(read).not.toHaveProperty('archivedAt');
      expect(data.preferences).toEqual(oldPreferences);
      expect(autoArchiveDaysOf(data.preferences)).toBe(14);
    } finally {
      db.close();
    }
  });

  it('archive marks and the days are saved and read back; a second migrate changes nothing', async () => {
    const { session, instance } = v12();
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      const stored = (await repos.sessions.get(SessionId.parse(session.id)))!;
      expect(await repos.sessions.update({ ...stored, archivedAt: at } as typeof stored, stored.revision)).toMatchObject({ status: 'saved' });
      expect(await repos.sessions.get(stored.id)).toMatchObject({ archivedAt: at, revision: stored.revision + 1 });
      const run = (await repos.instances.get(InstanceId.parse(instance.id)))!;
      const ended = WorkflowInstance.parse({ ...run, revision: run.revision + 1, state: 'cancelled', endedAt: at, tasks: [], rounds: [], mergeQueue: [], taskPlans: [], archivedAt: at });
      expect(await repos.instances.update(ended, run.revision)).toMatchObject({ status: 'saved' });
      expect(await repos.instances.get(run.id)).toMatchObject({ archivedAt: at });
      // A run not ended is never stored with the mark (the storage checks the record too).
      await expect(repos.instances.update({ ...run, revision: run.revision + 2, archivedAt: at }, run.revision + 1)).rejects.toThrow();
      await repos.preferences.set(UiPreferences.parse({ ...oldPreferences, autoArchiveDays: null }));
      expect(autoArchiveDaysOf(await repos.preferences.get())).toBeNull();
      await repos.preferences.set(UiPreferences.parse({ ...oldPreferences, autoArchiveDays: 30 }));
      expect(autoArchiveDaysOf(await repos.preferences.get())).toBe(30);
      const before = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
      expect(migrate(db)).toBe(latestVersion());
      expect(db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()).toEqual(before);
      expect(await repos.sessions.get(stored.id)).toMatchObject({ archivedAt: at });
    } finally {
      db.close();
    }
  });
});

describe('latestMessageMs (the auto-archive\'s last-message time, Q-17)', () => {
  it('the newest user or assistant message of the main conversation, compared as instants; undefined without one', async () => {
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      const base = fixtureSnapshotInput.sessions.find((s) => s.kind === 'ordinary')!;
      const sessionId = SessionId.parse('s-latest');
      expect(await repos.sessions.create({ ...base, id: sessionId, revision: 0 } as never)).toBe('created');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBeUndefined();
      let n = 0;
      const add = (createdAt: string, role: 'user' | 'assistant' | 'system', nativeTaskId?: string) =>
        repos.conversations.appendMessage({
          id: MessageId.parse(`m-${String(++n)}`), sessionId, role, origin: { kind: role === 'assistant' ? 'agent' : role === 'system' ? 'system' : 'user' },
          text: 'x'.repeat(n === 2 ? 100_000 : 3), attachments: [], createdAt,
          ...(nativeTaskId !== undefined && { nativeTaskId: NativeTaskId.parse(nativeTaskId) }),
        });
      await add('2026-11-01T00:00:00.000Z', 'system');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBeUndefined();
      // A long text moved to the blob table still counts.
      await add('2026-11-02T08:00:00+08:00', 'user');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBe(Date.parse('2026-11-02T00:00:00.000Z'));
      await add('2026-11-03T00:00:00.000Z', 'assistant');
      await add('2026-11-04T00:00:00.000Z', 'system');
      await add('2026-11-05T00:00:00.000Z', 'assistant', 'nt-1');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
      // Mixed offsets: an instant, not the string, decides.
      await add('2026-11-03T07:00:00+08:00', 'user');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
      await add('2026-11-03T09:00:00+08:00', 'user');
      expect(await repos.conversations.latestMessageMs(sessionId)).toBe(Date.parse('2026-11-03T01:00:00.000Z'));
    } finally {
      db.close();
    }
  });
});
