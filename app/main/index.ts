import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell } from 'electron';
import { WindowsProcessHost } from '../../adapters/process';
import type { Theme } from '../../contracts';
import { APP_INFO_CHANNEL, FOLDER_CHANNEL } from '../preload/channels';
import { registerAppIpc } from './app-ipc';
import { type Backend, type DamagedBackend, startBackend } from './backend';
import { sdkBundledClaude } from './claude-exe';
import { EventBus } from './event-bus';
import { realFolder } from './exe-search';
import { faultPointFrom } from './fault-points';
import { handleFolderRequest } from './folders';
import { handleTrusted } from './ipc';
import { type PerfLog, startPerfLog } from './perf-log';
import { perfLoadFrom, startPerfLoad } from './perf-load';
import { createTrustedUrlMatcher, type TrustedSender } from './ipc-guard';
import { folderState, resolveRealPath } from './real-path';
import { defaultWorkFolderRoot } from './work-folders';
import { createRuntimeLocator } from './runtime-locator';
import { supervisorSettings } from './supervisor-settings';
import { hiddenMenuTemplate, themeOf, WINDOW_BACKGROUND } from './window-chrome';
import { guardSession, guardWebContents } from './web-security';
import { createWebPreferences } from './window-options';

const APP_NAME = 'AgentWorkflowGui';

const devUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(__dirname, '../renderer/index.html');
const isTrustedUrl = createTrustedUrlMatcher({ devUrl, rendererFile });

let mainWindow: BrowserWindow | null = null;
let backend: Backend | DamagedBackend | undefined;
let quitting = false;
let theme: Theme = 'dark';

const log = (message: string) => console.error(message);

// The performance baseline's measurements and delta stream (T040): development runs only, never a packaged app.
const perfPath = app.isPackaged ? undefined : process.env['AWG_PERF_LOG'];
let perf: PerfLog | undefined;
let batcherStats: (() => ReturnType<NonNullable<Parameters<typeof startPerfLog>[0]['stats']>>) | undefined;
if (perfPath !== undefined && perfPath !== '') {
  perf = startPerfLog({ path: perfPath, metrics: () => app.getAppMetrics(), stats: () => batcherStats?.() });
  perf.mark('main-start');
}

/** The native title bar and the window background follow the app's saved theme (R-15). */
function applyTheme(next: Theme): void {
  theme = next;
  nativeTheme.themeSource = next;
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(WINDOW_BACKGROUND[next]);
}

function getTrustedSender(): TrustedSender | null {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  return { webContentsId: mainWindow.webContents.id, isTrustedUrl };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: APP_NAME,
    backgroundColor: WINDOW_BACKGROUND[theme],
    webPreferences: createWebPreferences(join(__dirname, '../preload/index.js')),
  });
  win.setMenuBarVisibility(false);
  mainWindow = win;
  perf?.mark('window-created');
  if (perf !== undefined) win.webContents.once('did-finish-load', () => perf?.mark('window-loaded'));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Navigation, new windows, frames and webviews are blocked for every web contents (`web-contents-created`).

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
// The renderer is a single local page showing untrusted text (T042): before any window exists.
app.on('web-contents-created', (_event, contents) => guardWebContents(contents, isTrustedUrl));

void app.whenReady().then(async () => {
  perf?.mark('app-ready');
  guardSession(session.defaultSession);
  handleTrusted(APP_INFO_CHANNEL, getTrustedSender, () => ({ name: APP_NAME, version: app.getVersion() }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(hiddenMenuTemplate(devUrl !== undefined)));
  applyTheme(theme);
  const bus = new EventBus();
  bus.subscribe((envelope) => {
    const next = themeOf(envelope);
    if (next !== undefined) applyTheme(next);
  });
  const dbPath = join(app.getPath('userData'), 'awg.sqlite');
  // The crash tests' fault point (T039): development runs only.
  const faultPoint = app.isPackaged ? undefined : faultPointFrom(process.env);
  backend = await startBackend({
    ...(faultPoint !== undefined && { faultPoint }),
    dbPath,
    bus,
    createHost: (repository) => new WindowsProcessHost({ repository, log: (_level, message) => log(`[process] ${message}`) }),
    // The user's own Claude Code and Codex (T045). The installer carries no claude.exe, so a packaged app never falls
    // back to the Agent SDK's copy; a development run may.
    runtimes: createRuntimeLocator({ ...(!app.isPackaged && { sdkBundledClaude: () => sdkBundledClaude(app.getAppPath()) }), log }),
    resolveRealPath,
    // New sessions and runs without a folder get one in %USERPROFILE%\AgentWorkflowGui unless the user chose another (T048).
    workFolders: { defaultRoot: defaultWorkFolderRoot() },
    // A closed session whose folder the file system says is gone is refused as such (C-30 `folder-missing`).
    folderState,
    // The idle supervisor follows the user's preferences (C-30); the environment overrides them in development runs only
    // (the live and crash tests).
    ...(!app.isPackaged && { supervisor: supervisorSettings(process.env) }),
    log,
  });
  perf?.mark('backend-started');
  registerAppIpc({
    facade: backend.facade,
    bus,
    getTrustedSender,
    getEventTarget: () => (mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents),
    isTrustedUrl,
    // The batcher's notes (a window let go, a report that proves nothing) in the main process log.
    forwarding: { log },
    ...(perf !== undefined && {
      onBatcher: (batcher) => {
        batcherStats = () => ({ ...batcher.stats });
      },
      onSnapshot: (snapshot, ms) => perf?.mark('snapshot', { ms: Math.round(ms), bytes: Buffer.byteLength(JSON.stringify(snapshot)), seq: snapshot.seq }),
    }),
  });
  const load = perf === undefined ? undefined : perfLoadFrom(process.env);
  if (load !== undefined && perf !== undefined) {
    startPerfLoad(load, (event) => void bus.publish(event), (name, extra) => perf?.mark(name, extra));
  }
  const facade = backend.facade;
  handleTrusted(FOLDER_CHANNEL, getTrustedSender, (raw: unknown) =>
    handleFolderRequest(raw, {
      snapshot: () => facade.snapshot(),
      dataFolder: app.getPath('userData'),
      pickFolder: async (title) => {
        const options = { title: title ?? '選擇資料夾', properties: ['openDirectory' as const] };
        const picked = mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options);
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
      },
      openPath: (path) => shell.openPath(path),
      realFolder: (path) => realFolder(path),
    }),
  );
  if (backend.status === 'ready') {
    const saved = await Promise.resolve(backend.facade.snapshot()).catch(() => undefined);
    if (saved !== undefined) applyTheme(saved.preferences.theme);
  }
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
