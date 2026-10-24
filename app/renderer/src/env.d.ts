import type { AwgBridge } from '../../preload/bridge-types';

declare global {
  interface Window {
    /** Exposed by the preload script; undefined outside Electron (e.g. in tests). */
    awg?: AwgBridge;
  }
}

export {};
