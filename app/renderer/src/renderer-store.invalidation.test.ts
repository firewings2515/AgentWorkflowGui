import { describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, RequestId } from '../../../contracts';
import type { EventEnvelope, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { createRendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';

const invalidated = (seq: number): EventEnvelope => ({ schemaVersion: CONTRACTS_VERSION, seq,
  event: { type: 'snapshot.invalidated', reason: 'event-write-failed', at: '2026-10-29T12:00:00Z' },
});

describe('T025 snapshot invalidation and damaged guard', () => {
  it('catches successive invalidations during successive reads without flashing an error', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const states: string[] = [];
    store.subscribe(() => states.push(store.getSnapshot().connection));
    let reads = 0;
    fake.bridge.snapshot.mockImplementation(() => {
      const seq = fixtureSnapshot.seq + reads++;
      if (reads <= 2) fake.emit(invalidated(seq + 1));
      return Promise.resolve({ ...fixtureSnapshot, seq });
    });
    await store.reconnect();
    expect(reads).toBe(3);
    expect(states).toEqual(['loading', 'ready']);
    expect(store.getSnapshot().snapshot?.seq).toBe(fixtureSnapshot.seq + 2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('stops after five nonconverging reads and recovers on a later explicit reload', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const states: string[] = [];
    store.subscribe(() => states.push(store.getSnapshot().connection));
    let reads = 0;
    fake.bridge.snapshot.mockImplementation(() => {
      const seq = fixtureSnapshot.seq + reads++;
      fake.emit(invalidated(seq + 1));
      return Promise.resolve({ ...fixtureSnapshot, seq });
    });
    await store.reconnect();
    expect(reads).toBe(5);
    expect(states).toEqual(['loading', 'error']);
    fake.bridge.snapshot.mockResolvedValue({ ...fixtureSnapshot, seq: fixtureSnapshot.seq + 5 });
    await store.reconnect();
    expect(store.getSnapshot().connection).toBe('ready');
    store.dispose();
  });

  it.each(['damaged', 'loading', 'idle'] as const)('rechecks %s after send is queued but before bridge dispatch', async transition => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const sending = store.send({ type: 'escalation.respond', requestId: RequestId.parse(`race-${transition}`), escalationId: fixtureSnapshot.escalations[0]!.id, decision: 'approve' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    let refreshing: Promise<void> | undefined;
    if (transition === 'damaged') {
      // Inject the changed storage projection in the dispatch microtask window.
      // There is no app.updated event in the contract.
      store.getSnapshot().snapshot!.app = { status: 'damaged', reason: 'table.rule', location: 'E:\\data.sqlite' };
    } else if (transition === 'loading') refreshing = store.reconnect();
    else store.dispose();
    expect(await sending).toMatchObject({ ok: false, code: transition === 'damaged' ? 'storage_failed' : 'runtime_unavailable', mayHaveSideEffects: false });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await refreshing;
    store.dispose();
  });

  it('reloads invalidated data, buffers later events, ignores duplicate invalidations, and sends no commands', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const read = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    const seq = fixtureSnapshot.seq + 1;
    fake.emit(invalidated(seq));
    expect(store.getSnapshot().connection).toBe('loading');
    await Promise.resolve();
    fake.emit(invalidated(seq));
    const session = { ...fixtureSnapshot.sessions[0]!, title: 'event after invalidation' };
    fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: seq + 1, event: { type: 'session.updated', session } });
    read.resolve({ ...fixtureSnapshot, seq, escalations: [] });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ connection: 'ready', snapshot: { seq: seq + 1, escalations: [] } });
    expect(store.getSnapshot().snapshot?.sessions[0]?.title).toBe(session.title);
    fake.emit(invalidated(seq));
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('reads again when an invalidation arrives during a snapshot and never publishes stale data as ready', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const read = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    const refreshing = store.reconnect();
    await Promise.resolve();
    fake.emit(invalidated(fixtureSnapshot.seq + 1));
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 1, escalations: [] };
    const readySequences: number[] = [];
    store.subscribe(() => { if (store.getSnapshot().connection === 'ready') readySequences.push(store.getSnapshot().snapshot!.seq); });
    read.resolve(fixtureSnapshot);
    await refreshing;
    expect(readySequences).toEqual([fixtureSnapshot.seq + 1]);
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(3);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('retains a failed invalidation watermark, blocks commands, and recovers only from a covering snapshot', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    fake.emit(invalidated(fixtureSnapshot.seq + 2));
    await store.start();
    expect(store.getSnapshot().connection).toBe('error');
    await store.reconnect();
    expect(store.getSnapshot().connection).toBe('error');
    expect(await store.send({ type: 'preferences.set', requestId: RequestId.parse('offline'), preferences: fixtureSnapshot.preferences })).toMatchObject({ ok: false });
    fake.data.snapshot.seq += 2;
    await store.reconnect();
    expect(store.getSnapshot().connection).toBe('ready');
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('blocks every command when storage is damaged, including preferences and approvals', async () => {
    const fake = fakeBridge({ ...fixtureSnapshot, app: { status: 'damaged', reason: 'table.rule', location: 'E:\\data\\awg.sqlite' } });
    const store = createRendererStore(fake.bridge);
    await store.start();
    expect(await store.send({ type: 'preferences.set', requestId: RequestId.parse('theme'), preferences: fixtureSnapshot.preferences })).toMatchObject({ code: 'storage_failed', mayHaveSideEffects: false });
    expect(await store.send({ type: 'escalation.respond', requestId: RequestId.parse('approve'), escalationId: fixtureSnapshot.escalations[0]!.id, decision: 'approve' })).toMatchObject({ code: 'storage_failed' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });
});
