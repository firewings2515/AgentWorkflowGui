import type { AwgBridge } from '../../preload/bridge-types';
import type { FolderBridge } from './FolderButton';

declare global {
  interface Window {
    /** Exposed by the preload script; undefined outside Electron (e.g. in tests). */
    awg?: AwgBridge & { folders?: FolderBridge };
  }
}

export {};
