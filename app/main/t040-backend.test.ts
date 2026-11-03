// T040 on the assembled backend with a real SQLite file (and the in-memory database where the case allows): the
// Snapshot's history pages and `session.history` (C-26), backups and restores (C-28), read-only data (C-29), and a
// renderer that falls behind (C-27): what it was not sent is in the Snapshot it reads next.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppEvent,
  type BackupInfo,
  type Command,
  type CommandResult,
  EventBatch,
  type EventEnvelope,
  HistoryCursor,
  type HistoryPage,
  MessageId,
  type OwnedProcess,
  QueryResult,
  RequestId,
  type Runtime,
  SessionId,
  Snapshot,
  type TurnId,
} from '../../contracts';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import { createRepositories, openDatabase } from '../../adapters/storage';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import type { PermissionHandle, PolicyDecision } from '../../core/ports';
import { FakeAdapter, permissionRequest } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { forwardEvents, readForWindow } from './app-ipc';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY, STORAGE_TURNED_READ_ONLY } from './backend';
import { EventBus } from './event-bus';
import { type FolderState, folderState, resolveRealPath } from './real-path';

let dir: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t040-'));
});
afterEach(async () => {
  // A failed test must not leave its database open (the folder could not be removed).
  for (const backend of running) await backend.shutdown().catch(() => undefined);
  running = [];
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
const at = '2026-11-03T01:00:00.000Z';

interface Started {
  backend: Backend;
  bus: EventBus;
  envelopes: EventEnvelope[];
  adapters: FakeAdapter[];
  logs: string[];
  run(command: Command): Promise<CommandResult>;
}

const start = async (
  options: { dbPath?: string; faults?: InjectedStorageFaults; decide?: () => PolicyDecision; realPath?: (path: string) => string | null; folders?: (path: string) => FolderState } = {},
): Promise<Started> => {
  const logs: string[] = [];
  const adapters: FakeAdapter[] = [];
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  const result = await startBackend({
    dbPath: options.dbPath ?? join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.push(adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    ...(options.decide !== undefined && { policy: { evaluate: options.decide } }),
    ...(options.faults !== undefined && { storageHooks: options.faults }),
    resolveRealPath: options.realPath ?? ((p) => p),
    ...(options.folders !== undefined && { folderState: options.folders }),
    now: () => new Date(at),
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  return { backend: result, bus, envelopes, adapters, logs, run: (command) => result.facade.execute(command) as Promise<CommandResult> };
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const createSession = async (s: Started, id = 'session-a') => {
  if ((await s.backend.repositories.agents.get(agent().id)) === undefined) await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
  const result = await s.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: dir });
  await settle();
  return result;
};

/** The day's backup: a new database's pre-migration backup holds no schema yet and cannot be restored (T038). */
const daily = (backups: readonly BackupInfo[]) => backups.find((b) => b.reason === 'daily')!.id;

const snapshot = async (s: Started) => Snapshot.parse(await s.backend.facade.snapshot());
const query = async (s: Started, request: unknown) => QueryResult.parse(await s.backend.facade.query!(request as never));

/** Writes a long conversation of `sessionId` straight into the database file (fast: no fsync per record). */
const seed = async (path: string, sessionId: string, turns: number): Promise<HistoryPage> => {
  const history = longConversation({ sessionId, turns, replyLength: 80 });
  const db = openDatabase(path);
  try {
    db.exec('PRAGMA synchronous = OFF');
    const repos = createRepositories(db);
    for (const t of history.turns) await repos.conversations.upsertTurn(t);
    for (const m of history.messages) await repos.conversations.appendMessage(m);
    for (const i of history.items) await repos.conversations.upsertItem(i);
  } finally {
    db.close();
  }
  return history;
};

describe('C-26: the Snapshot holds the last turns of a long history; session.history reads the rest', () => {
  it('pages through 600 turns (1200 messages) 50 at a time: only that session, nothing twice, nothing missing', async () => {
    const path = join(dir, 'awg.sqlite');
    const first = await start({ dbPath: path });
    await createSession(first, 'session-a');
    await createSession(first, 'session-b');
    await first.backend.shutdown();
    const history = await seed(path, 'session-a', 600);

    const s = await start({ dbPath: path });
    const snap = await snapshot(s);
    const page = snap.historyPages.find((p) => p.sessionId === 'session-a');
    expect(page?.olderCursor).not.toBeNull();
    expect(snap.turns.filter((t) => t.sessionId === 'session-a')).toHaveLength(50);
    expect(snap.messages.filter((m) => m.sessionId === 'session-a')).toHaveLength(100);

    const seen = { turns: snap.turns.map((t) => t.id), messages: snap.messages.map((m) => m.id), items: snap.items.map((i) => i.id) };
    let cursor = page!.olderCursor;
    let pages = 0;
    while (cursor !== null) {
      const result = await query(s, { type: 'session.history', requestId: rid(), sessionId: 'session-a', before: cursor, limit: 50 });
      if (!result.ok || result.type !== 'session.history') throw new Error(JSON.stringify(result));
      const records = [...result.page.turns, ...result.page.messages, ...result.page.items];
      expect(records.every((r) => r.sessionId === 'session-a')).toBe(true);
      expect(result.page.turns.length).toBeLessThanOrEqual(50);
      seen.turns.push(...result.page.turns.map((t) => t.id));
      seen.messages.push(...result.page.messages.map((m) => m.id));
      seen.items.push(...result.page.items.map((i) => i.id));
      cursor = result.page.olderCursor;
      pages++;
    }
    expect(pages).toBe(11);
    expect(new Set(seen.messages).size).toBe(seen.messages.length);
    expect(new Set(seen.turns)).toEqual(new Set(history.turns.map((t) => t.id)));
    expect(new Set(seen.messages)).toEqual(new Set(history.messages.map((m) => m.id)));
    expect(new Set(seen.items)).toEqual(new Set(history.items.map((i) => i.id)));
    await s.backend.shutdown();
  });

  it('refuses a cursor for another session, a made-up cursor, and an unknown session', async () => {
    const path = join(dir, 'awg.sqlite');
    const first = await start({ dbPath: path });
    await createSession(first, 'session-a');
    await createSession(first, 'session-b');
    await first.backend.shutdown();
    await seed(path, 'session-a', 120);
    const s = await start({ dbPath: path });
    const cursor = (await snapshot(s)).historyPages.find((p) => p.sessionId === 'session-a')!.olderCursor!;
    expect(await query(s, { type: 'session.history', requestId: 'q-1', sessionId: 'session-b', before: cursor, limit: 50 })).toMatchObject({ ok: false, requestId: 'q-1', code: 'invalid_request' });
    expect(await query(s, { type: 'session.history', requestId: 'q-2', sessionId: 'session-a', before: HistoryCursor.parse('made-up'), limit: 50 })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await query(s, { type: 'session.history', requestId: 'q-3', sessionId: 'nobody', before: cursor, limit: 50 })).toMatchObject({ ok: false, code: 'not_found' });
    // The right one still works afterwards.
    expect(await query(s, { type: 'session.history', requestId: 'q-4', sessionId: 'session-a', before: cursor, limit: 50 })).toMatchObject({ ok: true });
    await s.backend.shutdown();
  });

  it('a running turn and its pending permission request far back are in the Snapshot, however much history came after', async () => {
    const path = join(dir, 'awg.sqlite');
    const s = await start({ dbPath: path, decide: () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' }) });
    await createSession(s, 'session-a');
    const sessionId = SessionId.parse('session-a');
    const adapter = s.adapters[0]!;
    // Long before the seeded history: a turn that still runs, waiting for the user.
    const turnId = 'turn-old' as TurnId;
    adapter.emit({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'running', startedAt: '2026-10-01T00:00:00.000Z' } });
    const request = permissionRequest(sessionId, { turnId, createdAt: '2026-10-01T00:00:01.000Z' });
    adapter.emit({ type: 'permission.updated', request });
    adapter.ask(request);
    await settle();
    // Another connection writes 200 later turns meanwhile (WAL; the backend keeps running).
    await seed(path, 'session-a', 200);
    const snap = await snapshot(s);
    expect(snap.turns.filter((t) => t.sessionId === sessionId)).toHaveLength(51);
    expect(snap.turns).toContainEqual(expect.objectContaining({ id: turnId, state: 'running' }));
    expect(snap.permissionRequests).toContainEqual(expect.objectContaining({ id: request.id, state: 'pending' }));
    expect(snap.historyPages.find((p) => p.sessionId === sessionId)?.olderCursor).not.toBeNull();
  });
});

describe('C-28: backups and restores', () => {
  it('lists the backups (newest first), schedules a restore and withdraws it, each change published and in the Snapshot', async () => {
    const s = await start();
    const listed = await query(s, { type: 'backup.list', requestId: 'q-b' });
    if (!listed.ok || listed.type !== 'backup.list') throw new Error('no list');
    // A new database's first start: one before its schema was made, and the day's.
    expect(listed.backups.map((b) => b.reason).sort()).toEqual(['daily', 'pre-migration']);
    expect([...listed.backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(listed.backups);
    const backupId = daily(listed.backups);

    expect(await s.run({ type: 'backup.restore', requestId: rid(), backupId })).toMatchObject({ ok: true });
    expect(s.envelopes.at(-1)?.event).toMatchObject({ type: 'storage.updated', storage: { pendingRestore: { backupId } } });
    expect((await snapshot(s)).storage.pendingRestore?.backupId).toBe(backupId);

    expect(await s.run({ type: 'backup.cancelRestore', requestId: rid() })).toMatchObject({ ok: true });
    expect(s.envelopes.at(-1)?.event).toMatchObject({ type: 'storage.updated', storage: {} });
    expect((await snapshot(s)).storage.pendingRestore).toBeUndefined();

    expect(await s.run({ type: 'backup.restore', requestId: rid(), backupId: 'backup-nope' as never })).toMatchObject({ ok: false, code: 'not_found' });
    await s.backend.shutdown();
  });

  it('two restores at once: the last StorageInfo published is what is stored', async () => {
    const s = await start();
    const first = (await s.backend.facade.query!({ type: 'backup.list', requestId: RequestId.parse('q') })) as Extract<QueryResult, { type: 'backup.list' }>;
    const backupId = daily(first.backups);
    await Promise.all([s.run({ type: 'backup.restore', requestId: rid(), backupId }), s.run({ type: 'backup.cancelRestore', requestId: rid() }), s.run({ type: 'backup.restore', requestId: rid(), backupId })]);
    const published = s.envelopes.filter((e) => e.event.type === 'storage.updated').at(-1)!.event as Extract<AppEvent, { type: 'storage.updated' }>;
    expect(published.storage).toEqual((await snapshot(s)).storage);
    expect(published.storage.pendingRestore?.backupId).toBe(backupId);
    await s.backend.shutdown();
  });

  it('a restore asked for is applied at the next start (the data in use backed up first)', async () => {
    const path = join(dir, 'awg.sqlite');
    const s = await start({ dbPath: path });
    const listed = (await s.backend.facade.query!({ type: 'backup.list', requestId: RequestId.parse('q') })) as Extract<QueryResult, { type: 'backup.list' }>;
    // A session made after the backup: gone once the backup is restored.
    await createSession(s, 'session-later');
    expect(await s.run({ type: 'backup.restore', requestId: rid(), backupId: daily(listed.backups) })).toMatchObject({ ok: true });
    await s.backend.shutdown();

    const again = await start({ dbPath: path });
    const snap = await snapshot(again);
    expect(snap.sessions.map((x) => x.id)).not.toContain('session-later');
    expect(snap.storage.pendingRestore).toBeUndefined();
    expect(again.logs).toContain('[backend] a backup was restored at start');
    await again.backend.shutdown();
  });

  it('an in-memory database has no backups: listed as none, a restore is unsupported', async () => {
    const s = await start({ dbPath: ':memory:' });
    expect(await query(s, { type: 'backup.list', requestId: 'q' })).toEqual({ ok: true, type: 'backup.list', requestId: 'q', backups: [] });
    expect(await s.run({ type: 'backup.cancelRestore', requestId: rid() })).toMatchObject({ ok: false, code: 'unsupported' });
    await s.backend.shutdown();
  });
});

describe('C-29: read-only data', () => {
  it.each(['file', ':memory:'])('a full disk while running (%s): app.readOnly, writes refused before the core, nothing dispatched; restores still accepted', async (kind) => {
    const faults = new InjectedStorageFaults();
    const s = await start({ faults, ...(kind === ':memory:' && { dbPath: ':memory:' }) });
    await createSession(s);
    const adapter = s.adapters[0]!;
    const dispatched = adapter.dispatched.length;

    faults.failNextWrite('disk-full');
    const failed = await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } } });
    // The write that filled the disk changed nothing, but the reply does not claim more than it knows (r1 P1-3).
    expect(failed).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_TURNED_READ_ONLY, mayHaveSideEffects: true });
    expect(s.envelopes.map((e) => e.event)).toContainEqual(expect.objectContaining({ type: 'app.readOnly', reason: 'disk-full' }));
    const snap = await snapshot(s);
    expect(snap.app).toMatchObject({ status: 'read-only', reason: 'disk-full' });
    // The theme was not stored.
    expect(snap.preferences.theme).toBe('dark');

    const send = await s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('session-a'), messageId: MessageId.parse('m-ro'), expectedRevision: snap.sessions[0]!.revision, text: 'hi', attachments: [] });
    // Refused at the door: here nothing was changed.
    expect(send).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_READ_ONLY, mayHaveSideEffects: false });
    expect(adapter.dispatched.length).toBe(dispatched);
    // A peer message too: the core cannot accept it, so nothing reaches the runtime.
    await createSession(s, 'session-b').catch(() => undefined);
    await s.backend.service
      .sendMessage({ to: SessionId.parse('session-a'), content: 'x' }, { caller: SessionId.parse('session-a'), operationId: 'op-ro' as never, sourceCallRef: 'call-ro' })
      .catch(() => undefined);
    expect(adapter.dispatched.length).toBe(dispatched);

    // Queries are answered; a restore is accepted where there are backups.
    expect(await query(s, { type: 'backup.list', requestId: 'q' })).toMatchObject({ ok: true });
    if (kind === 'file') {
      const listed = (await s.backend.facade.query!({ type: 'backup.list', requestId: RequestId.parse('q') })) as Extract<QueryResult, { type: 'backup.list' }>;
      expect(await s.run({ type: 'backup.restore', requestId: rid(), backupId: daily(listed.backups) })).toMatchObject({ ok: true });
    }
    await s.backend.shutdown();
  });

  it.each(['file', ':memory:'])(
    'the data turns read-only after a send was claimed and before it left (%s): nothing reaches the runtime, and the reply does not say nothing changed',
    async (kind) => {
      const faults = new InjectedStorageFaults();
      // Another write fills the disk in the step between the send's claim and its dispatch (r1 P1-3).
      let armed = false;
      let filled = false;
      const hooks = {
        beforeWrite: () => faults.beforeWrite(),
        migration: (db: DatabaseSync, sql: string) => faults.migration(db, sql),
        beforeCommit: () => {
          faults.beforeCommit();
          if (!armed || !/DeliveryStore\.claim/.test(new Error().stack ?? '')) return;
          armed = false;
          queueMicrotask(() => {
            faults.failNextWrite('disk-full');
            void s.backend.repositories.preferences.set({ ...held.snap!.preferences, theme: 'light' }).catch(() => undefined);
            filled = true;
          });
        },
      };
      const held: { snap?: Snapshot } = {};
      const s = await start({ faults: hooks as unknown as InjectedStorageFaults, ...(kind === ':memory:' && { dbPath: ':memory:' }) });
      await createSession(s);
      const adapter = s.adapters[0]!;
      const dispatched = adapter.dispatched.length;
      const snap = await snapshot(s);
      held.snap = snap;
      armed = true;
      const send = await s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('session-a'), messageId: MessageId.parse('m-mid'), expectedRevision: snap.sessions[0]!.revision, text: 'hi', attachments: [] });
      await settle();
      expect(filled).toBe(true);
      expect(s.envelopes.map((e) => e.event)).toContainEqual(expect.objectContaining({ type: 'app.readOnly', reason: 'disk-full' }));
      // Held back at the door: the runtime never got it.
      expect(adapter.dispatched.length).toBe(dispatched);
      // Not "nothing was changed": the message was accepted and claimed before the data turned read-only.
      expect(send).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_TURNED_READ_ONLY, mayHaveSideEffects: true });
      // Its attempt stays unknown, and says nothing was written (CR-2: never sent again by itself).
      const record = (await s.backend.service.storage.store.listByTarget(SessionId.parse('session-a'))).find((r) => r.kind === 'user-message');
      expect(record?.delivery.state).toBe('unknown');
      await s.backend.shutdown();
    },
  );

  it('a full disk already during the start (the orphan cleanup writes first): read-only from there on, nothing recovered', async () => {
    const path = join(dir, 'awg.sqlite');
    const first = await start({ dbPath: path });
    await createSession(first);
    await first.backend.shutdown();
    // A crashed run's process left recorded live: the next start ends it and writes that down — the first write.
    const db = openDatabase(path);
    await createRepositories(db).processes.record({ pid: 999_999, startedAt: at, sessionId: SessionId.parse('session-a'), runtime: 'codex', kind: 'runtime-host', jobRef: 'job-x', recordedAt: at });
    db.close();
    const faults = new InjectedStorageFaults();
    faults.failNextWrite('disk-full');
    const s = await start({ dbPath: path, faults });
    expect(s.envelopes.map((e) => e.event)).toContainEqual(expect.objectContaining({ type: 'app.readOnly', reason: 'disk-full' }));
    expect((await snapshot(s)).app).toMatchObject({ status: 'read-only', reason: 'disk-full' });
    expect(s.logs).toContain('[backend] read-only data: deliveries, runs and transfers are not recovered now');
    expect(await s.run({ type: 'agent.save', requestId: rid(), agent: agent({ name: 'x' }), expectedRevision: 0 })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(s.adapters).toHaveLength(0);
  });

  it('data written by a newer app opens read-only: nothing is recovered or dispatched, the Snapshot is complete', async () => {
    const path = join(dir, 'awg.sqlite');
    const first = await start({ dbPath: path });
    await createSession(first);
    await first.backend.shutdown();
    const raw = new DatabaseSync(path);
    raw.exec("INSERT INTO schema_migration (version, name, applied_at) VALUES (9999, 'from-a-newer-app', 0)");
    raw.close();

    const s = await start({ dbPath: path });
    const snap = await snapshot(s);
    expect(snap.app).toMatchObject({ status: 'read-only', reason: 'newer-schema', location: path });
    expect(snap.sessions.map((x) => x.id)).toEqual(['session-a']);
    expect(s.logs).toContain('[backend] read-only data: deliveries, runs and transfers are not recovered now');
    expect(s.adapters).toHaveLength(0);
    expect(await s.run({ type: 'agent.save', requestId: rid(), agent: agent({ name: 'x' }), expectedRevision: 0 })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(s.adapters).toHaveLength(0);
    await s.backend.shutdown();
  });
});

describe('C-30: the idle supervisor follows the saved preferences', () => {
  const prefs = (idleCloseMinutes: number, maxOpenRuntimes: number) => ({ theme: 'dark' as const, supervisor: { idleCloseMinutes, maxOpenRuntimes } });

  it('reads them at start, takes each saved change, and keeps the last one saved when two are saved at once; again after a restart', async () => {
    const path = join(dir, 'awg.sqlite');
    const s = await start({ dbPath: path });
    expect(s.backend.supervisor.currentLimits()).toEqual({ idleMs: 15 * 60_000, maxOpen: 6 });
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: prefs(2, 3) })).toMatchObject({ ok: true });
    expect(s.backend.supervisor.currentLimits()).toEqual({ idleMs: 120_000, maxOpen: 3 });
    await Promise.all([
      s.run({ type: 'preferences.set', requestId: rid(), preferences: prefs(5, 4) }),
      s.run({ type: 'preferences.set', requestId: rid(), preferences: prefs(7, 9) }),
    ]);
    const saved = (await snapshot(s)).preferences.supervisor;
    expect(s.backend.supervisor.currentLimits()).toEqual({ idleMs: saved.idleCloseMinutes * 60_000, maxOpen: saved.maxOpenRuntimes });
    await s.backend.shutdown();
    const again = await start({ dbPath: path });
    expect(again.backend.supervisor.currentLimits()).toEqual({ idleMs: saved.idleCloseMinutes * 60_000, maxOpen: saved.maxOpenRuntimes });
  });
});

describe('C-30: folder-missing with the real path functions (T040 r1 P1-4), on SQLite', () => {
  const denied = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  /** a in the temp folder, b in a folder of its own, both closed by a restart; the second start uses `second`. */
  const closedPair = async (second: { realPath: (path: string) => string | null; folders: (path: string) => FolderState }) => {
    const path = join(dir, 'awg.sqlite');
    const folder = join(dir, 'b');
    mkdirSync(folder);
    const first = await start({ dbPath: path, realPath: (p) => resolveRealPath(p), folders: (p) => folderState(p) });
    await createSession(first, 'session-a');
    const made = await first.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('session-b'), kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: folder });
    expect(made).toMatchObject({ ok: true });
    await settle();
    await first.backend.shutdown();
    return { s: await start({ dbPath: path, ...second }), folder };
  };
  const call = (s: Started, operationId: string) =>
    s.backend.service.sendMessage({ to: SessionId.parse('session-b'), content: 'ping' }, { caller: SessionId.parse('session-a'), operationId: operationId as never, sourceCallRef: `call-${operationId}` });

  it('the target folder deleted: folder-missing, nothing accepted, nothing resumed', async () => {
    const { s, folder } = await closedPair({ realPath: (p) => resolveRealPath(p), folders: (p) => folderState(p) });
    rmSync(folder, { recursive: true });
    const before = s.adapters.length;
    expect(await call(s, 'op-gone')).toEqual({ status: 'rejected', rejection: { reason: 'folder-missing', detail: 'the target session is closed and its folder no longer exists' } });
    expect(await s.backend.service.storage.store.get('op-gone' as never)).toBeUndefined();
    expect(s.adapters.slice(before).flatMap((a) => a.calls).filter((c) => c === 'resumeSession')).toEqual([]);
    await s.backend.shutdown();
  });

  it('the folder there: accepted and sent', async () => {
    const { s } = await closedPair({ realPath: (p) => resolveRealPath(p), folders: (p) => folderState(p) });
    expect(await call(s, 'op-there')).toMatchObject({ status: 'accepted', delivery: 'sent' });
    await s.backend.shutdown();
  });

  it('the folder cannot be looked at (EACCES): never reported as gone', async () => {
    const { s } = await closedPair({ realPath: (p) => resolveRealPath(p, denied), folders: (p) => folderState(p, denied) });
    expect(await call(s, 'op-denied')).not.toMatchObject({ rejection: { reason: 'folder-missing' } });
    await s.backend.shutdown();
  });
});

describe('C-27: a renderer that falls behind under a stream of deltas', () => {
  it.each(['file', ':memory:'])(
    'is let go and told to read again (%s); the Snapshot it then reads holds the permission request, the turn end and the escalation it was not sent',
    async (kind) => {
      const s = await start({ decide: () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' }), ...(kind === ':memory:' && { dbPath: ':memory:' }) });
      await createSession(s);
      const sessionId = SessionId.parse('session-a');
      const adapter = s.adapters[0]!;
      const sent: EventBatch[] = [];
      // A window that takes batches but never acknowledges one.
      const from = s.bus.seq;
      const { batcher, stop } = forwardEvents(s.bus, () => ({ isDestroyed: () => false, getURL: () => 'app://x', send: (_c, b) => sent.push(EventBatch.parse(b)) }), () => true, {
        batchMs: 1,
        maxPending: 300,
        maxInFlight: 1,
      });
      const turnId = 'turn-1' as TurnId;
      adapter.emit({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'running', startedAt: at } });
      for (let i = 0; i < 400; i++) {
        adapter.emit({ type: 'message.delta', sessionId, turnId, messageId: MessageId.parse(`a-${String(i % 2)}`), delta: `x${String(i)}` });
        // Something about the session between the deltas: they cannot all merge.
        if (i % 2 === 1) adapter.emit({ type: 'session.activity', sessionId, activity: 'running', at });
        if (i === 200) {
          // As the runtimes do: the request is an event of its own, then the approval is asked for.
          const request = permissionRequest(sessionId, { turnId });
          adapter.emit({ type: 'permission.updated', request });
          adapter.ask(request);
        }
        if (i % 50 === 0) await settle();
      }
      adapter.emit({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'completed', startedAt: at, endedAt: at } });
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(batcher.stats.overflows).toBe(1);
      const invalidation = sent.flatMap((b) => b.envelopes).find((e) => e.event.type === 'snapshot.invalidated');
      expect(invalidation?.event).toMatchObject({ reason: 'event-overflow' });
      // What it was not sent: the permission request, the escalation that holds it for the user, the turn end.
      const delivered = new Set(sent.flatMap((b) => b.envelopes.map((e) => e.seq)));
      const missed = s.envelopes.filter((e) => e.seq > from && !delivered.has(e.seq)).map((e) => e.event.type);
      expect([...new Set(missed)]).toEqual(expect.arrayContaining(['permission.updated', 'escalation.updated', 'turn.updated']));

      // It reads the Snapshot (cut first, as the IPC handler does): everything it missed that must not be lost is there.
      batcher.cut();
      const snap = await snapshot(s);
      expect(snap.seq).toBe(s.bus.seq);
      expect(snap.permissionRequests).toContainEqual(expect.objectContaining({ id: 'perm-1', state: 'pending' }));
      expect(snap.escalations).toContainEqual(expect.objectContaining({ kind: 'permission', state: 'open' }));
      expect(snap.turns).toContainEqual(expect.objectContaining({ id: turnId, state: 'completed' }));
      // And batches go on right after that seq.
      adapter.emit({ type: 'turn.updated', turn: { id: 'turn-2' as TurnId, sessionId, state: 'running', startedAt: at } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent.find((b) => b.toSeq > snap.seq)).toMatchObject({ fromSeq: snap.seq + 1 });
      stop();
      await s.backend.shutdown();
    },
  );
});

describe('C-27 with C-26: a far-back record that changed while the renderer was let go (r1 P1-1)', () => {
  it.each(['file', ':memory:'])('comes back in the Snapshot it then reads, though older than the last 50 turns (%s)', async (kind) => {
    const s = await start(kind === ':memory:' ? { dbPath: ':memory:' } : {});
    await createSession(s);
    const sessionId = SessionId.parse('session-a');
    const adapter = s.adapters[0]!;
    const time = (i: number) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 60_000).toISOString();
    // The oldest turn still runs, its reply streaming; 60 later turns came and went meanwhile (a native task's turn).
    const oldest = 'turn-old' as TurnId;
    adapter.emit({ type: 'turn.updated', turn: { id: oldest, sessionId, state: 'running', startedAt: time(0) } });
    for (let i = 1; i <= 60; i++) {
      const turnId = `turn-${String(i)}` as TurnId;
      adapter.emit({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'completed', startedAt: time(i), endedAt: time(i) } });
      adapter.emit({ type: 'message.completed', message: { id: MessageId.parse(`m-${String(i)}`), sessionId, turnId, role: 'assistant', origin: { kind: 'agent' }, text: 'r', attachments: [], createdAt: time(i) } });
    }
    await settle();
    const before = await snapshot(s);
    expect(before.turns).toContainEqual(expect.objectContaining({ id: oldest, state: 'running' }));

    // A window that never acknowledges: let go under the stream, and while let go the old turn ends.
    const sent: EventBatch[] = [];
    const { batcher, stop } = forwardEvents(s.bus, () => ({ isDestroyed: () => false, getURL: () => 'app://x', send: (_c, b) => sent.push(EventBatch.parse(b)) }), () => true, {
      batchMs: 1,
      maxPending: 20,
      maxInFlight: 1,
    });
    for (let i = 0; i < 40; i++) {
      adapter.emit({ type: 'message.delta', sessionId, turnId: oldest, messageId: MessageId.parse('m-old'), delta: 'x' });
      adapter.emit({ type: 'session.activity', sessionId, activity: 'running', at });
    }
    await settle();
    expect(batcher.stats.overflows).toBe(1);
    adapter.emit({ type: 'message.completed', message: { id: MessageId.parse('m-old'), sessionId, turnId: oldest, role: 'assistant', origin: { kind: 'agent' }, text: 'x'.repeat(40), attachments: [], createdAt: time(0) } });
    adapter.emit({ type: 'turn.updated', turn: { id: oldest, sessionId, state: 'completed', startedAt: time(0), endedAt: time(61) } });
    await settle();
    const delivered = new Set(sent.flatMap((b) => b.envelopes.map((e) => e.seq)));
    expect(s.envelopes.filter((e) => e.event.type === 'turn.updated' && e.event.turn.id === oldest && !delivered.has(e.seq))).not.toHaveLength(0);

    // Without what was missed the Snapshot would not have it at all (the review's repro): neither running nor completed.
    expect((await snapshot(s)).turns.some((t) => t.id === oldest)).toBe(false);
    // The read as the IPC handler does it: the cut hands over what the window missed.
    const { snapshot: snap } = await readForWindow(batcher, s.backend.facade);
    expect(snap.turns).toContainEqual(expect.objectContaining({ id: oldest, state: 'completed' }));
    // The streamed message is there completed, so the renderer drops its stream (renderer-store keeps one otherwise).
    expect(snap.messages).toContainEqual(expect.objectContaining({ id: 'm-old', text: 'x'.repeat(40) }));
    expect(snap.turns.filter((t) => t.sessionId === sessionId)).toHaveLength(51);
    // Owed until the renderer says it took that read (r3): a read now brings it back again.
    const again = await readForWindow(batcher, s.backend.facade);
    expect(again.snapshot.turns.some((t) => t.id === oldest)).toBe(true);
    // Acknowledged batches say nothing; the renderer naming the read does: the next read is the plain Snapshot again.
    adapter.emit({ type: 'session.activity', sessionId, activity: 'idle', at });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    batcher.ack(sent.at(-1)!.toSeq);
    expect((await readForWindow(batcher, s.backend.facade)).snapshot.turns.some((t) => t.id === oldest)).toBe(true);
    const last = await readForWindow(batcher, s.backend.facade);
    batcher.adopted(last.read, last.snapshot.seq);
    expect((await readForWindow(batcher, s.backend.facade)).snapshot.turns.some((t) => t.id === oldest)).toBe(false);
    stop();
    await s.backend.shutdown();
  });
});
