import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventBatch, type EventEnvelope, FolderRequest, QueryRequest } from '../../contracts';
import type { AppBridge } from './bridge-types';
import { APP_INFO_CHANNEL, BATCH_ACK_CHANNEL, BATCH_CHANNEL, COMMAND_CHANNEL, EVENT_CHANNEL, FOCUS_WINDOW_CHANNEL, FOLDER_CHANNEL, QUERY_CHANNEL, SNAPSHOT_CHANNEL, SNAPSHOT_READ_CHANNEL, WINDOW_REPORT_CHANNEL } from './channels';

type Listener = (event: unknown, batch: EventBatch) => void;

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Set<Listener>(),
  channels: [] as string[],
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api) },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: (channel: string, listener: Listener) => {
      electron.channels.push(channel);
      electron.listeners.add(listener);
    },
    removeListener: (_channel: string, listener: Listener) => electron.listeners.delete(listener),
  },
}));

const envelope = { schemaVersion: '0.3.0', seq: 43, event: { type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' } } as unknown as EventEnvelope;
const second = { ...envelope, seq: 45 } as EventEnvelope;
const batch = { schemaVersion: '0.3.0', fromSeq: 43, toSeq: 45, envelopes: [envelope, second] } as unknown as EventBatch;

async function loadBridge(): Promise<AppBridge> {
  vi.resetModules();
  await import('./index');
  return electron.exposed.get('awg') as AppBridge;
}

beforeEach(() => {
  electron.exposed.clear();
  electron.listeners.clear();
  electron.channels.length = 0;
  electron.invoke.mockReset();
  electron.send.mockReset();
});

describe('preload bridge', () => {
  it('exposes exactly the typed API and no ipcRenderer', async () => {
    const bridge = await loadBridge();
    expect(Object.keys(bridge).sort()).toEqual(['focusWindow', 'folders', 'getAppInfo', 'onBatch', 'onEvent', 'query', 'readSnapshot', 'report', 'send', 'snapshot']);
    expect(Object.keys(bridge.folders ?? {})).toEqual(['request']);
    expect(electron.exposed.size).toBe(1);
  });

  it('routes snapshot, send and getAppInfo to their own channels', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('answer');

    await bridge.snapshot();
    await bridge.getAppInfo();
    const command = { type: 'transfer.cancel', requestId: 'r', transferId: 't' } as const;
    await bridge.send(command);

    expect(electron.invoke.mock.calls).toEqual([[SNAPSHOT_CHANNEL], [APP_INFO_CHANNEL], [COMMAND_CHANNEL, command]]);
  });

  it('routes the numbered Snapshot read and the window reports to their own channels (T040 r3)', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('answer');
    await bridge.readSnapshot();
    bridge.report({ kind: 'adopted', read: 3, seq: 40 });
    bridge.report({ kind: 'applied', toSeq: 41 });
    expect(electron.invoke.mock.calls).toEqual([[SNAPSHOT_READ_CHANNEL]]);
    expect(electron.send.mock.calls).toEqual([
      [WINDOW_REPORT_CHANNEL, { kind: 'adopted', read: 3, seq: 40 }],
      [WINDOW_REPORT_CHANNEL, { kind: 'applied', toSeq: 41 }],
    ]);
  });

  it('focusWindow sends only its channel: whatever the page passes never reaches the main process (T055)', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('anything the main process answers');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the extra arguments on purpose
    const call = bridge.focusWindow as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(call('E:\\other\\window', { id: 7 }, () => undefined)).resolves.toBeUndefined();
    await bridge.focusWindow?.();
    expect(electron.invoke.mock.calls).toEqual([[FOCUS_WINDOW_CHANNEL], [FOCUS_WINDOW_CHANNEL]]);
    expect(electron.send).not.toHaveBeenCalled();
  });

  it('routes folder requests to their own channel (C-24)', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('answer');
    const request = FolderRequest.parse({ type: 'folder.open', requestId: 'r', target: { kind: 'app-data' } });
    await bridge.folders?.request(request);
    expect(electron.invoke.mock.calls).toEqual([[FOLDER_CHANNEL, request]]);
  });

  it('routes queries to their own channel (C-26, C-28)', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('answer');
    const request = QueryRequest.parse({ type: 'backup.list', requestId: 'q' });
    await bridge.query?.(request);
    expect(electron.invoke.mock.calls).toEqual([[QUERY_CHANNEL, request]]);
  });

  it('hands batch listeners the batch only, then acknowledges its toSeq (T040)', async () => {
    const bridge = await loadBridge();
    const listener = vi.fn(() => expect(electron.send).not.toHaveBeenCalled());
    const cancel = bridge.onBatch?.(listener);
    expect(electron.channels).toEqual([BATCH_CHANNEL]);
    for (const push of electron.listeners) push({ sender: 'ipc-internal' }, batch);
    expect(listener).toHaveBeenCalledExactlyOnceWith(batch);
    expect(electron.send.mock.calls).toEqual([[BATCH_ACK_CHANNEL, 45]]);
    cancel?.();
    expect(electron.listeners.size).toBe(0);
  });

  it('acknowledges a batch even when its listener throws', async () => {
    const bridge = await loadBridge();
    bridge.onBatch?.(() => {
      throw new Error('renderer bug');
    });
    for (const push of electron.listeners) expect(() => push({}, batch)).toThrow('renderer bug');
    expect(electron.send.mock.calls).toEqual([[BATCH_ACK_CHANNEL, 45]]);
  });

  it('hands event listeners each envelope of a batch in order, and cancels cleanly', async () => {
    const bridge = await loadBridge();
    const listener = vi.fn();

    const cancel = bridge.onEvent(listener);
    expect(electron.listeners.size).toBe(1);
    for (const push of electron.listeners) push({ sender: 'ipc-internal' }, batch);
    expect(listener.mock.calls).toEqual([[envelope], [second]]);

    cancel();
    expect(electron.listeners.size).toBe(0);
    cancel(); // cancelling twice is harmless
  });

  it('keeps separate subscriptions independent', async () => {
    const bridge = await loadBridge();
    const cancelFirst = bridge.onEvent(vi.fn());
    bridge.onEvent(vi.fn());
    cancelFirst();
    expect(electron.listeners.size).toBe(1);
  });

  it('listens on the batch channel, not the old per-envelope one', () => {
    expect(BATCH_CHANNEL).toBe('app:batch');
    expect(EVENT_CHANNEL).not.toBe(BATCH_CHANNEL);
  });
});
