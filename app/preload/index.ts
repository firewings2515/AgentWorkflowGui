import { contextBridge, ipcRenderer } from 'electron';
import type { AwgBridge } from './bridge-types';

const bridge: AwgBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
};

contextBridge.exposeInMainWorld('awg', bridge);
