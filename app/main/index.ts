import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { WindowsProcessHost } from '../../adapters/process';
import { APP_INFO_CHANNEL } from '../preload/channels';
import { registerAppIpc } from './app-ipc';
import { type Backend, type DamagedBackend, startBackend } from './backend';
import { resolveCodexExecutable } from './codex-exe';
import { EventBus } from './event-bus';
import { handleTrusted } from './ipc';
import { createTrustedUrlMatcher, type TrustedSender } from './ipc-guard';
import { resolveRealPath } from './real-path';
import { createWebPreferences } from './window-options';

const APP_NAME = 'AgentWorkflowGui';

const devUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(__dirname, '../renderer/index.html');
const isTrustedUrl = createTrustedUrlMatcher({ devUrl, rendererFile });

let mainWindow: BrowserWindow | null = null;
let backend: Backend | DamagedBackend | undefined;
let quitting = false;

const log = (message: string) => console.error(message);

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

/** Damaged data stops the backend (fail closed); the user decides what to do with the file. */
async function showDamaged(damaged: DamagedBackend): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: APP_NAME,
    message: '資料庫損壞，無法載入資料',
    detail: `資料沒有被修改或刪除，也沒有啟動任何 session。\n檔案：${damaged.dbPath}\n原因：${damaged.reason}\n\n可以先備份或移走這個檔案，再重新開啟程式。`,
    buttons: ['開啟資料夾', '結束'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) shell.showItemInFolder(damaged.dbPath);
}

/** R-14: what exiting would cut off is shown first; returns whether to go on. */
async function confirmExit(ready: Backend): Promise<boolean> {
  const work = await ready.unfinishedWork();
  const lines = [
    work.runningSessions > 0 && `${String(work.runningSessions)} 個 session 正在執行或等待核准`,
    work.heldRequests > 0 && `${String(work.heldRequests)} 個權限請求等待使用者決定`,
    work.runningNativeTasks > 0 && `${String(work.runningNativeTasks)} 個子 agent 仍在執行`,
    work.commands > 0 && `${String(work.commands)} 個指令程序仍在執行`,
  ].filter((line): line is string => typeof line === 'string');
  if (lines.length === 0) return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: '還有未結束的工作',
    detail: `${lines.join('\n')}\n\n結束程式會中斷這些工作並結束它們的程序。`,
    buttons: ['結束程式', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

app.setName(APP_NAME);

void app.whenReady().then(async () => {
  handleTrusted(APP_INFO_CHANNEL, getTrustedSender, () => ({ name: APP_NAME, version: app.getVersion() }));
  const bus = new EventBus();
  const dbPath = join(app.getPath('userData'), 'awg.sqlite');
  backend = await startBackend({
    dbPath,
    bus,
    createHost: (repository) => new WindowsProcessHost({ repository, log: (_level, message) => log(`[process] ${message}`) }),
    codexExecutable: resolveCodexExecutable(),
    resolveRealPath,
    log,
  });
  registerAppIpc({
    facade: backend.facade,
    bus,
    getTrustedSender,
    getEventTarget: () => (mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents),
    isTrustedUrl,
  });
  createWindow();
  if (backend.status === 'damaged') void showDamaged(backend);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitting || backend === undefined) return;
  event.preventDefault();
  const current = backend;
  void (async () => {
    if (current.status === 'ready' && !(await confirmExit(current).catch(() => true))) return;
    quitting = true;
    await current.shutdown().catch((error: unknown) => log(`[main] shutdown failed (${error instanceof Error ? error.name : 'unknown'})`));
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
