// T063 on the assembled backend with a real SQLite file in a temporary directory: the starter set at a first start (once,
// never again after a delete or into an install in use, never from read-only data), and workflow.delete and
// workflow.addStarter through the IPC parse and the read-only gate (C-29).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Command,
  type CommandResult,
  type OwnedProcess,
  RequestId,
  type Runtime,
  type SessionId,
  Snapshot,
  STARTER_AGENT_IDS,
  STARTER_WORKFLOW_ID,
} from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import { MIGRATIONS, migrate } from '../../adapters/storage/migrations';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { runCommand } from './app-ipc';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY } from './backend';
import { EventBus } from './event-bus';

let dir: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t063-'));
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
const dbPath = () => join(dir, 'awg.sqlite');

const start = async (faults?: InjectedStorageFaults) => {
  const bus = new EventBus();
  const logs: string[] = [];
  const result = await startBackend({
    dbPath: dbPath(),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: ['high'], isDefault: true, hidden: false }]),
    ...(faults !== undefined && { storageHooks: faults }),
    autoArchive: false,
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
  const snapshot = async () => Snapshot.parse(await result.facade.snapshot());
  const close = async () => {
    await result.shutdown();
    running = running.filter((b) => b !== result);
  };
  return { backend: result, logs, run, snapshot, close, raw: (command: unknown) => runCommand(result.facade, command) };
};

const starterIds = [STARTER_AGENT_IDS.plan, STARTER_AGENT_IDS.implement, STARTER_AGENT_IDS.review];

describe('T063 the starter set at a first start', () => {
  it('a new install gets the three Agents and the template in its first Snapshot, with the models listed by then', async () => {
    const s = await start();
    const snapshot = await s.snapshot();
    expect(snapshot.agents.map((a) => a.id)).toEqual(starterIds);
    expect(snapshot.workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    const [plan, implement] = snapshot.workflows[0]!.nodes;
    // The fake lists at once, so the runtimes' defaults are used (the fallbacks when none is listed: starter.test.ts).
    expect(plan).toMatchObject({ model: { runtime: 'claude', model: 'claude-m' } });
    expect(implement).toMatchObject({ model: { runtime: 'codex', model: 'codex-m', effort: 'high' } });
    expect(s.logs.some((l) => l.includes('the starter set was added (4 records)'))).toBe(true);
  });

  it('a second start adds nothing; deleted by the user, it is not added again', async () => {
    const first = await start();
    await first.close();
    const second = await start();
    expect((await second.snapshot()).workflows).toHaveLength(1);
    expect(await second.run({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID, expectedRevision: 0 })).toMatchObject({ ok: true });
    await second.close();
    const third = await start();
    const snapshot = await third.snapshot();
    expect(snapshot.workflows).toEqual([]);
    // The Agents stay; the user deleted only the template.
    expect(snapshot.agents.map((a) => a.id)).toEqual(starterIds);
  });

  it('an install in use (data from before 0.11) gets nothing; the button adds it, with the models listed by then', async () => {
    const raw = new DatabaseSync(dbPath());
    migrate(raw, MIGRATIONS.slice(0, 13));
    const agent = fixtureSnapshotInput.agents[0]!;
    raw.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify({ ...agent, schemaVersion: '0.10.0' }));
    raw.close();
    const s = await start();
    const before = await s.snapshot();
    expect(before.agents.map((a) => a.id)).toEqual([agent.id]);
    expect(before.workflows).toEqual([]);
    expect(await s.backend.repositories.markers.has('starter-offered')).toBe(true);
    // The models are listed in the background after the start.
    for (let i = 0; i < 100 && (await s.snapshot()).modelOptions.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await s.raw({ type: 'workflow.addStarter', requestId: rid() })).toMatchObject({ ok: true, revision: 0 });
    const after = await s.snapshot();
    expect(after.workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    expect(after.agents.map((a) => a.id)).toEqual([agent.id, ...starterIds]);
    expect(after.workflows[0]!.nodes[1]).toMatchObject({ model: { runtime: 'codex', model: 'codex-m', effort: 'high' } });
  });

  it('an empty database of 0.10 gets it once, as a new install does', async () => {
    const raw = new DatabaseSync(dbPath());
    migrate(raw, MIGRATIONS.slice(0, 13));
    raw.close();
    const s = await start();
    expect((await s.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
  });

  it('C-29: data written by a newer app opens read-only: nothing is added, and both commands are refused', async () => {
    const raw = new DatabaseSync(dbPath());
    migrate(raw);
    raw.exec("INSERT INTO schema_migration (version, name, applied_at) VALUES (9999, 'from-a-newer-app', 0)");
    raw.close();
    const s = await start();
    const snapshot = await s.snapshot();
    expect(snapshot.app).toMatchObject({ status: 'read-only', reason: 'newer-schema' });
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.workflows).toEqual([]);
    expect(await s.run({ type: 'workflow.addStarter', requestId: rid() })).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_READ_ONLY });
    expect(await s.run({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID, expectedRevision: 0 })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect((await s.snapshot()).workflows).toEqual([]);
  });

  it('C-29: the data turning read-only refuses a delete before it reaches the core', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start(faults);
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } } })).toMatchObject({ code: 'storage_read_only' });
    expect(await s.run({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID, expectedRevision: 0 })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect((await s.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
  });

  it('the IPC parse: workflow.delete needs its revision', async () => {
    const s = await start();
    expect(await s.raw({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await s.snapshot()).workflows).toHaveLength(1);
  });
});
