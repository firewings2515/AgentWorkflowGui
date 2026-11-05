// T059 on the assembled backend with a real SQLite file in a temporary directory: the auto-archive at start and on its
// timer, never from read-only data, stopped (never waited for) by shutdown; the archive commands through the IPC parse;
// the marks kept through a backup and its restore (C-28).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppEvent,
  type BackupInfo,
  type Command,
  type CommandResult,
  MessageId,
  type OwnedProcess,
  type QueryResult,
  RequestId,
  type Runtime,
  SessionId,
  Snapshot,
} from '../../contracts';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { runCommand } from './app-ipc';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY } from './backend';
import { EventBus } from './event-bus';

let dir: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t059-'));
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

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T01:00:00.000Z');
let requests = 0;
const rid = () => RequestId.parse(`r-${++requests}`);
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface Options {
  clock?: { ms: number };
  faults?: InjectedStorageFaults;
  autoArchive?: { intervalMs?: number } | false;
}

const start = async (options: Options = {}) => {
  const clock = options.clock ?? { ms: T0 };
  const bus = new EventBus();
  const events: AppEvent[] = [];
  const logs: string[] = [];
  bus.subscribe((envelope) => events.push(envelope.event));
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    ...(options.faults !== undefined && { storageHooks: options.faults }),
    ...(options.autoArchive !== undefined && { autoArchive: options.autoArchive }),
    resolveRealPath: (p) => p,
    now: () => new Date(clock.ms),
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
  return {
    backend: result,
    events,
    logs,
    clock,
    run,
    raw: (command: unknown) => runCommand(result.facade, command),
    session: async (id: string) => (await result.repositories.sessions.get(SessionId.parse(id)))!,
    create: async (id: string) => {
      expect(await run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', model: { runtime: 'claude', model: 'claude-m' }, cwd: dir })).toMatchObject({ ok: true });
      await settle();
    },
  };
};
type Started = Awaited<ReturnType<typeof start>>;
const archivedAt = async (s: Started, id: string) => {
  const session = await s.session(id);
  return session.kind === 'ordinary' ? session.archivedAt : undefined;
};
const closeAndForget = async (s: Started) => {
  await s.backend.shutdown();
  running = running.filter((b) => b !== s.backend);
};

describe('T059 auto-archive on the backend', () => {
  it('runs once at the start: what has had no message for 14 days is archived, announced, and in the Snapshot', async () => {
    const first = await start({ autoArchive: false });
    await first.create('old');
    await first.create('recent');
    await first.backend.repositories.conversations.appendMessage({
      id: MessageId.parse('m-recent'), sessionId: SessionId.parse('recent'), role: 'user', origin: { kind: 'user' }, text: 'hi', attachments: [], createdAt: new Date(T0 + 10 * DAY).toISOString(),
    });
    await closeAndForget(first);

    const s = await start({ clock: { ms: T0 + 15 * DAY } });
    // The start's pass, not waited for by the start: run() hands back the pass under way, or runs one now.
    await s.backend.autoArchive.run();
    expect(await archivedAt(s, 'old')).toBe(new Date(T0 + 15 * DAY).toISOString());
    expect(await archivedAt(s, 'recent')).toBeUndefined();
    expect(s.events.some((e) => e.type === 'session.updated' && e.session.id === 'old' && e.session.kind === 'ordinary' && e.session.archivedAt !== undefined)).toBe(true);
    const snapshot = Snapshot.parse(await s.backend.facade.snapshot());
    expect(snapshot.sessions.find((x) => x.id === 'old')).toHaveProperty('archivedAt');
    expect(s.logs.some((l) => l.includes('auto-archive: 1 archived'))).toBe(true);
  });

  it('then on its timer, by the injected clock; with autoArchive false only when asked', async () => {
    const s = await start({ autoArchive: { intervalMs: 10 } });
    await s.create('a');
    await s.backend.autoArchive.run();
    expect(await archivedAt(s, 'a')).toBeUndefined();
    s.clock.ms += 15 * DAY;
    for (let i = 0; i < 200 && (await archivedAt(s, 'a')) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await archivedAt(s, 'a')).toBeDefined();
    await closeAndForget(s);

    const quiet = await start({ autoArchive: false, clock: { ms: T0 + 40 * DAY } });
    await quiet.create('b');
    quiet.clock.ms += 20 * DAY;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await archivedAt(quiet, 'b')).toBeUndefined();
    expect(await quiet.backend.autoArchive.run()).toMatchObject({ archived: 1 });
    expect(await archivedAt(quiet, 'b')).toBeDefined();
  });

  it('C-29: read-only data archives nothing, by the auto-archive or by hand', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults, autoArchive: false });
    await s.create('a');
    s.clock.ms += 15 * DAY;
    const before = await s.session('a');
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } } })).toMatchObject({ code: 'storage_read_only' });
    expect(await s.backend.autoArchive.run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(await s.run({ type: 'session.archive', requestId: rid(), sessionId: SessionId.parse('a'), expectedRevision: before.revision })).toMatchObject({
      ok: false,
      code: 'storage_read_only',
      message: STORAGE_READ_ONLY,
    });
    expect(await s.session('a')).toEqual(before);
  });

  it('C-29: the data turning read-only on an auto-archive write: that one fails, the pass stops, nothing more is written', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults, autoArchive: false });
    await s.create('a');
    await s.create('b');
    s.clock.ms += 15 * DAY;
    faults.failNextWrite('disk-full');
    const report = await s.backend.autoArchive.run();
    expect(report.archived).toBe(0);
    expect(report.failed + report.skipped).toBeGreaterThan(0);
    expect(await archivedAt(s, 'a')).toBeUndefined();
    expect(await archivedAt(s, 'b')).toBeUndefined();
    expect(await s.backend.autoArchive.run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
  });

  it('shutdown does not wait for a pass under way; the pass ends without throwing and archives nothing after it', async () => {
    const s = await start({ autoArchive: false });
    await s.create('a');
    s.clock.ms += 15 * DAY;
    // The pass stops in its scan, on a read that does not answer until after the shutdown.
    const conversations = s.backend.repositories.conversations;
    const latest = conversations.latestMessageMs.bind(conversations);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    conversations.latestMessageMs = async (id) => {
      await held;
      return latest(id).catch(() => undefined);
    };
    const pass = s.backend.autoArchive.run();
    await settle();
    await closeAndForget(s);
    release();
    expect(await pass).toMatchObject({ archived: 0 });
  });

  it('the commands through the IPC parse: archived and unarchived, the refusal reason carried; a bad shape refused', async () => {
    const s = await start({ autoArchive: false });
    await s.create('top');
    expect(await s.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('child'), kind: 'ordinary', model: { runtime: 'claude', model: 'claude-m' }, cwd: dir, parentId: SessionId.parse('top') })).toMatchObject({ ok: true });
    await settle();
    const top = await s.session('top');
    expect(await s.raw({ type: 'session.archive', requestId: 'a1', sessionId: 'top', expectedRevision: top.revision })).toMatchObject({ ok: true, revision: top.revision + 1 });
    expect(await s.raw({ type: 'session.archive', requestId: 'a2', sessionId: 'child', expectedRevision: (await s.session('child')).revision })).toMatchObject({
      ok: false,
      code: 'invalid_request',
      reason: 'not-top-level',
    });
    expect(await s.raw({ type: 'session.reparent', requestId: 'a3', sessionId: 'child', expectedRevision: (await s.session('child')).revision, parentId: null })).toMatchObject({
      ok: false,
      code: 'invalid_transition',
      reason: 'archived',
    });
    expect(await s.raw({ type: 'session.unarchive', requestId: 'a4', sessionId: 'top', expectedRevision: top.revision + 1 })).toMatchObject({ ok: true, revision: top.revision + 2 });
    expect(await s.raw({ type: 'session.archive', requestId: 'a5', sessionId: 'top' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await s.raw({ type: 'workflow.archive', requestId: 'a6', instanceId: 'nope', expectedRevision: 0 })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('T059 archive marks and C-28 backups', () => {
  it('a restored backup brings back the marks it held, and the days set', async () => {
    const first = await start({ autoArchive: false });
    await first.create('top');
    expect(await first.run({ type: 'session.archive', requestId: rid(), sessionId: SessionId.parse('top'), expectedRevision: (await first.session('top')).revision })).toMatchObject({ ok: true });
    const prefs = await first.backend.repositories.preferences.get();
    expect(await first.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs, autoArchiveDays: 30 } })).toMatchObject({ ok: true });
    await closeAndForget(first);

    // The next day's start backs up the data as it is (archived), then the user unarchives and turns the days off.
    const second = await start({ autoArchive: false, clock: { ms: T0 + DAY } });
    const listed = (await second.backend.facade.query!({ type: 'backup.list', requestId: RequestId.parse('q') })) as Extract<QueryResult, { type: 'backup.list' }>;
    const backup = listed.backups.find((b: BackupInfo) => b.reason === 'daily' && Date.parse(b.createdAt) >= T0 + DAY)!;
    expect(backup).toBeDefined();
    expect(await second.run({ type: 'session.unarchive', requestId: rid(), sessionId: SessionId.parse('top'), expectedRevision: (await second.session('top')).revision })).toMatchObject({ ok: true });
    const now = await second.backend.repositories.preferences.get();
    expect(await second.run({ type: 'preferences.set', requestId: rid(), preferences: { ...now, autoArchiveDays: null } })).toMatchObject({ ok: true });
    expect(await archivedAt(second, 'top')).toBeUndefined();
    expect(await second.run({ type: 'backup.restore', requestId: rid(), backupId: backup.id })).toMatchObject({ ok: true });
    await closeAndForget(second);

    const third = await start({ autoArchive: false, clock: { ms: T0 + DAY + 60_000 } });
    expect(third.logs).toContain('[backend] a backup was restored at start');
    expect(await archivedAt(third, 'top')).toBe(new Date(T0).toISOString());
    expect((await third.backend.repositories.preferences.get()).autoArchiveDays).toBe(30);
  });
});
