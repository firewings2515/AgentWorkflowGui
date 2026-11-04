// T050 on the assembled backend with a real SQLite file in a temporary directory: the pinned lists and workflow.rename
// through the IPC parse and the facade, refused on read-only data (C-29) and when the data turns read-only on the write.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppEvent, type Command, type CommandResult, InstanceId, type OwnedProcess, RequestId, type Runtime, type SessionId, Snapshot, WorkflowInstance } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { runCommand } from './app-ipc';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY, STORAGE_TURNED_READ_ONLY } from './backend';
import { EventBus } from './event-bus';
import { resolveRealPath } from './real-path';

let dir: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t050-'));
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
const RUN = InstanceId.parse(fixtureSnapshotInput.instances[0]!.id);

const start = async (faults?: InjectedStorageFaults) => {
  const bus = new EventBus();
  const events: AppEvent[] = [];
  bus.subscribe((envelope) => events.push(envelope.event));
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    ...(faults !== undefined && { storageHooks: faults }),
    resolveRealPath,
    now: () => new Date('2026-11-04T01:00:00.000Z'),
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: () => undefined,
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  // A run stored as the engine stores one (ended, so the engine leaves it alone).
  const stored = fixtureSnapshotInput.instances[0]!;
  const run = WorkflowInstance.parse({
    ...stored,
    state: 'cancelled',
    endedAt: '2026-11-04T00:30:00.000Z',
    tasks: [],
    rounds: [],
    mergeQueue: [],
    taskPlans: [],
  });
  await result.repositories.instances.create(run);
  return {
    backend: result,
    events,
    run: (command: Command) => result.facade.execute(command) as Promise<CommandResult>,
    raw: (command: unknown) => runCommand(result.facade, command),
    instance: async () => (await result.repositories.instances.get(RUN))!,
  };
};
const basePrefs = { theme: 'dark' as const, supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } };
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);

describe('T050 on the backend', () => {
  it('pinned lists go through the IPC parse into the Snapshot and to every window; a bad list is refused there', async () => {
    const s = await start();
    // The workflow list: a run and a node session's ID alike (WB-11).
    const pinned = { chat: ['s-2', 'nobody'], workflow: [RUN, 'root-node-session'] };
    expect(await s.raw({ type: 'preferences.set', requestId: 'p1', preferences: { ...basePrefs, pinned } })).toMatchObject({ ok: true });
    expect(Snapshot.parse(await s.backend.facade.snapshot()).preferences.pinned).toEqual(pinned);
    expect(s.events.filter((e) => e.type === 'preferences.updated').at(-1)).toMatchObject({ preferences: { pinned } });
    const count = s.events.length;
    for (const bad of [{ chat: ids('s', 51), workflow: [] }, { chat: ['s-1', 's-1'], workflow: [] }, { chat: [] }]) {
      expect(await s.raw({ type: 'preferences.set', requestId: 'p2', preferences: { ...basePrefs, pinned: bad } })).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    // Sent to the facade directly (no IPC parse), the core refuses it too.
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { ...basePrefs, pinned: { chat: ['s-1', 's-1'] as SessionId[], workflow: [] } } })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await s.backend.repositories.preferences.get()).pinned).toEqual(pinned);
    expect(s.events).toHaveLength(count);
  });

  it('workflow.rename through the IPC parse: renamed, announced once; sent again, nothing more', async () => {
    const s = await start();
    const before = await s.instance();
    const rename = { type: 'workflow.rename', requestId: 'w1', instanceId: RUN, expectedRevision: before.revision, title: ' Named ' };
    expect(await s.raw(rename)).toMatchObject({ ok: true, revision: before.revision + 1 });
    expect(await s.raw(rename)).toMatchObject({ ok: true, revision: before.revision + 1 });
    expect(await s.instance()).toMatchObject({ title: 'Named', state: 'cancelled', revision: before.revision + 1 });
    expect(s.events.filter((e) => e.type === 'instance.updated' && e.instance.id === RUN)).toHaveLength(1);
    expect(Snapshot.parse(await s.backend.facade.snapshot()).instances.find((i) => i.id === RUN)?.title).toBe('Named');
    expect(await s.raw({ ...rename, title: 7 })).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('C-29: read-only data refuses workflow.rename and pinning before the core sees them', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start(faults);
    const before = await s.instance();
    // A write fills the disk: the data is read-only from here on.
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: basePrefs })).toMatchObject({ code: 'storage_read_only' });
    const count = s.events.filter((e) => e.type === 'instance.updated').length;
    expect(await s.run({ type: 'workflow.rename', requestId: rid(), instanceId: RUN, expectedRevision: before.revision, title: 'Named' })).toMatchObject({
      ok: false,
      code: 'storage_read_only',
      message: STORAGE_READ_ONLY,
    });
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { ...basePrefs, pinned: { chat: [], workflow: [RUN] } } })).toMatchObject({
      ok: false,
      code: 'storage_read_only',
      message: STORAGE_READ_ONLY,
    });
    expect(await s.instance()).toEqual(before);
    expect((await s.backend.repositories.preferences.get()).pinned).toBeUndefined();
    expect(s.events.filter((e) => e.type === 'instance.updated')).toHaveLength(count);
  });

  it('C-29: the data turning read-only on the rename write: refused, may have had side effects, nothing announced, title as it was', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start(faults);
    const before = await s.instance();
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'workflow.rename', requestId: rid(), instanceId: RUN, expectedRevision: before.revision, title: 'Named' })).toMatchObject({
      ok: false,
      code: 'storage_read_only',
      message: STORAGE_TURNED_READ_ONLY,
      mayHaveSideEffects: true,
    });
    expect(await s.instance()).toEqual(before);
    expect(s.events.filter((e) => e.type === 'instance.updated')).toEqual([]);
  });
});
