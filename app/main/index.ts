import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createWebPreferences } from './window-options';

const APP_NAME = 'AgentWorkflowGui';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: APP_NAME,
    webPreferences: createWebPreferences(join(__dirname, '../preload/index.js')),
  });

  // The renderer is a single local page: block navigation and new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.setName(APP_NAME);

void app.whenReady().then(() => {
  ipcMain.handle('app:get-info', () => ({ name: APP_NAME, version: app.getVersion() }));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
