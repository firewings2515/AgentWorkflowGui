// T048 on the assembled backend with a real SQLite file and real folders in a temporary directory: a session without
// an Agent or a folder through the facade, the Snapshot's default location, read-only data making no folder (C-29),
// and the start taking back the folders claimed for a session that never came.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, InstanceId, type OwnedProcess, RequestId, type Runtime, SessionId, Snapshot, WorkflowId } from '../../contracts';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agents, template, WORKFLOW } from '../../core/workflow/testing/harness';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY, STORAGE_TURNED_READ_ONLY } from './backend';
import { EventBus } from './event-bus';
import { resolveRealPath } from './real-path';
import { defaultWorkFolderRoot } from './work-folders';

const DAY = '2026-11-04';
let dir: string;
let location: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t048-'));
  location = join(dir, 'AgentWorkflowGui');
});
afterEach(async () => {
  for (const backend of running) await backend.shutdown().catch(() => undefined);
  running = [];
  // Only the temporary directory this test made.
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob() {
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned() {
    return Promise.resolve([] as OwnedProcess[]);
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

let requests = 0;
const rid = () => RequestId.parse(`r-${++requests}`);

const start = async (options: { faults?: InjectedStorageFaults; workFolders?: boolean } = {}) => {
  const logs: string[] = [];
  const adapters: FakeAdapter[] = [];
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus: new EventBus(),
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.push(adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    ...(options.faults !== undefined && { storageHooks: options.faults }),
    resolveRealPath,
    ...(options.workFolders !== false && { workFolders: { defaultRoot: location, day: () => DAY } }),
    now: () => new Date('2026-11-04T01:00:00.000Z'),
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  return { backend: result, adapters, logs, run: (command: Command) => result.facade.execute(command) as Promise<CommandResult> };
};
type Started = Awaited<ReturnType<typeof start>>;

const createBare = (s: Started, id: string) =>
  s.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', model: { runtime: 'codex', model: 'codex-m' } });
const startRun = (s: Started) =>
  s.run({
    type: 'workflow.start', requestId: rid(), instanceId: InstanceId.parse('run-1'), rootSessionId: SessionId.parse('root-1'), workflowId: WorkflowId.parse('wf-none'),
    workflowRevision: 0, title: 'Report', firstMessage: 'Go.', crossToolConsent: true,
  });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
const folder = (seq: string) => join(location, `${DAY}-${seq}`);

describe('T048 on the backend', () => {
  it('U-01/U-02: a session with no Agent and no folder gets a new folder; the Snapshot names the default location', async () => {
    const s = await start();
    expect(await createBare(s, 's-1')).toMatchObject({ ok: true });
    await settle();
    expect(existsSync(folder('001'))).toBe(true);
    const snap = Snapshot.parse(await s.backend.facade.snapshot());
    expect(snap.defaultWorkFolderRoot).toBe(location);
    const session = snap.sessions.find((x) => x.id === 's-1');
    expect(session).toMatchObject({ cwd: folder('001'), title: '新對話', autoTitle: true, folderScope: { workspaceRoot: resolveRealPath(folder('001')) } });
    expect(session?.agent).toBeUndefined();
    expect(s.adapters[0]?.started[0]?.instructions).toBeUndefined();
  });

  it('C-29: read-only data makes no folder, for a session or a run started without one', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults });
    // A write fills the disk: the data is read-only from here on.
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } } })).toMatchObject({ code: 'storage_read_only' });
    expect(await createBare(s, 's-1')).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_READ_ONLY });
    expect(await startRun(s)).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_READ_ONLY });
    expect(existsSync(location)).toBe(false);
  });

  it('C-29: the data turning read-only on the claim makes no folder, not even the location', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults });
    faults.failNextWrite('disk-full');
    expect(await createBare(s, 's-1')).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_TURNED_READ_ONLY });
    expect(existsSync(location)).toBe(false);
    expect(await s.backend.repositories.sessions.get(SessionId.parse('s-1'))).toBeUndefined();
  });

  it('the start takes back claims whose session never came: an empty folder goes, one with something in it stays', async () => {
    const first = await start();
    expect(await createBare(first, 's-kept')).toMatchObject({ ok: true });
    await settle();
    const claims = first.backend.repositories.workFolders;
    const claim = async (id: string, seq: number, made: boolean) => {
      const path = folder(String(seq).padStart(3, '0'));
      expect(await claims.claim({ sessionId: SessionId.parse(id), path, day: DAY, seq, state: 'claimed', createdAt: '2026-11-04T01:00:00.000Z' })).toBe('claimed');
      if (!made) return;
      // As our make left it: made, with its real path then.
      mkdirSync(path);
      await claims.markMade(SessionId.parse(id), resolveRealPath(path)!);
    };
    await claim('s-empty', 2, true);
    await claim('s-full', 3, true);
    writeFileSync(join(folder('003'), 'notes.txt'), 'mine');
    await claim('s-never-made', 4, false);
    // Claimed only, and someone else made a folder there: never ours to remove (r1 P1-1).
    await claim('s-not-ours', 5, false);
    mkdirSync(folder('005'));
    await first.backend.shutdown();
    running = [];

    const s = await start();
    expect((await s.backend.repositories.workFolders.list()).map((c) => c.sessionId)).toEqual(['s-kept']);
    expect(readdirSync(location).sort()).toEqual([`${DAY}-001`, `${DAY}-003`, `${DAY}-005`]);
    expect(readdirSync(folder('003'))).toEqual(['notes.txt']);
    expect(s.logs.some((l) => l.includes('kept work folder'))).toBe(true);
  });

  it('r1 P1-3: the data turning read-only on the session write, after the folder was made: no folder is left', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults });
    // The claim, its mark as made, then the session: the third write fills the disk.
    faults.failNextWrite('disk-full', 3);
    expect(await createBare(s, 's-1')).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_TURNED_READ_ONLY });
    expect(existsSync(folder('001'))).toBe(false);
    expect(await s.backend.repositories.sessions.get(SessionId.parse('s-1'))).toBeUndefined();
  });

  it('r1 P1-3: the data turning read-only on a run\'s start, after its work folder was made: no folder is left', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults });
    for (const a of agents()) expect(await s.run({ type: 'agent.save', requestId: rid(), agent: a, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await s.run({ type: 'workflow.save', requestId: rid(), workflow: template(), expectedRevision: null })).toMatchObject({ ok: true });
    faults.failNextWrite('disk-full', 3);
    expect(
      await s.run({
        type: 'workflow.start', requestId: rid(), instanceId: InstanceId.parse('run-1'), rootSessionId: SessionId.parse('root-1'), workflowId: WORKFLOW,
        workflowRevision: 0, title: 'Report', firstMessage: 'Go.', crossToolConsent: true,
      }),
    ).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(existsSync(folder('001'))).toBe(false);
  });

  it('r1 P1-4: a preferences save that turns the data read-only makes no folder', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults });
    const other = join(dir, 'elsewhere', 'Nested');
    faults.failNextWrite('disk-full');
    expect(
      await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 }, workFolderRoot: other } }),
    ).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false);
  });

  it('without work folders: the Snapshot names %USERPROFILE%\\AgentWorkflowGui for display, and a session needs a folder', async () => {
    const s = await start({ workFolders: false });
    expect(Snapshot.parse(await s.backend.facade.snapshot()).defaultWorkFolderRoot).toBe(defaultWorkFolderRoot());
    expect(await createBare(s, 's-1')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(existsSync(location)).toBe(false);
  });
});
