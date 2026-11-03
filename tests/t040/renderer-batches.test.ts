// T040: the main process's batches into the real renderer store (T041, unchanged). A store fed every envelope one by
// one is the reference; the store behind the batcher must end in the same state, and after being let go it must read
// the Snapshot again and hold everything the Snapshot holds.
import { describe, expect, it } from 'vitest';
import type { EventBatch, EventEnvelope, Snapshot } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { forwardEvents } from '../../app/main/app-ipc';
import { EventBus } from '../../app/main/event-bus';
import { seeded, streamEvent } from '../../app/main/testing/event-stream';
import type { AwgBridge } from '../../app/preload/bridge-types';

// The renderer store is compiled with the DOM's types (tsconfig.web); this file is not, so it is loaded by name and
// typed here as far as the test uses it.
interface RendererStore {
  start(this: void): Promise<void>;
  dispose(this: void): void;
  getSnapshot(this: void): { snapshot: Snapshot | null; connection: string; messageStreams: unknown; itemStreams: unknown };
}
const RENDERER_STORE = '../../app/renderer/src/renderer-store';
const { createRendererStore } = (await import(/* @vite-ignore */ RENDERER_STORE)) as { createRendererStore: (bridge: unknown) => RendererStore };

const base: Snapshot = { ...structuredClone(fixtureSnapshot), seq: 0 };

const idle = async (ms = 0) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A bus with two windows: the reference, fed each envelope as published, and the store behind the batcher. */
async function rig(options: { ackDelayMs: number; maxPending?: number }) {
  const bus = new EventBus({ seq: 0 });
  // Reference: one envelope at a time, in order, nothing merged.
  const refListeners = new Set<(e: EventEnvelope) => void>();
  bus.subscribe((e) => refListeners.forEach((l) => l(e)));
  const reference = createRendererStore({
    getAppInfo: () => Promise.resolve({ name: 'ref', version: '1' }),
    snapshot: () => Promise.resolve(structuredClone(base)),
    send: () => Promise.reject(new Error('no commands')),
    onEvent: (listener) => {
      refListeners.add(listener);
      return () => refListeners.delete(listener);
    },
  } satisfies AwgBridge);
  await reference.start();

  // The batched window: batches arrive as IPC would deliver them (later), and are acknowledged as the preload does.
  const batchListeners = new Set<(b: EventBatch) => void>();
  let snapshotReads = 0;
  const { batcher, stop } = forwardEvents(
    bus,
    () => ({
      isDestroyed: () => false,
      getURL: () => 'app://renderer',
      send: (_channel, batch) =>
        void setTimeout(() => {
          batchListeners.forEach((l) => l(batch));
          setTimeout(() => batcher.ack(batch.toSeq), options.ackDelayMs);
        }, 0),
    }),
    () => true,
    { batchMs: 4, ...(options.maxPending !== undefined && { maxPending: options.maxPending }) },
  );
  const batched = createRendererStore({
    getAppInfo: () => Promise.resolve({ name: 'batched', version: '1' }),
    snapshot: () => {
      // As the IPC handler does: the cut, then the Snapshot's seq, in one step. Its content is the reference's state.
      snapshotReads++;
      batcher.cut();
      const seq = bus.seq;
      const truth = reference.getSnapshot().snapshot!;
      return Promise.resolve({ ...structuredClone(truth), seq });
    },
    send: () => Promise.reject(new Error('no commands')),
    onEvent: () => () => undefined,
    onBatch: (listener: (b: EventBatch) => void) => {
      batchListeners.add(listener);
      return () => batchListeners.delete(listener);
    },
  });
  await batched.start();
  return { bus, reference, batched, batcher, stop, reads: () => snapshotReads };
}

/** The Snapshot's content; its seq is compared on its own. */
const durable = (s: Snapshot | null) => (s === null ? null : { ...s, seq: 0 });

describe('T040: the real renderer store behind the batcher', () => {
  it('ends in the same state as a store fed every envelope one by one (streams included), reading the Snapshot only once', async () => {
    const r = await rig({ ackDelayMs: 2 });
    const random = seeded(7);
    for (let i = 0; i < 3000; i++) {
      r.bus.publish(streamEvent(random, i));
      if (i % 100 === 0) await idle(1);
    }
    await idle(100);
    const ref = r.reference.getSnapshot();
    const got = r.batched.getSnapshot();
    expect(got.connection).toBe('ready');
    expect(r.reads()).toBe(1);
    expect(got.snapshot?.seq).toBe(r.bus.seq);
    expect(durable(got.snapshot)).toEqual(durable(ref.snapshot));
    expect(got.messageStreams).toEqual(ref.messageStreams);
    expect(got.itemStreams).toEqual(ref.itemStreams);
    expect(r.batcher.stats.merged).toBeGreaterThan(0);
    r.stop();
    r.batched.dispose();
    r.reference.dispose();
  });

  it('let go while it does not keep up, it reads the Snapshot again and holds everything the Snapshot holds', async () => {
    const r = await rig({ ackDelayMs: 400, maxPending: 150 });
    const random = seeded(11);
    for (let i = 0; i < 3000; i++) r.bus.publish(streamEvent(random, i));
    await idle(1500);
    expect(r.batcher.stats.overflows).toBeGreaterThanOrEqual(1);
    const got = r.batched.getSnapshot();
    expect(got.connection).toBe('ready');
    expect(r.reads()).toBeGreaterThan(1);
    expect(got.snapshot?.seq).toBe(r.bus.seq);
    // Every permission request, turn, escalation, handoff and transfer the reference holds.
    expect(durable(got.snapshot)).toEqual(durable(r.reference.getSnapshot().snapshot));
    r.stop();
    r.batched.dispose();
    r.reference.dispose();
  });
});
