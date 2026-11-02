import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CommandResult, EventBatch, FolderResult, QueryResult, Snapshot } from '../../contracts';
import type { AppBridge, AppInfo } from './bridge-types';
import { APP_INFO_CHANNEL, BATCH_ACK_CHANNEL, BATCH_CHANNEL, COMMAND_CHANNEL, FOLDER_CHANNEL, QUERY_CHANNEL, SNAPSHOT_CHANNEL } from './channels';

// Only these functions cross into the page; `ipcRenderer` itself never does. Validation happens
// in the main process, which does not trust anything it receives from here.

/**
 * The main process sends event batches (C-27). Each one is acknowledged once every listener has taken it, so the
 * main process sends no faster than the page applies them (T040); a batch with no listener yet is not acknowledged.
 */
const onBatches = (listener: (batch: EventBatch) => void): (() => void) => {
  const forward = (_event: IpcRendererEvent, batch: EventBatch) => {
    try {
      listener(batch);
    } finally {
      ipcRenderer.send(BATCH_ACK_CHANNEL, batch.toSeq);
    }
  };
  ipcRenderer.on(BATCH_CHANNEL, forward);
  return () => {
    ipcRenderer.removeListener(BATCH_CHANNEL, forward);
  };
};

const bridge: AppBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL) as Promise<AppInfo>,
  snapshot: () => ipcRenderer.invoke(SNAPSHOT_CHANNEL) as Promise<Snapshot>,
  send: (command) => ipcRenderer.invoke(COMMAND_CHANNEL, command) as Promise<CommandResult>,
  query: (request) => ipcRenderer.invoke(QUERY_CHANNEL, request) as Promise<QueryResult>,
  onBatch: onBatches,
  // Each envelope of a batch on its own, in order. A delta merged into a later one leaves its seq unused.
  onEvent: (listener) => onBatches((batch) => batch.envelopes.forEach((envelope) => listener(envelope))),
  folders: { request: (request) => ipcRenderer.invoke(FOLDER_CHANNEL, request) as Promise<FolderResult> },
};

contextBridge.exposeInMainWorld('awg', bridge);
