import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { handleTrusted } from './ipc';
import { createTrustedUrlMatcher, type TrustedSender } from './ipc-guard';
import { createWebPreferences } from './window-options';

const APP_NAME = 'AgentWorkflowGui';

const devUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(__dirname, '../renderer/index.html');
const isTrustedUrl = createTrustedUrlMatcher({ devUrl, rendererFile });

let mainWindow: BrowserWindow | null = null;

function getTrustedSender(): TrustedSender | null {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  return { webContentsId: mainWindow.webContents.id, isTrustedUrl };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: APP_NAME,
    webPreferences: createWebPreferences(join(__dirname, '../preload/index.js')),
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // The renderer is a single local page: block navigation and new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(rendererFile);
  }
}

app.setName(APP_NAME);

void app.whenReady().then(() => {
  handleTrusted('app:get-info', getTrustedSender, () => ({ name: APP_NAME, version: app.getVersion() }));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
