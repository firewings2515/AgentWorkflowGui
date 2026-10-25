import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { APP_INFO_CHANNEL } from '../preload/channels';
import { registerAppIpc } from './app-ipc';
import { EventBus } from './event-bus';
import { createFakeFacade } from './facade';
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
  handleTrusted(APP_INFO_CHANNEL, getTrustedSender, () => ({ name: APP_NAME, version: app.getVersion() }));
  // Fake backend for now; the core replaces the facade later. The bus starts at the fixture's seq.
  const bus = new EventBus({ seq: fixtureSnapshot.seq });
  registerAppIpc({
    facade: createFakeFacade({ bus }),
    bus,
    getTrustedSender,
    getEventTarget: () => (mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents),
    isTrustedUrl,
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
