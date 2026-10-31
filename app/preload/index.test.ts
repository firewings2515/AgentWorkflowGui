import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventEnvelope, FolderRequest } from '../../contracts';
import type { AwgBridge } from './bridge-types';
import { APP_INFO_CHANNEL, COMMAND_CHANNEL, EVENT_CHANNEL, FOLDER_CHANNEL, SNAPSHOT_CHANNEL } from './channels';

type Listener = (event: unknown, envelope: EventEnvelope) => void;

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Set<Listener>(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api) },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (_channel: string, listener: Listener) => electron.listeners.add(listener),
    removeListener: (_channel: string, listener: Listener) => electron.listeners.delete(listener),
  },
}));

const envelope = { schemaVersion: '0.3.0', seq: 43, event: { type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' } } as unknown as EventEnvelope;

async function loadBridge(): Promise<AwgBridge> {
  vi.resetModules();
  await import('./index');
  return electron.exposed.get('awg') as AwgBridge;
}

beforeEach(() => {
  electron.exposed.clear();
  electron.listeners.clear();
  electron.invoke.mockReset();
});

describe('preload bridge', () => {
  it('exposes exactly the typed API and no ipcRenderer', async () => {
    const bridge = await loadBridge();
    expect(Object.keys(bridge).sort()).toEqual(['folders', 'getAppInfo', 'onEvent', 'send', 'snapshot']);
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

  it('routes folder requests to their own channel (C-24)', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('answer');
    const request = FolderRequest.parse({ type: 'folder.open', requestId: 'r', target: { kind: 'app-data' } });
    await bridge.folders?.request(request);
    expect(electron.invoke.mock.calls).toEqual([[FOLDER_CHANNEL, request]]);
  });

  it('hands listeners the envelope only, and cancels cleanly', async () => {
    const bridge = await loadBridge();
    const listener = vi.fn();

    const cancel = bridge.onEvent(listener);
    expect(electron.listeners.size).toBe(1);
    for (const push of electron.listeners) push({ sender: 'ipc-internal' }, envelope);
    expect(listener).toHaveBeenCalledExactlyOnceWith(envelope);

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

  it('listens on the event channel', () => {
    expect(EVENT_CHANNEL).toBe('app:event');
  });
});
