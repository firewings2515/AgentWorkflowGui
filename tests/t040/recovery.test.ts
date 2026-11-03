// T040 r2, r3, r4: what the window is owed, end to end. The main process through its real IPC entry (`registerAppIpc`,
// Electron's ipcMain stood in for): the batcher (event-batcher.ts), the numbered Snapshot read, the window's reports and
// acknowledgements, each from the trusted window; the Snapshot's records read as backend.ts reads them
// (`readSnapshotData` and `withMissed`), on the memory repositories and on SQLite, the same cases; into the real
// renderer store (T041), whose reports say what it applied and which read it took.
//
// IPC as Electron has it: the answers to reads and the batches reach the renderer on two pipes, each in order but not
// in order with each other; what the renderer sends (the read itself, reports, acknowledgements) goes on one pipe in
// order. Any pipe can be held up. The renderer gives up on a read after 15 s (on a clock the test moves).
//
// The invariant: a record has reached the window only when the renderer said it applied the batch that held its event,
// or said it took a read that brought the record back; until then it stays owed. Checked on the renderer's state
// against the data: what it holds is as the data has it, no stream is left of a message that was completed, it holds
// all a Snapshot holds, and every record it showed it also showed at some point as the data has it now (none lost,
// none stuck in an old state).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EventBatch,
  type Message,
  MessageId,
  type PermissionRequest,
  PermissionRequestId,
  SessionId,
  type Snapshot,
  type Turn,
  TurnId,
} from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { createRepositories, openDatabase } from '../../adapters/storage';
import type { AppRepositories } from '../../core/ports';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { registerAppIpc } from '../../app/main/app-ipc';
import type { WindowBatcher } from '../../app/main/event-batcher';
import { EventBus } from '../../app/main/event-bus';
import type { IpcSenderEvent, TrustedSender } from '../../app/main/ipc-guard';
import { BATCH_ACK_CHANNEL, SNAPSHOT_READ_CHANNEL, WINDOW_REPORT_CHANNEL } from '../../app/preload/channels';
import type { AppFacade } from '../../app/main/facade';
import { type MissedRecords, withMissed } from '../../app/main/missed-records';
import { seeded } from '../../app/main/testing/event-stream';
import type { AppBridge, SnapshotRead, WindowReport } from '../../app/preload/bridge-types';

// Electron's ipcMain, as registerAppIpc uses it: the handlers and listeners it registers, called as IPC would.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, listener),
    removeListener: (channel: string) => electron.listeners.delete(channel),
  },
}));
const page = { url: 'app://renderer' };
const trusted: TrustedSender = { webContentsId: 7, isTrustedUrl: (url) => url === page.url };
/** What reaches the main process from our own window. */
const fromWindow: IpcSenderEvent = { sender: { id: 7, mainFrame: page }, senderFrame: page };
const listener = (channel: string) => {
  const found = electron.listeners.get(channel);
  if (found === undefined) throw new Error(`no listener on ${channel}`);
  return found;
};

// The renderer store is compiled with the DOM's types (tsconfig.web); this file is not, so it is loaded by name and
// typed here as far as the test uses it (as renderer-batches.test.ts does).
interface RendererView {
  snapshot: Snapshot | null;
  connection: string;
  messageStreams: Record<string, { sessionId: string; messageId: string }>;
}
interface RendererStore {
  start(this: void): Promise<void>;
  reconnect(this: void): Promise<void>;
  dispose(this: void): void;
  subscribe(this: void, listener: () => void): () => void;
  getSnapshot(this: void): RendererView;
}
const RENDERER_STORE = '../../app/renderer/src/renderer-store';
const { createRendererStore } = (await import(/* @vite-ignore */ RENDERER_STORE)) as { createRendererStore: (bridge: unknown) => RendererStore };

const S = SessionId.parse('s-recovery');
/** The Snapshot's turns per session: small, so turns fall out of it after a few new ones (backend: 50). */
const RECENT = 5;
/** A burst this long overflows the window's queue (`maxPending`). */
const QUEUE = 20;
const BURST = 25;
/** Longer than the renderer waits for a read. */
const GIVE_UP = 15_001;
const time = (i: number) => new Date(Date.parse('2026-11-03T00:00:00.000Z') + i * 1000).toISOString();

// The renderer's timers (its 15 s wait for a read) on the test's clock; promises and setImmediate stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const backends: [string, () => AppRepositories][] = [
  ['memory', () => new MemoryRepositories()],
  [
    'SQLite',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'awg-t040-recovery-'));
      const db = openDatabase(join(dir, 'awg.sqlite'));
      db.exec('PRAGMA synchronous = OFF');
      opened.push({ db, dir });
      return createRepositories(db);
    },
  ],
];

/** Main to renderer: batches, answers to reads (two pipes). Renderer to main: one pipe. */
type Pipe = 'batches' | 'answers' | 'up';

/** The batcher's timers and the IPC pipes, on a clock the test moves. */
class Loop {
  t = 0;
  private timers: { at: number; id: number; fn: () => void }[] = [];
  private next = 1;
  private readonly pipes: Record<Pipe, (() => void)[]> = { batches: [], answers: [], up: [] };
  /** Pipes held up: nothing on them arrives until let go. */
  readonly held = new Set<Pipe>();
  /** Which of the tasks that could run now runs (the pipes are not in order with each other). */
  choose: (n: number) => number = () => 0;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, id, fn });
    return id;
  };
  clear = (id: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  send(pipe: Pipe, fn: () => void): void {
    this.pipes[pipe].push(fn);
  }
  /** Time passes: the batcher's timers come due, and the renderer's fire. */
  advance(ms: number): void {
    this.t += ms;
    vi.advanceTimersByTime(ms);
  }
  /** Runs `limit` tasks, or until nothing can run; every promise settles between tasks (the reads, the store). */
  async run(limit = 1_000_000): Promise<void> {
    for (let n = 0; n < limit; n++) {
      await idle();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const ready: (() => void)[] = [];
      const due = this.timers[0];
      if (due !== undefined && due.at <= this.t) ready.push(() => void this.timers.shift()!.fn());
      for (const pipe of ['batches', 'answers', 'up'] as const) {
        const queue = this.pipes[pipe];
        if (queue.length > 0 && !this.held.has(pipe)) ready.push(() => queue.shift()!());
      }
      if (ready.length === 0) {
        // Nothing now: on to the next timer of the batcher, if any.
        if (due === undefined) return;
        this.advance(due.at - this.t);
        continue;
      }
      ready[Math.min(ready.length - 1, Math.floor(this.choose(ready.length)))]!();
    }
  }
}
const idle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface Faults {
  /** The next batches whose send throws. */
  sends: number;
  /** The next batches holding `snapshot.invalidated` whose send throws. */
  invalidations: number;
  /** The next Snapshot reads that fail. */
  reads: number;
  /** What happens during the next reads, after their seq is read (more events: the window let go again). */
  duringRead: (() => Promise<void>)[];
  /** How often each took effect. */
  fired: { send: number; invalidation: number; read: number; duringRead: number; held: number; gaveUp: number; reload: number };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** The data, the main process and the renderer, with the session's history written: `old` and `older` still run, far back. */
async function world(repos: AppRepositories) {
  const bus = new EventBus({ seq: 0, onRejected: (reason) => { throw new Error(reason); } });
  const loop = new Loop();
  const faults: Faults = { sends: 0, invalidations: 0, reads: 0, duringRead: [], fired: { send: 0, invalidation: 0, read: 0, duringRead: 0, held: 0, gaveUp: 0, reload: 0 } };
  const sent: EventBatch[] = [];
  /** The reads in the order the main process answered them, and what the renderer reported. */
  const answered: number[] = [];
  const reports: WindowReport[] = [];
  let clock = 0;

  const template = fixtureSnapshot.sessions.find((s) => s.kind === 'ordinary')!;
  await repos.sessions.create({ ...template, id: S, revision: 0 });
  const turns = new Map<string, Turn>();
  const streaming = new Map<string, string>();
  let permissions = 0;
  const putTurn = async (turn: Turn) => {
    turns.set(turn.id, turn);
    await repos.conversations.upsertTurn(turn);
    bus.publish({ type: 'turn.updated', turn });
  };
  const op = {
    async begin(): Promise<string> {
      const id = TurnId.parse(`t-${String(++clock)}`);
      await putTurn({ id, sessionId: S, state: 'running', startedAt: time(clock) });
      return id;
    },
    stream(turnId: string): void {
      const text = `${streaming.get(turnId) ?? ''}x`;
      streaming.set(turnId, text);
      bus.publish({ type: 'message.delta', sessionId: S, turnId: TurnId.parse(turnId), messageId: MessageId.parse(`m-${turnId}`), delta: 'x' });
    },
    /** The reply completed (its stream, if any, ends), then the turn. */
    async complete(turnId: string): Promise<void> {
      const message: Message = { id: MessageId.parse(`m-${turnId}`), sessionId: S, turnId: TurnId.parse(turnId), role: 'assistant', origin: { kind: 'agent' }, text: streaming.get(turnId) ?? 'done', attachments: [], createdAt: turns.get(turnId)!.startedAt };
      streaming.delete(turnId);
      await repos.conversations.appendMessage(message);
      bus.publish({ type: 'message.completed', message });
      await op.end(turnId);
    },
    async end(turnId: string): Promise<void> {
      await putTurn({ ...turns.get(turnId)!, state: 'completed', endedAt: time(++clock) });
    },
    async ask(turnId: string): Promise<PermissionRequest> {
      const request: PermissionRequest = { ...fixtureSnapshot.permissionRequests.find((p) => p.state === 'pending')!, id: PermissionRequestId.parse(`p-${String(++permissions)}`), sessionId: S, turnId: TurnId.parse(turnId), createdAt: time(clock) };
      delete request.itemId;
      delete request.nativeTaskId;
      await repos.conversations.upsertPermissionRequest(request);
      bus.publish({ type: 'permission.updated', request });
      return request;
    },
    async withdraw(request: PermissionRequest): Promise<void> {
      const withdrawn: PermissionRequest = { ...request, state: 'withdrawn' };
      await repos.conversations.upsertPermissionRequest(withdrawn);
      bus.publish({ type: 'permission.updated', request: withdrawn });
    },
    /** Events about no record, one after another: more than the window's queue takes at once. */
    burst(n = BURST): void {
      for (let i = 0; i < n; i++) bus.publish({ type: 'usage.limits', at: time(clock) });
    },
    running: () => [...turns.values()].filter((t) => t.state === 'running').map((t) => t.id as string),
  };

  // The history: `old` runs with its reply streaming, `older` runs too, then RECENT + 3 turns came and went.
  const old = await op.begin();
  const older = await op.begin();
  for (let i = 0; i < RECENT + 3; i++) await op.complete(await op.begin());

  const facade: AppFacade = {
    // As backend.ts reads it: the seq first, then the records, then what is owed.
    async snapshot(missed?: MissedRecords): Promise<Snapshot> {
      const seq = bus.seq;
      const during = faults.duringRead.shift();
      if (faults.reads > 0) {
        faults.reads--;
        faults.fired.read++;
        throw new Error('read failed');
      }
      if (during !== undefined) {
        faults.fired.duringRead++;
        await during();
      }
      const data = await repos.readSnapshotData({ recentTurns: RECENT });
      const conversations = await withMissed(data.conversations, data.sessions, missed, (id) => repos.conversations.get(id));
      return {
        ...structuredClone(fixtureSnapshot),
        seq,
        agents: data.agents,
        workflows: data.workflows,
        sessions: data.sessions,
        ...conversations,
        instances: data.instances,
        handoffs: data.handoffs,
        peerMessages: data.peerMessages,
        escalations: data.escalations,
        transfers: data.transfers,
        projects: data.projects,
        locks: [],
        preferences: data.preferences,
        historyPages: data.historyPages,
      };
    },
    execute: () => {
      throw new Error('no commands');
    },
  };

  // The window: what the preload does with batches (each acknowledged once the listener returned), over IPC.
  const listeners = new Set<(batch: EventBatch) => void>();
  const logs: string[] = [];
  let batcher!: WindowBatcher;
  const stop = registerAppIpc({
    facade,
    bus,
    getTrustedSender: () => trusted,
    isTrustedUrl: (url) => trusted.isTrustedUrl(url),
    onBatcher: (b) => (batcher = b),
    forwarding: { batchMs: 0, maxPending: QUEUE, maxInFlight: 2, now: () => loop.t, setTimer: loop.set, clearTimer: loop.clear, log: (m) => logs.push(m) },
    getEventTarget: () => ({
      isDestroyed: () => false,
      getURL: () => page.url,
      send: (_channel, batch) => {
        if (faults.sends > 0) {
          faults.sends--;
          faults.fired.send++;
          throw new Error('render frame disposed');
        }
        if (faults.invalidations > 0 && batch.envelopes.some((e) => e.event.type === 'snapshot.invalidated')) {
          faults.invalidations--;
          faults.fired.invalidation++;
          throw new Error('render frame disposed');
        }
        sent.push(batch);
        loop.send('batches', () => {
          for (const take of [...listeners]) {
            take(structuredClone(batch));
            loop.send('up', () => listener(BATCH_ACK_CHANNEL)(fromWindow, batch.toSeq));
          }
        });
      },
    }),
  });
  // As the preload has them, over the pipes, into the handlers registerAppIpc registered.
  const readSnapshot = () =>
    new Promise<SnapshotRead>((resolve, reject) => {
      loop.send('up', () => {
        const handler = electron.handlers.get(SNAPSHOT_READ_CHANNEL)!;
        (handler(fromWindow) as Promise<SnapshotRead>).then(
          (answer) => {
            answered.push(answer.read);
            loop.send('answers', () => resolve(structuredClone(answer)));
          },
          (error: unknown) => loop.send('answers', () => reject(error instanceof Error ? error : new Error('read failed'))),
        );
      });
    });
  const bridge = {
    getAppInfo: () => Promise.resolve({ name: 'recovery', version: '1' }),
    snapshot: () => readSnapshot().then((r) => r.snapshot),
    readSnapshot,
    report: (report: WindowReport) => {
      reports.push(report);
      const copy: unknown = structuredClone(report);
      loop.send('up', () => listener(WINDOW_REPORT_CHANNEL)(fromWindow, copy));
    },
    send: () => Promise.reject(new Error('no commands')),
    onEvent: () => () => undefined,
    onBatch: (listener: (batch: EventBatch) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies Omit<AppBridge, 'query'>;
  const store = createRendererStore(bridge);

  // Every version of each record the renderer showed.
  const shown = new Map<string, Set<string>>();
  const look = () => {
    const snap = store.getSnapshot().snapshot;
    if (snap === null) return;
    for (const [kind, records] of [['t', snap.turns], ['m', snap.messages], ['p', snap.permissionRequests]] as const) {
      for (const r of records) {
        if (r.sessionId !== S) continue;
        const key = `${kind}:${r.id}`;
        if (!shown.has(key)) shown.set(key, new Set());
        shown.get(key)!.add(stable(r));
      }
    }
  };
  store.subscribe(look);
  const starting = store.start();
  await loop.run();
  await starting;
  look();
  // The renderer holds `old` running, and its reply's stream.
  op.stream(old);
  op.stream(old);
  await loop.run();

  /** Settles everything with no fault left and every pipe let go; a renderer in its error state is reloaded as the user would. */
  const settle = async () => {
    faults.sends = faults.invalidations = faults.reads = 0;
    faults.duringRead = [];
    loop.held.clear();
    await loop.run();
    if (store.getSnapshot().connection === 'error') {
      const reloading = store.reconnect();
      await loop.run();
      await reloading;
    }
    await loop.run();
  };

  /** The renderer's state against the data (see the top of the file). */
  const check = async () => {
    const view = store.getSnapshot();
    expect(view.connection).toBe('ready');
    const snap = view.snapshot!;
    expect(snap.seq).toBe(bus.seq);
    const data = await repos.conversations.get(S);
    const truth = new Map<string, unknown>([
      ...data.turns.map((r) => [`t:${r.id}`, r] as const),
      ...data.messages.map((r) => [`m:${r.id}`, r] as const),
      ...data.permissionRequests.map((r) => [`p:${r.id}`, r] as const),
    ]);
    const held = new Map<string, unknown>([
      ...snap.turns.filter((r) => r.sessionId === S).map((r) => [`t:${r.id}`, r] as const),
      ...snap.messages.filter((r) => r.sessionId === S).map((r) => [`m:${r.id}`, r] as const),
      ...snap.permissionRequests.filter((r) => r.sessionId === S).map((r) => [`p:${r.id}`, r] as const),
    ]);
    // What it holds is as the data has it.
    for (const [key, record] of held) expect({ key, record }).toEqual({ key, record: truth.get(key) });
    // No stream is left of a message that was completed.
    for (const stream of Object.values(view.messageStreams)) expect(truth.has(`m:${stream.messageId}`), stream.messageId).toBe(false);
    // It holds all that a Snapshot holds now.
    const plain = (await repos.readSnapshotData({ recentTurns: RECENT })).conversations;
    for (const key of [...plain.turns.map((r) => `t:${r.id}`), ...plain.messages.map((r) => `m:${r.id}`), ...plain.permissionRequests.map((r) => `p:${r.id}`)]) {
      expect(held.has(key), key).toBe(true);
    }
    // Every record it showed, it showed at some point as the data has it now: none lost, none stuck.
    for (const [key, versions] of shown) expect(versions.has(stable(truth.get(key))), `${key} never shown as it is now`).toBe(true);
  };

  return {
    repos, bus, loop, faults, batcher, store, op, old, older, sent, answered, reports, logs, settle, check,
    /** A report from the trusted window that no renderer would make (r4), straight into the IPC entry. */
    forge: (report: unknown) => listener(WINDOW_REPORT_CHANNEL)(fromWindow, report),
    /** The reads the renderer said it took. */
    adopted: () => reports.flatMap((r) => (r.kind === 'adopted' ? [r.read] : [])),
    dispose: () => {
      stop();
      store.dispose();
    },
  };
}

beforeEach(() => {
  // The read failures the random runs inject are logged by readSnapshot; the log is not what is tested.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each(backends)('the records owed to the window, into the real renderer store (T040 r2, r3, %s)', (_name, make) => {
  // r2 P1-a: the envelope sent alone after an invalidation that could not be sent is dropped under the Snapshot's seq.
  it('the batch sent alone after a lost invalidation: its far-back turn end comes back with the Snapshot', async () => {
    const w = await world(make());
    expect(w.op.running()).toEqual([w.old, w.older]);
    // A new turn, whose permission request's batch cannot be sent, nor the invalidation that follows.
    const fresh = await w.op.begin();
    await w.loop.run();
    w.faults.sends = 1;
    w.faults.invalidations = 1;
    const request = await w.op.ask(fresh);
    await w.loop.run();
    expect(w.faults.fired).toMatchObject({ send: 1, invalidation: 1 });
    // The next envelope goes alone, after the gap: the far-back turn's end.
    const before = w.sent.length;
    await w.op.end(w.old);
    const alone = w.sent[before]!;
    expect(alone.envelopes.map((e) => e.event.type)).toEqual(['turn.updated']);
    expect(alone.fromSeq).toBe(alone.toSeq);
    await w.loop.run();
    expect(w.answered).toHaveLength(2);
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(w.store.getSnapshot().snapshot!.permissionRequests).toContainEqual(expect.objectContaining({ id: request.id, state: 'pending' }));
    w.dispose();
  });

  // r2 P1-b: let go again while the Snapshot is read: the renderer drops that Snapshot, and the next must bring it back.
  it('let go again during the Snapshot read: the read after it still brings back what the first was handed', async () => {
    const w = await world(make());
    // Let go; meanwhile the far-back turn's reply completes and the turn ends.
    w.op.burst();
    expect(w.batcher.stats.overflows).toBe(1);
    await w.op.complete(w.old);
    // While the renderer's read is under way, the window is let go again.
    w.faults.duringRead.push(async () => {
      w.op.burst();
      await Promise.resolve();
    });
    await w.loop.run();
    expect(w.batcher.stats.overflows).toBe(2);
    expect(w.faults.fired.duringRead).toBe(1);
    // The first Snapshot dropped (older than the second invalidation), the second taken; only the second reported.
    expect(w.answered).toHaveLength(3);
    expect(w.adopted()).toEqual([w.answered[0], w.answered[2]]);
    await w.check();
    const snap = w.store.getSnapshot();
    expect(snap.snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(snap.snapshot!.messages).toContainEqual(expect.objectContaining({ id: `m-${w.old}`, text: 'xx' }));
    expect(Object.values(snap.messageStreams)).toEqual([]);
    w.dispose();
  });

  // r3 P1-1: the answer and the batches are on different pipes; batches after the read may be taken first.
  it('the answer held back, later batches taken and acknowledged first, then let go again: the next read still brings it back', async () => {
    const w = await world(make());
    w.op.burst();
    await w.op.complete(w.old);
    w.loop.held.add('answers');
    await w.loop.run();
    // Read and answered by the main process; the answer not there yet. Batches after it reach the renderer and are
    // acknowledged while it waits.
    expect(w.answered).toHaveLength(2);
    expect(w.store.getSnapshot().connection).toBe('loading');
    const acknowledged = w.sent.length;
    await w.op.begin();
    await w.loop.run();
    expect(w.sent.length).toBeGreaterThan(acknowledged);
    expect(w.batcher.inFlightCount).toBe(0);
    // Let go again, then the answer arrives: older than that invalidation, so the renderer reads again.
    w.op.burst();
    await w.loop.run();
    w.loop.held.delete('answers');
    await w.loop.run();
    expect(w.answered).toHaveLength(3);
    expect(w.adopted()).toEqual([w.answered[0], w.answered[2]]);
    // What it took with that Snapshot, it said so: no batch is kept for it, nothing is owed (P2).
    expect(w.batcher.awaitingCount).toBe(0);
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(Object.values(w.store.getSnapshot().messageStreams)).toEqual([]);
    w.dispose();
  });

  // r3 P1-2: the answer comes after the renderer gave up (15 s), though the main process read it at once.
  it('the answer after the renderer gave up: it is not taken, batches after it are acknowledged, the reload brings it back', async () => {
    const w = await world(make());
    w.op.burst();
    await w.op.complete(w.old);
    w.loop.held.add('answers');
    await w.loop.run();
    expect(w.answered).toHaveLength(2);
    w.loop.advance(GIVE_UP);
    await w.loop.run();
    expect(w.store.getSnapshot().connection).toBe('error');
    // The late answer arrives, then batches, each acknowledged by the preload; the renderer applies none of them,
    // though one ends another far-back turn.
    w.loop.held.delete('answers');
    await w.loop.run();
    const before = w.sent.length;
    await w.op.end(w.older);
    await w.loop.run();
    expect(w.sent.length).toBeGreaterThan(before);
    expect(w.batcher.inFlightCount).toBe(0);
    expect(w.adopted()).toEqual([w.answered[0]]);
    // The user reloads.
    const reloading = w.store.reconnect();
    await w.loop.run();
    await reloading;
    expect(w.adopted()).toEqual([w.answered[0], w.answered.at(-1)]);
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.older, state: 'completed' }));
    expect(Object.values(w.store.getSnapshot().messageStreams)).toEqual([]);
    w.dispose();
  });

  // r3 P1-3: a manual reload: no gap the main process saw; what it sends before its cut is held, then dropped.
  it('a manual reload, the read slow to reach the main process: what is sent and acknowledged meanwhile comes back', async () => {
    const w = await world(make());
    w.loop.held.add('up');
    const reloading = w.store.reconnect();
    await w.loop.run();
    expect(w.store.getSnapshot().connection).toBe('loading');
    // Sent before the main process cuts: the renderer holds it; its acknowledgement waits behind the read.
    const before = w.sent.length;
    await w.op.complete(w.old);
    await w.loop.run();
    expect(w.sent.slice(before).flatMap((b) => b.envelopes.map((e) => e.event.type))).toEqual(['message.completed', 'turn.updated']);
    w.loop.held.delete('up');
    await w.loop.run();
    await reloading;
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(Object.values(w.store.getSnapshot().messageStreams)).toEqual([]);
    w.dispose();
  });

  // r4: a report that proves nothing lets go of nothing. Straight into the IPC entry from the trusted window: the far-back
  // turn's end is sent but held up on its pipe, then the window reads, gives up, and is reloaded; each report comes
  // once before the read (when the batch is kept) and once while it is under way (when the read was handed it).
  it.each([
    ['applied, past anything sent', () => ({ kind: 'applied', toSeq: Number.MAX_SAFE_INTEGER })],
    ['adopted, a read that does not exist', () => ({ kind: 'adopted', read: 999_999, seq: Number.MAX_SAFE_INTEGER })],
    ['adopted, the read under way at seq 0', (read: number) => ({ kind: 'adopted', read, seq: 0 })],
    ['adopted, the read under way past what was sent', (read: number, sent: number) => ({ kind: 'adopted', read, seq: sent + 1 })],
  ] as const)('a report the main process cannot hold true (%s): ignored and logged; the reload brings the record back', async (_case, forged) => {
    const w = await world(make());
    const lastSent = () => Math.max(...w.sent.map((b) => b.toSeq));
    w.loop.held.add('batches');
    await w.op.complete(w.old);
    await w.loop.run();
    expect(w.batcher.awaitingCount).toBeGreaterThan(0);
    w.forge(forged(w.answered.at(-1)!, lastSent()));
    expect(w.batcher.awaitingCount).toBeGreaterThan(0);
    // The window reads; the answer is held up, and the forged report comes again while the read is under way.
    w.loop.held.add('answers');
    const reading = w.store.reconnect();
    await w.loop.run();
    w.forge(forged(w.answered.at(-1)!, lastSent()));
    expect(w.logs.filter((l) => l.includes('ignored'))).toHaveLength(2);
    // It gives up; what was held up arrives late and is dropped; the user reloads.
    w.loop.advance(GIVE_UP);
    await w.loop.run();
    await reading;
    expect(w.store.getSnapshot().connection).toBe('error');
    w.loop.held.clear();
    await w.loop.run();
    const reloading = w.store.reconnect();
    await w.loop.run();
    await reloading;
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(Object.values(w.store.getSnapshot().messageStreams)).toEqual([]);
    w.dispose();
  });

  // r3 P2: what the renderer held while the answer was on its way, it applies with the Snapshot and says so.
  it('batches after the cut, held until the answer comes, are applied with the Snapshot: nothing is kept or owed for them', async () => {
    const w = await world(make());
    w.loop.held.add('answers');
    const reloading = w.store.reconnect();
    await w.loop.run();
    const before = w.sent.length;
    await w.op.complete(w.older);
    await w.loop.run();
    expect(w.sent.length).toBeGreaterThan(before);
    w.loop.held.delete('answers');
    await w.loop.run();
    await reloading;
    await w.check();
    expect(w.store.getSnapshot().snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.older, state: 'completed' }));
    expect(w.batcher.awaitingCount).toBe(0);
    expect(w.batcher.cut().owed.size).toBe(0);
    w.dispose();
  });

  // r3 P2: a steady connection owes nothing however long it runs.
  it('a steady connection: nothing piles up, the next read is handed nothing', async () => {
    const w = await world(make());
    for (let i = 0; i < 40; i++) {
      const turn = await w.op.begin();
      w.op.stream(turn);
      await w.op.complete(turn);
      await w.loop.run();
    }
    expect(w.batcher.awaitingCount).toBe(0);
    expect(w.batcher.cut().owed.size).toBe(0);
    w.dispose();
  });

  // Every fault at random, the pipes in any order with each other and held up, the renderer giving up and reloaded;
  // fixed seeds, so a failure is repeated by its seed.
  it.each([2, 3, 5, 6, 8, 9, 10, 15, 17, 19])('at random (seed %i): the renderer ends as the data is, nothing owed lost', async (seed) => {
    const w = await world(make());
    const random = seeded(seed * 7919);
    w.loop.choose = (n) => random() * n;
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(random() * xs.length)];
    const asked: PermissionRequest[] = [];
    for (let step = 0; step < 200; step++) {
      const roll = random();
      if (roll < 0.12) await w.op.begin();
      else if (roll < 0.28) {
        const turn = pick(w.op.running());
        if (turn !== undefined) w.op.stream(turn);
      } else if (roll < 0.38) {
        const turn = pick(w.op.running());
        if (turn !== undefined) await (random() < 0.7 ? w.op.complete(turn) : w.op.end(turn));
      } else if (roll < 0.43) {
        const turn = pick(w.op.running());
        if (turn !== undefined) asked.push(await w.op.ask(turn));
      } else if (roll < 0.47) {
        const request = asked.splice(Math.floor(random() * asked.length), 1)[0];
        if (request !== undefined) await w.op.withdraw(request);
      } else if (roll < 0.52) w.op.burst();
      else if (roll < 0.56) w.faults.sends++;
      else if (roll < 0.6) w.faults.invalidations++;
      else if (roll < 0.63) w.faults.reads++;
      else if (roll < 0.67) w.faults.duringRead.push(async () => {
        w.op.burst();
        const turn = pick(w.op.running());
        if (turn !== undefined) await w.op.end(turn);
      });
      else if (roll < 0.75) {
        // A pipe held up for a while, or let go.
        const pipe = pick(['batches', 'answers', 'up'] as const)!;
        if (w.loop.held.has(pipe)) w.loop.held.delete(pipe);
        else {
          w.loop.held.add(pipe);
          w.faults.fired.held++;
        }
      } else if (roll < 0.79) {
        // Time passes; a renderer waiting for a read gives up.
        const waiting = w.store.getSnapshot().connection === 'loading';
        w.loop.advance(GIVE_UP);
        await w.loop.run(1);
        if (waiting && w.store.getSnapshot().connection === 'error') w.faults.fired.gaveUp++;
      } else if (roll < 0.85) {
        // The user reloads, from the error state or while connected.
        if (w.store.getSnapshot().connection !== 'loading') w.faults.fired.reload++;
        void w.store.reconnect();
      }
      // The processes go on for a while, or until nothing can run, between the writes.
      await w.loop.run(random() < 0.3 ? 1_000_000 : 1 + Math.floor(random() * 6));
    }
    // A last write after the faults: an old turn that ends.
    const last = w.op.running()[0];
    if (last !== undefined) await w.op.end(last);
    await w.settle();
    await w.check();
    // The faults took effect, each kind (the seeds are chosen so).
    expect(w.batcher.stats.overflows).toBeGreaterThan(0);
    // The real renderer never says anything the main process cannot hold true (r4).
    expect(w.logs.filter((l) => l.includes('ignored'))).toEqual([]);
    for (const [kind, n] of Object.entries(w.faults.fired)) expect(n, kind).toBeGreaterThan(0);
    w.dispose();
  });
});
