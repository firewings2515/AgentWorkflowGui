// Shape of the API the preload script exposes as `window.awg`.
// Kept free of imports so the renderer can import it as a type without pulling in Electron.
export interface AppInfo {
  readonly name: string;
  readonly version: string;
}

export interface AwgBridge {
  getAppInfo(): Promise<AppInfo>;
}
