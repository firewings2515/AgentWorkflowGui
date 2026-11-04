// T042 r1-P2-2: app/main/index.ts itself installs the guards. This starts index.ts against a fake Electron (as
// index.runtimes.test.ts does), then hands it a web contents made after start, the way Electron's
// `web-contents-created` does, and checks the guard is on it; and that the default session refuses permissions.
import { describe, expect, it, vi } from 'vitest';
import { FOCUS_WINDOW_CHANNEL } from '../preload/channels';
import { APP_USER_MODEL_ID } from './app-id';

const hoisted = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  permissionRequest: undefined as ((wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void) | undefined,
  permissionCheck: undefined as ((...args: unknown[]) => boolean) | undefined,
  sessionEvents: [] as string[],
  startBackend: vi.fn(),
  windows: [] as { isMinimized: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userModelIds: [] as string[],
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
  return {
    app: {
      isPackaged: true,
      setName: vi.fn(),
      setAppUserModelId: (id: string) => hoisted.userModelIds.push(id),
      getVersion: () => '0.0.0',
      getPath: () => 'C:\\userData',
      getAppPath: () => 'C:\\project',
      whenReady: () => Promise.resolve(),
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
vi.mock('./runtime-locator', () => ({ createRuntimeLocator: () => ({ detect: vi.fn(), current: vi.fn() }) }));

describe('T042 index.ts installs the guards', () => {
  it('every web contents made later is guarded, and the default session grants nothing', async () => {
    hoisted.startBackend.mockResolvedValue({ status: 'ready', facade: { snapshot: () => ({ preferences: { theme: 'dark' } }) }, unfinishedWork: () => Promise.resolve({}), shutdown: () => Promise.resolve() });
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

  it('T055: the notifications exception is wired with the app’s own URL matcher', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.permissionRequest).toBeDefined());
    const cb = vi.fn();
    hoisted.permissionRequest!(undefined, 'notifications', cb, { requestingUrl: 'https://example.com/', isMainFrame: true });
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('T055: focusWindow acts on the app’s own window only and uses nothing the page sends', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.windows.length).toBe(1));
    const win = hoisted.windows[0]!;
    const focus = hoisted.handlers.get(FOCUS_WINDOW_CHANNEL)!;
    expect(focus).toBeDefined();
    expect(focus.length).toBe(0);
    win.isMinimized.mockReturnValue(true);
    expect(focus('E:\\other', { id: 99 })).toBe(true);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('T055: Windows gets the AppUserModelID of the installed app', async () => {
    await import('./index');
    if (process.platform === 'win32') expect(hoisted.userModelIds).toEqual([APP_USER_MODEL_ID]);
    else expect(hoisted.userModelIds).toEqual([]);
  });
});
