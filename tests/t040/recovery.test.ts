// T040 r2: what the window is owed, end to end. The batcher (event-batcher.ts) and the Snapshot read as the IPC handler
// does it (`readForWindow`), the Snapshot's records read as backend.ts reads them (`readSnapshotData` and `withMissed`),
// on the memory repositories and on SQLite, the same cases; batches, acknowledgements and the read's answer travel as
// IPC does (later, in order, one channel), into the real renderer store (T041, unchanged).
//
// The invariant: a record whose event the window did not take in a batch right after the one before stays owed until
// the window is known to hold a Snapshot that brought it back. Checked on the renderer's state against the data: what
// it holds is as the data has it, no stream is left of a message that was completed, it holds all a Snapshot holds, and
// every record it showed it also showed at some point as the data has it now (none lost, none stuck in an old state).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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
import { forwardEvents, readForWindow } from '../../app/main/app-ipc';
import { EventBus } from '../../app/main/event-bus';
import type { AppFacade } from '../../app/main/facade';
import { type MissedRecords, withMissed } from '../../app/main/missed-records';
import { seeded } from '../../app/main/testing/event-stream';
import type { AwgBridge } from '../../app/preload/bridge-types';

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
const time = (i: number) => new Date(Date.parse('2026-11-03T00:00:00.000Z') + i * 1000).toISOString();

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
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

/** Tasks on a clock the test moves: the batcher's timers, and IPC between the processes (in order). */
class Loop {
  t = 0;
  private tasks: { at: number; id: number; fn: () => void }[] = [];
  private next = 1;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.tasks.push({ at: this.t + ms, id, fn });
    return id;
  };
  clear = (id: unknown): void => {
    this.tasks = this.tasks.filter((x) => x.id !== id);
  };
  post = (fn: () => void): void => void this.set(fn, 0);
  /** Runs `limit` tasks, or until nothing is left; every promise settles between tasks (the reads, the stores). */
  async run(limit = 1_000_000): Promise<void> {
    for (let n = 0; n < limit; n++) {
      await idle();
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const task = this.tasks.shift();
      if (task === undefined) return;
      this.t = Math.max(this.t, task.at);
      task.fn();
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
  fired: { send: number; invalidation: number; read: number; duringRead: number };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** The data, the main process and the renderer, with the session's history written: `old` still runs, far back. */
async function world(repos: AppRepositories) {
  const bus = new EventBus({ seq: 0, onRejected: (reason) => { throw new Error(reason); } });
  const loop = new Loop();
  const faults: Faults = { sends: 0, invalidations: 0, reads: 0, duringRead: [], fired: { send: 0, invalidation: 0, read: 0, duringRead: 0 } };
  const sent: EventBatch[] = [];
  let reads = 0;
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
    streaming: () => [...streaming.keys()],
  };

  // The history: `old` runs with its reply streaming, then RECENT + 3 turns came and went.
  const old = await op.begin();
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
  const { batcher, stop } = forwardEvents(
    bus,
    () => ({
      isDestroyed: () => false,
      getURL: () => 'app://renderer',
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
        loop.post(() => {
          for (const listener of [...listeners]) {
            listener(structuredClone(batch));
            loop.post(() => batcher.ack(batch.toSeq));
          }
        });
      },
    }),
    () => true,
    { batchMs: 0, maxPending: QUEUE, maxInFlight: 2, now: () => loop.t, setTimer: loop.set, clearTimer: loop.clear, log: () => undefined },
  );
  const bridge = {
    getAppInfo: () => Promise.resolve({ name: 'recovery', version: '1' }),
    // The invoke reaches the main process later; its answer comes back on the channel the batches use, in order.
    snapshot: () =>
      new Promise<Snapshot>((resolve, reject) => {
        loop.post(() => {
          reads++;
          readForWindow(batcher, facade).then(
            (snapshot) => loop.post(() => resolve(structuredClone(snapshot))),
            (error: unknown) => loop.post(() => reject(error instanceof Error ? error : new Error('read failed'))),
          );
        });
      }),
    send: () => Promise.reject(new Error('no commands')),
    onEvent: () => () => undefined,
    onBatch: (listener: (batch: EventBatch) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies AwgBridge & { onBatch: unknown };
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

  /** Settles everything with no fault left; a renderer in its error state is reloaded as the user would. */
  const settle = async () => {
    faults.sends = faults.invalidations = faults.reads = 0;
    faults.duringRead = [];
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
    repos, bus, loop, faults, batcher, store, op, old, sent, settle, check, reads: () => reads,
    dispose: () => {
      stop();
      store.dispose();
    },
  };
}

describe.each(backends)('the records owed to the window, into the real renderer store (T040 r2, %s)', (_name, make) => {
  // r2 P1-a: the envelope sent alone after an invalidation that could not be sent is dropped under the Snapshot's seq.
  it('the batch sent alone after a lost invalidation: its far-back turn end comes back with the Snapshot', async () => {
    const w = await world(make());
    expect(w.op.running()).toEqual([w.old]);
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
    expect(w.reads()).toBe(2);
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
    // The first Snapshot dropped (older than the second invalidation), the second taken.
    expect(w.reads()).toBe(3);
    await w.check();
    const snap = w.store.getSnapshot();
    expect(snap.snapshot!.turns).toContainEqual(expect.objectContaining({ id: w.old, state: 'completed' }));
    expect(snap.snapshot!.messages).toContainEqual(expect.objectContaining({ id: `m-${w.old}`, text: 'xx' }));
    expect(Object.values(snap.messageStreams)).toEqual([]);
    w.dispose();
  });

  // Every fault at random, between writes of every kind; fixed seeds, so a failure is repeated by its seed.
  it.each([1, 2, 4, 5, 6, 7])('at random (seed %i): the renderer ends as the data is, nothing owed lost', async (seed) => {
    const w = await world(make());
    const random = seeded(seed * 7919);
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(random() * xs.length)];
    const asked: PermissionRequest[] = [];
    for (let step = 0; step < 160; step++) {
      const roll = random();
      if (roll < 0.14) await w.op.begin();
      else if (roll < 0.34) {
        const turn = pick(w.op.running());
        if (turn !== undefined) w.op.stream(turn);
      } else if (roll < 0.46) {
        const turn = pick(w.op.running());
        if (turn !== undefined) await (random() < 0.7 ? w.op.complete(turn) : w.op.end(turn));
      } else if (roll < 0.52) {
        const turn = pick(w.op.running());
        if (turn !== undefined) asked.push(await w.op.ask(turn));
      } else if (roll < 0.57) {
        const request = asked.splice(Math.floor(random() * asked.length), 1)[0];
        if (request !== undefined) await w.op.withdraw(request);
      } else if (roll < 0.63) w.op.burst();
      else if (roll < 0.69) w.faults.sends++;
      else if (roll < 0.74) w.faults.invalidations++;
      else if (roll < 0.78) w.faults.reads++;
      else if (roll < 0.83) w.faults.duringRead.push(async () => {
        w.op.burst();
        const turn = pick(w.op.running());
        if (turn !== undefined) await w.op.end(turn);
      });
      else if (roll < 0.88 && w.store.getSnapshot().connection === 'error') {
        // The user reloads (ConnectionStatus).
        void w.store.reconnect();
      }
      // The processes go on for a while, or until nothing is left, between the writes.
      await w.loop.run(random() < 0.3 ? 1_000_000 : 1 + Math.floor(random() * 6));
    }
    // A last write after the faults: an old turn that ends.
    const last = w.op.running()[0];
    if (last !== undefined) await w.op.end(last);
    await w.settle();
    await w.check();
    // The faults took effect, each kind (the seeds are chosen so).
    expect(w.batcher.stats.overflows).toBeGreaterThan(0);
    for (const [kind, n] of Object.entries(w.faults.fired)) expect(n, kind).toBeGreaterThan(0);
    w.dispose();
  });
});
