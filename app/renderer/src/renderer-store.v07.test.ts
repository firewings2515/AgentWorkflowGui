import { describe, expect, it, vi } from 'vitest';
import { EventBatch, RequestId } from '../../../contracts';
import type { QueryRequest, QueryResult } from '../../../contracts';
import { fixtureReadOnlySnapshot, fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { longConversation } from '../../../contracts/fixtures/long-conversation';
import { createRendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { createStorageDemo, queryBridge } from './query-bridge';

const sessionId = fixtureSnapshot.historyPages[0]!.sessionId;
const page = () => longConversation({ sessionId, turns: 2 });

describe('T041 paged history', () => {
  it('reports disconnected history and uncorrelated query errors verbatim', async () => {
    const store = createRendererStore(fakeBridge().bridge);
    await expect(store.loadHistory(sessionId)).rejects.toThrow('連線尚未就緒');
    await expect(queryBridge({ query: () => Promise.resolve({ ok: false, requestId: null, code: 'storage_failed', message: '原始儲存錯誤' }) }, { type: 'backup.list', requestId: RequestId.parse('error') })).rejects.toThrow('原始儲存錯誤');
    store.dispose();
  });
  it('deduplicates in-flight reads, merges whole turns, preserves live records and stops at null', async () => {
    const fake = fakeBridge();
    const waiting = deferred<QueryResult>();
    const query = vi.fn((request: QueryRequest) => { void request; return waiting.promise; });
    const store = createRendererStore({ ...fake.bridge, query });
    await store.start();
    const reading = store.loadHistory(sessionId);
    expect(store.loadHistory(sessionId)).toBe(reading);
    const history = page();
    const current = fixtureSnapshot.messages.find(m => m.sessionId === sessionId)!;
    history.messages.push({ ...current, text: 'obsolete' });
    fake.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + 1, event: { type: 'message.completed', message: { ...current, text: 'live' } } });
    waiting.resolve({ ok: true, type: 'session.history', requestId: query.mock.calls[0]![0].requestId, page: history });
    await reading;
    const result = store.getSnapshot().snapshot!;
    expect(result.messages.find(m => m.id === current.id)?.text).toBe('live');
    expect(result.turns.filter(t => t.id.startsWith(`${sessionId}-turn`))).toHaveLength(2);
    expect(result.items.filter(t => t.id.startsWith(`${sessionId}-turn`))).toHaveLength(2);
    expect(result.historyPages.find(p => p.sessionId === sessionId)?.olderCursor).toBeNull();
    await store.loadHistory(sessionId);
    expect(query).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it('ignores an old page after reconnect and permits a new read', async () => {
    const fake = fakeBridge();
    const old = deferred<QueryResult>();
    let firstId = RequestId.parse('unset');
    let calls = 0;
    const store = createRendererStore({ ...fake.bridge, query: request => {
      calls++;
      if (calls === 1) { firstId = request.requestId; return old.promise; }
      return Promise.resolve({ ok: true, type: 'session.history', requestId: request.requestId, page: page() });
    } });
    await store.start();
    const pending = store.loadHistory(sessionId);
    await store.reconnect();
    old.resolve({ ok: true, type: 'session.history', requestId: firstId, page: page() });
    await pending;
    expect(store.getSnapshot().snapshot?.messages).toEqual(fixtureSnapshot.messages);
    await store.loadHistory(sessionId);
    expect(calls).toBe(2);
    store.dispose();
  });
  it('rejects wrong targets, mismatched receipts, repeated cursors and missing bridges', async () => {
    const fake = fakeBridge();
    const store = createRendererStore({ ...fake.bridge, query: request => Promise.resolve({ ok: true, type: 'session.history', requestId: request.requestId, page: longConversation({ sessionId: 'other', turns: 1 }) }) });
    await store.start();
    await expect(store.loadHistory(sessionId)).rejects.toThrow('歷史頁面不符');
    expect(store.getSnapshot().snapshot?.messages).toEqual(fixtureSnapshot.messages);
    await expect(queryBridge({}, { type: 'backup.list', requestId: RequestId.parse('a') })).rejects.toThrow('尚未接入');
    await expect(queryBridge({ query: () => Promise.resolve({ ok: true, type: 'backup.list', requestId: RequestId.parse('b'), backups: [] }) }, { type: 'backup.list', requestId: RequestId.parse('a') })).rejects.toThrow('回覆不符');
    store.dispose();
    const repeated = createRendererStore({ ...fake.bridge, query: request => Promise.resolve({ ok: true, type: 'session.history', requestId: request.requestId, page: { ...page(), olderCursor: fixtureSnapshot.historyPages[0]!.olderCursor } }) });
    await repeated.start();
    await expect(repeated.loadHistory(sessionId)).rejects.toThrow('游標未前進');
    repeated.dispose();
  });
  it('serves successive fixture pages with opaque per-session cursors', async () => {
    const store = createRendererStore(createStorageDemo(fixtureSnapshot));
    await store.start();
    for (let i = 0; i < 3; i++) await store.loadHistory(sessionId);
    expect(store.getSnapshot().snapshot?.turns.filter(t => t.id.startsWith(`${sessionId}-turn`))).toHaveLength(120);
    expect(store.getSnapshot().snapshot?.historyPages[0]?.olderCursor).toBeNull();
    store.dispose();
  });
});

describe('T041 event transport and read-only guards', () => {
  it('folds delta notifications but delivers terminal facts immediately', async () => {
    const fake = fakeBridge(); const store = createRendererStore(fake.bridge); await store.start();
    const changed = vi.fn(); store.subscribe(changed);
    const message = fixtureSnapshot.messages[0]!;
    for (let n = 1; n <= 100; n++) fake.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + n, event: { type: 'message.delta', sessionId: message.sessionId, messageId: message.id, delta: '+' } });
    expect(changed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().snapshot?.messages[0]?.text).toBe(message.text + '+'.repeat(100));
    fake.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + 101, event: { type: 'message.completed', message } });
    expect(changed).toHaveBeenCalledTimes(2);
    store.dispose();
  });
  it('accepts merged seq gaps inside a batch, preserves barriers, and reloads a missing batch', async () => {
    const fake = fakeBridge(); let emit!: (batch: EventBatch) => void;
    const store = createRendererStore({ ...fake.bridge, onBatch: listener => { emit = listener; return () => {}; } });
    await store.start();
    const message = fixtureSnapshot.messages[0]!;
    const base = fixtureSnapshot.seq;
    const envelope = (seq: number, event: EventBatch['envelopes'][number]['event']) => ({ schemaVersion: fixtureSnapshot.schemaVersion, seq, event });
    const changed = vi.fn(); store.subscribe(changed);
    emit(EventBatch.parse({ schemaVersion: fixtureSnapshot.schemaVersion, fromSeq: base + 1, toSeq: base + 5, envelopes: [
      envelope(base + 2, { type: 'message.delta', sessionId: message.sessionId, messageId: message.id, delta: 'ab' }),
      envelope(base + 3, { type: 'message.completed', message: { ...message, text: 'complete' } }),
      envelope(base + 4, { type: 'session.activity', sessionId: message.sessionId, activity: 'closed', cause: 'process-limit', at: message.createdAt }),
      envelope(base + 5, { type: 'permission.updated', request: fixtureSnapshot.permissionRequests[0]! }),
    ] }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().snapshot?.messages[0]?.text).toBe('complete');
    expect(store.getSnapshot().closeCauses?.[message.sessionId]).toBe('process-limit');
    expect(fake.bridge.onEvent).not.toHaveBeenCalled();
    fake.data.snapshot.seq = base + 7;
    emit(EventBatch.parse({ schemaVersion: fixtureSnapshot.schemaVersion, fromSeq: base + 7, toSeq: base + 7, envelopes: [envelope(base + 7, { type: 'storage.updated', storage: {}, at: message.createdAt })] }));
    await vi.waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getSnapshot().connection).toBe('ready'));
    expect(store.getSnapshot().snapshot?.seq).toBe(base + 7);
    expect(store.getSnapshot().snapshot?.messages).toEqual(fake.data.snapshot.messages);
    store.dispose();
  });
  it('blocks writes immediately and across the dispatch microtask, but allows restore/cancel and queries', async () => {
    const fake = fakeBridge(fixtureReadOnlySnapshot);
    const store = createRendererStore(fake.bridge); await store.start();
    expect(await store.send({ type: 'preferences.set', requestId: RequestId.parse('prefs'), preferences: fixtureSnapshot.preferences })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await store.send({ type: 'backup.restore', requestId: RequestId.parse('restore'), backupId: fixtureReadOnlySnapshot.storage.pendingRestore!.backupId });
    await store.send({ type: 'backup.cancelRestore', requestId: RequestId.parse('cancel') });
    expect(fake.bridge.send).toHaveBeenCalledTimes(2); store.dispose();
    const live = fakeBridge(); const liveStore = createRendererStore(live.bridge); await liveStore.start();
    const sending = liveStore.send({ type: 'preferences.set', requestId: RequestId.parse('race'), preferences: fixtureSnapshot.preferences });
    live.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + 1, event: { type: 'app.readOnly', reason: 'disk-full', location: 'data', at: fixtureSnapshot.messages[0]!.createdAt } });
    expect(await sending).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(live.bridge.send).not.toHaveBeenCalled(); liveStore.dispose();
  });
  it('T058: runtime.detect is sent while read-only, also when the data turns read-only during dispatch; other writes stay blocked', async () => {
    const accepted = (command: { requestId: string }) => Promise.resolve({ ok: true as const, requestId: RequestId.parse(command.requestId), created: [] });
    const fake = fakeBridge(fixtureReadOnlySnapshot);
    fake.bridge.send.mockImplementation(accepted);
    const store = createRendererStore(fake.bridge); await store.start();
    expect(await store.send({ type: 'runtime.detect', requestId: RequestId.parse('detect-ro'), runtime: 'codex' })).toMatchObject({ ok: true });
    expect(await store.send({ type: 'preferences.set', requestId: RequestId.parse('prefs-ro'), preferences: fixtureSnapshot.preferences })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect(fake.bridge.send.mock.calls.map(([command]) => (command as { type: string }).type)).toEqual(['runtime.detect']);
    store.dispose();
    const live = fakeBridge(); live.bridge.send.mockImplementation(accepted);
    const liveStore = createRendererStore(live.bridge); await liveStore.start();
    const sending = liveStore.send({ type: 'runtime.detect', requestId: RequestId.parse('detect-race') });
    live.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + 1, event: { type: 'app.readOnly', reason: 'disk-full', location: 'data', at: fixtureSnapshot.messages[0]!.createdAt } });
    expect(await sending).toMatchObject({ ok: true });
    expect(live.bridge.send).toHaveBeenCalledTimes(1); liveStore.dispose();
  });
});
