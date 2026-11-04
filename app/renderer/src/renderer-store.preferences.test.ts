// T051 r1 P1-1 / r2: preferences.set replaces the whole record, so a write is only allowed once the Snapshot shows the
// previous one. These are the timings: receipt before or after the own event, a batch with the own event and a later
// one, a late receipt of an earlier write, a read before or after the receipt, the fallback read, and failures.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION, PinnedLists, RequestId } from '../../../contracts';
import type { CommandResult, EventBatch, EventEnvelope, UiPreferences } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { createRendererStore, PREFERENCES_EVENT_WAIT_MS } from './renderer-store';
import type { RendererStore } from './renderer-store';

const stores: RendererStore[] = [];
afterEach(() => { stores.forEach(store => store.dispose()); stores.length = 0; vi.useRealTimers(); });

const base = fixtureSnapshot.preferences;
const withPins = (chat: string[], extra: Partial<UiPreferences> = {}): UiPreferences => ({ ...base, ...extra, pinned: PinnedLists.parse({ chat, workflow: [] }) });
const write = (preferences: UiPreferences, id: string = crypto.randomUUID()) => ({ type: 'preferences.set' as const, requestId: RequestId.parse(id), preferences });
const updated = (seq: number, preferences: UiPreferences): EventEnvelope => ({ schemaVersion: CONTRACTS_VERSION, seq, event: { type: 'preferences.updated', preferences, at: '2026-11-04T10:00:00Z' } });
const ok = (requestId: string): CommandResult => ({ ok: true, requestId: RequestId.parse(requestId), created: [] });

/** Sends a command whose answer never comes in time: the store's 50 ms timeout passes on fake timers. */
async function timedOut(store: RendererStore, command: ReturnType<typeof write>) {
  vi.useFakeTimers();
  try {
    const result = store.send(command);
    await vi.advanceTimersByTimeAsync(50);
    return await result;
  } finally { vi.useRealTimers(); }
}

/** A fake service: commands answer as told; events go out one by one, or as a batch when `batches` is set. */
async function setup({ batches = false, timeoutMs = 15000 } = {}) {
  const fake = fakeBridge();
  const batchListeners = new Set<(batch: EventBatch) => void>();
  const bridge = batches ? { ...fake.bridge, onBatch: (listener: (batch: EventBatch) => void) => { batchListeners.add(listener); return () => { batchListeners.delete(listener); }; } } : fake.bridge;
  const store = createRendererStore(bridge, timeoutMs);
  stores.push(store);
  await store.start();
  // Events continue after whatever the store has read (a read can move the Snapshot on).
  let seq = fixtureSnapshot.seq;
  const next = () => (seq = Math.max(seq, store.getSnapshot().snapshot?.seq ?? seq) + 1);
  const emit = (preferences: UiPreferences) => fake.emit(updated(next(), preferences));
  const batch = (...records: UiPreferences[]) => {
    const envelopes = records.map(preferences => updated(next(), preferences));
    batchListeners.forEach(listener => listener({ schemaVersion: CONTRACTS_VERSION, fromSeq: envelopes[0]!.seq, toSeq: envelopes.at(-1)!.seq, envelopes }));
  };
  const blocked = () => store.isBlocked('preferences.set', 'preferences');
  return { fake, store, emit, batch, blocked };
}

describe('T051 r2: one preferences write at a time, until the Snapshot shows it', () => {
  it('own event before the receipt: free again as soon as the receipt arrives', async () => {
    const { fake, store, emit, blocked } = await setup();
    const a = withPins(['s-research']);
    fake.bridge.send.mockImplementation(command => { emit(a); return Promise.resolve(ok(command.requestId)); });
    expect((await store.send(write(a))).ok).toBe(true);
    expect(blocked()).toBe(false);
    expect(store.savingPreferences()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(a);
  });

  it('receipt before the own event: writes wait (and a second write is refused locally) until the event', async () => {
    const { fake, store, emit, blocked } = await setup();
    const a = withPins(['s-research']);
    fake.bridge.send.mockImplementation(command => Promise.resolve(ok(command.requestId)));
    expect((await store.send(write(a))).ok).toBe(true);
    expect(blocked()).toBe(true);
    expect(store.savingPreferences()).toBe(true);
    const refused = await store.send(write(withPins(['s-plan-notes'])));
    expect(refused).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    emit(a);
    expect(blocked()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(a);
  });

  it('r2 P1-b: a batch with the own event and then another window\'s write frees writes on the own event; the Snapshot keeps the later one', async () => {
    const { fake, store, batch, blocked } = await setup({ batches: true });
    const a = withPins(['s-research']);
    const b = withPins(['s-plan-notes'], { theme: 'light' });
    fake.bridge.send.mockImplementation(command => Promise.resolve(ok(command.requestId)));
    await store.send(write(a));
    expect(blocked()).toBe(true);
    batch(a, b);
    expect(blocked()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(b);
  });

  it('r2 P1-b, own event in a batch before the receipt: the receipt then frees writes', async () => {
    const { fake, store, batch, blocked } = await setup({ batches: true });
    const a = withPins(['s-research']);
    const b = withPins(['s-plan-notes']);
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValue(response.promise);
    const sent = store.send(write(a, 'pref-a'));
    await Promise.resolve();
    batch(a, b);
    expect(blocked()).toBe(true);
    response.resolve(ok('pref-a'));
    await sent;
    expect(blocked()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(b);
  });

  it('r2 P1-a: a late success of a timed-out earlier write changes nothing after a later write', async () => {
    const { fake, store, emit, blocked } = await setup({ timeoutMs: 50 });
    const a = withPins(['s-research']);
    const late = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(late.promise);
    expect(await timedOut(store, write(a, 'pref-a'))).toMatchObject({ ok: false, code: 'unknown_outcome' });
    expect(blocked()).toBe(true);
    // The service did save A; a read shows it and the user checks the result.
    fake.data.snapshot = { ...fake.data.snapshot, seq: fake.data.snapshot.seq + 1, preferences: a };
    await store.reconnect();
    store.acknowledge('preferences.set', 'preferences');
    expect(blocked()).toBe(false);
    const ab = withPins(['s-research', 's-plan-notes']);
    fake.bridge.send.mockImplementation(command => { emit(ab); return Promise.resolve(ok(command.requestId)); });
    await store.send(write(ab, 'pref-b'));
    expect(store.getSnapshot().snapshot!.preferences).toEqual(ab);
    late.resolve(ok('pref-a'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(blocked()).toBe(false);
    expect(store.savingPreferences()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(ab);
  });

  it('a late receipt of an earlier write while a later one waits does not free or change the later one', async () => {
    const { fake, store, emit, blocked } = await setup({ timeoutMs: 50 });
    const late = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(late.promise);
    await timedOut(store, write(withPins(['s-research']), 'pref-a'));
    await store.reconnect();
    store.acknowledge('preferences.set', 'preferences');
    const b = withPins(['s-plan-notes']);
    fake.bridge.send.mockImplementation(command => Promise.resolve(ok(command.requestId)));
    await store.send(write(b, 'pref-b'));
    expect(blocked()).toBe(true);
    late.resolve(ok('pref-a'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(blocked()).toBe(true);
    emit(b);
    expect(blocked()).toBe(false);
  });

  it('a read started after the receipt frees writes; one started before it does not', async () => {
    const { fake, store, blocked } = await setup();
    const a = withPins(['s-research']);
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const sent = store.send(write(a, 'pref-a'));
    // The command has reached the service; only then does the early read start.
    await vi.waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const slow = deferred<typeof fake.data.snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(slow.promise);
    const earlyRead = store.reconnect();
    response.resolve(ok('pref-a'));
    await sent;
    expect(blocked()).toBe(true);
    slow.resolve(structuredClone(fake.data.snapshot));
    await earlyRead;
    expect(blocked()).toBe(true);
    fake.data.snapshot = { ...fake.data.snapshot, seq: fake.data.snapshot.seq + 1, preferences: a };
    await store.reconnect();
    expect(blocked()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(a);
  });

  it('without its own event, the store reads the Snapshot after PREFERENCES_EVENT_WAIT_MS (never resending)', async () => {
    const { fake, store, blocked } = await setup();
    const a = withPins(['s-research']);
    fake.bridge.send.mockImplementation(command => Promise.resolve(ok(command.requestId)));
    vi.useFakeTimers();
    await store.send(write(a));
    expect(blocked()).toBe(true);
    fake.data.snapshot = { ...fake.data.snapshot, seq: fake.data.snapshot.seq + 1, preferences: a };
    await vi.advanceTimersByTimeAsync(PREFERENCES_EVENT_WAIT_MS);
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(blocked()).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('r3: a late success after a time-out, before any check, changes nothing: writes stay stopped until a read and a check', async () => {
    const { fake, store, blocked } = await setup({ timeoutMs: 50 });
    const a = withPins(['s-research']);
    const late = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(late.promise);
    await timedOut(store, write(a, 'pref-a'));
    expect(blocked()).toBe(true);
    late.resolve(ok('pref-a'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(blocked()).toBe(true);
    expect(store.getSnapshot().commands['pref-a']!.result).toMatchObject({ code: 'unknown_outcome' });
    // A check without a read is not taken; a read that started after the result is required.
    expect(store.needsReadBeforeAcknowledge('preferences.set', 'preferences')).toBe(true);
    store.acknowledge('preferences.set', 'preferences');
    expect(blocked()).toBe(true);
    fake.data.snapshot = { ...fake.data.snapshot, seq: fake.data.snapshot.seq + 1, preferences: a };
    await store.reconnect();
    expect(store.needsReadBeforeAcknowledge('preferences.set', 'preferences')).toBe(false);
    store.acknowledge('preferences.set', 'preferences');
    expect(blocked()).toBe(false);
    expect(store.getSnapshot().snapshot!.preferences).toEqual(a);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('r3: a read that was already running at the time-out does not count as the check', async () => {
    const { fake, store, blocked } = await setup({ timeoutMs: 50 });
    const late = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(late.promise);
    const slow = deferred<typeof fake.data.snapshot>();
    vi.useFakeTimers();
    const sent = store.send(write(withPins(['s-research']), 'pref-a'));
    await vi.waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    fake.bridge.snapshot.mockReturnValueOnce(slow.promise);
    const reading = store.reconnect();
    await vi.advanceTimersByTimeAsync(50);
    await sent;
    vi.useRealTimers();
    slow.resolve(structuredClone(fake.data.snapshot));
    await reading;
    expect(store.needsReadBeforeAcknowledge('preferences.set', 'preferences')).toBe(true);
    store.acknowledge('preferences.set', 'preferences');
    expect(blocked()).toBe(true);
  });

  it('a refused write frees writes at once; an uncertain one stays blocked until checked; a no-op write waits for nothing', async () => {
    const { fake, store, blocked } = await setup();
    fake.bridge.send.mockImplementationOnce(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'invalid_request', message: '', retryable: false, mayHaveSideEffects: false }));
    await store.send(write(withPins(['s-research'])));
    expect(blocked()).toBe(false);
    fake.bridge.send.mockImplementationOnce(command => Promise.resolve(ok(command.requestId)));
    await store.send(write(fixtureSnapshot.preferences));
    expect(blocked()).toBe(false);
    fake.bridge.send.mockImplementationOnce(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'storage_failed', message: '', retryable: true, mayHaveSideEffects: true }));
    await store.send(write(withPins(['s-research'])));
    expect(blocked()).toBe(true);
    expect(store.savingPreferences()).toBe(false);
    await store.reconnect();
    store.acknowledge('preferences.set', 'preferences');
    expect(blocked()).toBe(false);
  });
});
