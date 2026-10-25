import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CommandResult, EventEnvelope, Snapshot } from '../../contracts';
import type { AppInfo, AwgBridge } from './bridge-types';
import { APP_INFO_CHANNEL, COMMAND_CHANNEL, EVENT_CHANNEL, SNAPSHOT_CHANNEL } from './channels';

// Only these four functions cross into the page; `ipcRenderer` itself never does. Validation happens
// in the main process, which does not trust anything it receives from here.
const bridge: AwgBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL) as Promise<AppInfo>,
  snapshot: () => ipcRenderer.invoke(SNAPSHOT_CHANNEL) as Promise<Snapshot>,
  send: (command) => ipcRenderer.invoke(COMMAND_CHANNEL, command) as Promise<CommandResult>,
  onEvent(listener) {
    const forward = (_event: IpcRendererEvent, envelope: EventEnvelope) => {
      listener(envelope);
    };
    ipcRenderer.on(EVENT_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, forward);
    };
  },
};

contextBridge.exposeInMainWorld('awg', bridge);
