// T042 r1-P2-2: app/main/index.ts itself installs the guards. This starts index.ts against a fake Electron (as
// index.runtimes.test.ts does), then hands it a web contents made after start, the way Electron's
// `web-contents-created` does, and checks the guard is on it; and that the default session refuses permissions.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ESCALATION_ACTIVATED_CHANNEL, ESCALATION_NOTICE_CHANNEL } from '../preload/channels';
import { APP_USER_MODEL_ID, TOAST_ACTIVATOR_CLSID } from './app-id';
import { LAUNCH_PREFIX } from './escalation-notice';

const hoisted = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  permissionRequest: undefined as ((wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void) | undefined,
  permissionCheck: undefined as ((...args: unknown[]) => boolean) | undefined,
  sessionEvents: [] as string[],
  startBackend: vi.fn(),
  windows: [] as { webContents: { send: ReturnType<typeof vi.fn> }; isMinimized: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userModelIds: [] as string[],
  // T057: the toast activator, the activation callback and the notifications made.
  calls: [] as string[],
  activation: undefined as ((details: unknown) => void) | undefined,
  notifications: [] as { options: Record<string, unknown>; listeners: Map<string, () => void>; show: ReturnType<typeof vi.fn> }[],
}));

vi.mock('electron', () => {
  class FakeWindow {
    static getAllWindows = () => [];
    webContents = { id: 1, setWindowOpenHandler: vi.fn(), on: vi.fn(), getURL: () => '', send: vi.fn() };
    setMenuBarVisibility = vi.fn();
    setBackgroundColor = vi.fn();
    on = vi.fn();
    isDestroyed = () => false;
    loadFile = vi.fn(() => Promise.resolve());
    loadURL = vi.fn(() => Promise.resolve());
    isMinimized = vi.fn(() => false);
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    constructor() {
      hoisted.windows.push(this);
    }
  }
  class FakeNotification {
    static isSupported = () => { hoisted.calls.push('isSupported'); return true; };
    static handleActivation = (callback: (details: unknown) => void) => { hoisted.calls.push('handleActivation'); hoisted.activation = callback; };
    listeners = new Map<string, () => void>();
    show = vi.fn();
    constructor(readonly options: Record<string, unknown>) {
      hoisted.notifications.push(this);
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
  }
  return {
    Notification: FakeNotification,
    app: {
      isPackaged: true,
      setName: vi.fn(),
      setAppUserModelId: (id: string) => { hoisted.userModelIds.push(id); hoisted.calls.push('setAppUserModelId'); },
      setToastActivatorCLSID: (id: string) => { hoisted.calls.push(`setToastActivatorCLSID ${id}`); throw new Error('Invalid CLSID format'); },
      getVersion: () => '0.0.0',
      getPath: () => 'C:\\userData',
      getAppPath: () => 'C:\\project',
      whenReady: () => { hoisted.calls.push('whenReady'); return Promise.resolve(); },
      on: (event: string, listener: (...args: unknown[]) => void) => hoisted.appListeners.set(event, listener),
      quit: vi.fn(),
    },
    BrowserWindow: FakeWindow,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    nativeTheme: { themeSource: 'dark' },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (h: typeof hoisted.permissionRequest) => {
          hoisted.permissionRequest = h;
        },
        setPermissionCheckHandler: (h: typeof hoisted.permissionCheck) => {
          hoisted.permissionCheck = h;
        },
        on: (event: string) => hoisted.sessionEvents.push(event),
      },
    },
  };
});
vi.mock('./backend', () => ({ startBackend: hoisted.startBackend }));
vi.mock('./app-ipc', () => ({ registerAppIpc: vi.fn() }));
vi.mock('./ipc', () => ({ handleTrusted: (channel: string, _sender: unknown, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler) }));
// One backend for every test (index.ts is started once): its Snapshot has one open escalation.
hoisted.startBackend.mockResolvedValue({
  status: 'ready',
  facade: { snapshot: () => ({ preferences: { theme: 'dark' }, sessions: [{ id: 's-1', title: '研究 <b>' }], escalations: [{ id: 'esc-1', state: 'open', fromSessionId: 's-1', title: 'Write outside' }] }) },
  unfinishedWork: () => Promise.resolve({}),
  shutdown: () => Promise.resolve(),
});
vi.mock('./runtime-locator', () => ({ createRuntimeLocator: () => ({ detect: vi.fn(), current: vi.fn() }) }));

describe('T042 index.ts installs the guards', () => {
  it('every web contents made later is guarded, and the default session grants nothing', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.startBackend).toHaveBeenCalledTimes(1));
    // T040 r1 P1-4: the backend gets the file system's folder check, not a stand-in.
    expect((hoisted.startBackend.mock.calls[0]![0] as { folderState?: unknown }).folderState).toBe((await import('./real-path')).folderState);

    const created = hoisted.appListeners.get('web-contents-created');
    expect(created).toBeDefined();
    const events = new Map<string, (...args: unknown[]) => void>();
    let openHandler: (() => { action: string }) | undefined;
    const later = {
      getURL: () => 'https://example.com/',
      setWindowOpenHandler: (h: () => { action: string }) => {
        openHandler = h;
      },
      on: (event: string, listener: (...args: unknown[]) => void) => events.set(event, listener),
    };
    created!({}, later);
    expect(openHandler?.()).toEqual({ action: 'deny' });
    expect([...events.keys()].sort()).toEqual(['will-attach-webview', 'will-frame-navigate', 'will-navigate', 'will-redirect']);
    const navigation = { preventDefault: vi.fn() };
    events.get('will-navigate')!(navigation, 'file:///C:/Windows/win.ini');
    expect(navigation.preventDefault).toHaveBeenCalled();

    const cb = vi.fn();
    hoisted.permissionRequest!(undefined, 'notifications', cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(hoisted.permissionCheck!()).toBe(false);
    expect(hoisted.sessionEvents).toContain('will-download');
  });

  it('T057: the page gets no notification permission, also for its own URL', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.permissionRequest).toBeDefined());
    const app = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
    const refused = vi.fn();
    hoisted.permissionRequest!({ getURL: () => app }, 'notifications', refused, { requestingUrl: app, isMainFrame: true });
    expect(refused).toHaveBeenCalledWith(false);
    expect(hoisted.permissionCheck!({ getURL: () => app }, 'notifications', 'file:///', { requestingUrl: app, isMainFrame: true })).toBe(false);
  });

  it('T057: on Windows the ID and the activator class are set and clicks are handled before ready; the service starts when ready', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.windows.length).toBe(1));
    if (process.platform !== 'win32') {
      expect(hoisted.userModelIds).toEqual([]);
      return;
    }
    // A packaged app: the installed app's ID and class. The class being refused (it throws here) does not stop the start.
    expect(hoisted.userModelIds).toEqual([APP_USER_MODEL_ID]);
    expect(hoisted.calls.slice(0, 5)).toEqual(['setAppUserModelId', `setToastActivatorCLSID ${TOAST_ACTIVATOR_CLSID}`, 'handleActivation', 'whenReady', 'isSupported']);
  });

  it('T057: the notice channel takes the escalation ID only; the main process writes the text', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.windows.length).toBe(1));
    const notice = hoisted.handlers.get(ESCALATION_NOTICE_CHANNEL)!;
    expect(notice).toBeDefined();
    expect(hoisted.handlers.has('app:focus-window')).toBe(false);
    await notice('esc-1', '<b>title from the page</b>', { body: 'page text' });
    await notice('esc-missing');
    expect(hoisted.notifications).toHaveLength(1);
    const [shown] = hoisted.notifications;
    expect(shown!.options['title']).toBe('需要你處理');
    expect(shown!.options['body']).toBe('研究 <b>：Write outside');
    expect(JSON.stringify(shown!.options)).not.toContain('from the page');
    expect(shown!.show).toHaveBeenCalledTimes(1);
    if (process.platform === 'win32') expect(shown!.options['toastXml']).toContain(`launch="${LAUNCH_PREFIX}esc-1"`);
  });

  it('T057: a Windows activation brings the window forward and tells the page which escalation to open', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.windows.length).toBe(1));
    if (process.platform !== 'win32') return;
    const win = hoisted.windows[0]!;
    win.isMinimized.mockReturnValue(true);
    hoisted.activation!({ type: 'click', arguments: `${LAUNCH_PREFIX}esc-1` });
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalledWith(ESCALATION_ACTIVATED_CHANNEL, { escalationId: 'esc-1' }));
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    win.webContents.send.mockClear();
    hoisted.activation!({ type: 'click', arguments: '--some-flag' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
