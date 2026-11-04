// T045: the main process hands the backend a RuntimeLocator for the user's own Claude Code and Codex. This starts
// app/main/index.ts against a fake Electron and checks what it gives startBackend and the locator, so a dropped
// option fails here and not only in the installed app. A packaged app never falls back to the SDK's claude.exe.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ startBackend: vi.fn(), createRuntimeLocator: vi.fn(), isPackaged: { value: true }, setAppUserModelId: vi.fn(), setToastActivatorCLSID: vi.fn() }));

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
  }
  return {
    app: {
      get isPackaged() {
        return hoisted.isPackaged.value;
      },
      setName: vi.fn(),
      setAppUserModelId: hoisted.setAppUserModelId,
      setToastActivatorCLSID: hoisted.setToastActivatorCLSID,
      getVersion: () => '0.0.0',
      getPath: () => 'C:\\userData',
      getAppPath: () => 'C:\\project',
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      quit: vi.fn(),
    },
    BrowserWindow: FakeWindow,
    Notification: class { static isSupported = () => true; static handleActivation = vi.fn(); },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    nativeTheme: { themeSource: 'dark' },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() } },
  };
});
vi.mock('./backend', () => ({ startBackend: hoisted.startBackend }));
vi.mock('./app-ipc', () => ({ registerAppIpc: vi.fn() }));
vi.mock('./ipc', () => ({ handleTrusted: vi.fn() }));
vi.mock('./runtime-locator', () => ({ createRuntimeLocator: hoisted.createRuntimeLocator }));

describe('T057 the installed app and a development run have their own Windows ID and notification class', () => {
  it.runIf(process.platform === 'win32')('packaged: the installer’s; development: the .dev ones', async () => {
    const ids = await import('./app-id');
    for (const packaged of [true, false]) {
      vi.resetModules();
      hoisted.setAppUserModelId.mockClear();
      hoisted.setToastActivatorCLSID.mockClear();
      hoisted.startBackend.mockReset();
      hoisted.createRuntimeLocator.mockReturnValue({ detect: vi.fn(), current: vi.fn() });
      hoisted.startBackend.mockResolvedValue({ status: 'ready', facade: { snapshot: () => ({ preferences: { theme: 'dark' } }) }, unfinishedWork: () => Promise.resolve({}), shutdown: () => Promise.resolve() });
      hoisted.isPackaged.value = packaged;
      await import('./index');
      await vi.waitFor(() => expect(hoisted.startBackend).toHaveBeenCalledTimes(1));
      expect(hoisted.setAppUserModelId.mock.calls).toEqual([[packaged ? ids.APP_USER_MODEL_ID : ids.DEV_APP_USER_MODEL_ID]]);
      expect(hoisted.setToastActivatorCLSID.mock.calls).toEqual([[packaged ? ids.TOAST_ACTIVATOR_CLSID : ids.DEV_TOAST_ACTIVATOR_CLSID]]);
    }
  });
});

describe('T045 index.ts gives the backend the runtime locator', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.startBackend.mockReset();
    hoisted.createRuntimeLocator.mockReset();
    hoisted.createRuntimeLocator.mockReturnValue({ detect: vi.fn(), current: vi.fn() });
    hoisted.startBackend.mockResolvedValue({ status: 'ready', facade: { snapshot: () => ({ preferences: { theme: 'dark' } }) }, unfinishedWork: () => Promise.resolve({}), shutdown: () => Promise.resolve() });
  });

  const start = async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.startBackend).toHaveBeenCalledTimes(1));
    return hoisted.startBackend.mock.calls[0]?.[0] as { runtimes?: unknown; packaged?: unknown; codexExecutable?: unknown };
  };

  it('passes the locator, and no executable or asar path of its own', async () => {
    hoisted.isPackaged.value = true;
    const options = await start();
    expect(options.runtimes).toBe(hoisted.createRuntimeLocator.mock.results[0]?.value);
    expect(options.packaged).toBeUndefined();
    expect(options.codexExecutable).toBeUndefined();
  });

  it('a packaged app has no SDK fallback; a development run has one', async () => {
    hoisted.isPackaged.value = true;
    await start();
    expect((hoisted.createRuntimeLocator.mock.calls[0]?.[0] as { sdkBundledClaude?: unknown }).sdkBundledClaude).toBeUndefined();

    vi.resetModules();
    hoisted.startBackend.mockClear();
    hoisted.createRuntimeLocator.mockClear();
    hoisted.isPackaged.value = false;
    await start();
    expect(typeof (hoisted.createRuntimeLocator.mock.calls[0]?.[0] as { sdkBundledClaude?: unknown }).sdkBundledClaude).toBe('function');
  });
});

describe('T039 the crash tests’ fault point reaches the backend of a development run only', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.startBackend.mockReset();
    hoisted.createRuntimeLocator.mockReset();
    hoisted.createRuntimeLocator.mockReturnValue({ detect: vi.fn(), current: vi.fn() });
    hoisted.startBackend.mockResolvedValue({ status: 'ready', facade: { snapshot: () => ({ preferences: { theme: 'dark' } }) }, unfinishedWork: () => Promise.resolve({}), shutdown: () => Promise.resolve() });
    vi.stubEnv('AWG_FAULT_POINT', 'dispatch');
    vi.stubEnv('AWG_FAULT_SESSION', 'session-a');
  });

  const started = async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.startBackend).toHaveBeenCalledTimes(1));
    vi.unstubAllEnvs();
    return hoisted.startBackend.mock.calls[0]?.[0] as { faultPoint?: unknown };
  };

  it('a development run passes it on', async () => {
    hoisted.isPackaged.value = false;
    expect((await started()).faultPoint).toEqual({ point: 'dispatch', sessionId: 'session-a' });
  });

  it('a packaged app never reads it', async () => {
    hoisted.isPackaged.value = true;
    expect('faultPoint' in (await started())).toBe(false);
  });
});
