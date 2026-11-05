import type { WebPreferences } from 'electron';

/**
 * The window icon, relative to the bundled main file (`out/main/index.js`): the project root in development and the
 * root of app.asar once packaged. electron-builder.yml lists it under `files` (T061).
 */
export const WINDOW_ICON_RELATIVE = '../../assets/icon.ico';

export function createWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // Electron's defaults, written out so a change shows up in review and in the test (T042).
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    experimentalFeatures: false,
  };
}
