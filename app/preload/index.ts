import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CommandResult, EventBatch, FolderResult, QueryResult, Snapshot } from '../../contracts';
import type { AppBridge, AppInfo, SnapshotRead } from './bridge-types';
import {
  APP_INFO_CHANNEL,
  BATCH_ACK_CHANNEL,
  BATCH_CHANNEL,
  COMMAND_CHANNEL,
  ESCALATION_ACTIVATED_CHANNEL,
  ESCALATION_NOTICE_CHANNEL,
  FOLDER_CHANNEL,
  QUERY_CHANNEL,
  SNAPSHOT_CHANNEL,
  SNAPSHOT_READ_CHANNEL,
  WINDOW_REPORT_CHANNEL,
} from './channels';

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

/** The longest escalation ID passed on (the main process checks the same). */
const MAX_ESCALATION_ID = 256;
const escalationIdOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ESCALATION_ID ? value : undefined;

/** A clicked notification (T057): the listener gets the escalation ID alone, and only a well-formed one. */
const onEscalationActivated = (listener: (escalationId: string) => void): (() => void) => {
  const forward = (_event: IpcRendererEvent, payload: unknown) => {
    const escalationId = typeof payload === 'object' && payload !== null ? escalationIdOf((payload as { escalationId?: unknown }).escalationId) : undefined;
    if (escalationId !== undefined) listener(escalationId);
  };
  ipcRenderer.on(ESCALATION_ACTIVATED_CHANNEL, forward);
  return () => {
    ipcRenderer.removeListener(ESCALATION_ACTIVATED_CHANNEL, forward);
  };
};

const bridge: AppBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL) as Promise<AppInfo>,
  snapshot: () => ipcRenderer.invoke(SNAPSHOT_CHANNEL) as Promise<Snapshot>,
  send: (command) => ipcRenderer.invoke(COMMAND_CHANNEL, command) as Promise<CommandResult>,
  query: (request) => ipcRenderer.invoke(QUERY_CHANNEL, request) as Promise<QueryResult>,
  // One string, the escalation ID, and nothing else reaches the main process with this call (T057).
  showEscalationNotice: (escalationId) =>
    typeof escalationId === 'string' ? ipcRenderer.invoke(ESCALATION_NOTICE_CHANNEL, escalationId).then(() => undefined) : Promise.resolve(),
  onEscalationActivated,
  readSnapshot: () => ipcRenderer.invoke(SNAPSHOT_READ_CHANNEL) as Promise<SnapshotRead>,
  // The main process checks what it gets; nothing of it is trusted.
  report: (report) => ipcRenderer.send(WINDOW_REPORT_CHANNEL, report),
  onBatch: onBatches,
  // Each envelope of a batch on its own, in order. A delta merged into a later one leaves its seq unused.
  onEvent: (listener) => onBatches((batch) => batch.envelopes.forEach((envelope) => listener(envelope))),
  folders: { request: (request) => ipcRenderer.invoke(FOLDER_CHANNEL, request) as Promise<FolderResult> },
};

contextBridge.exposeInMainWorld('awg', bridge);
