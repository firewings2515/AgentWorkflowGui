// T044 (review r2): the main process hands the backend where the app runs from. The string logic of
// packaged-paths.ts is tested on its own; this starts app/main/index.ts against a fake Electron and checks
// what startBackend receives, so a dropped `packaged` option fails here and not only in the installed app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_RESOURCES = 'C:\\Apps\\AgentWorkflowGui\\resources';

const hoisted = vi.hoisted(() => ({ startBackend: vi.fn() }));

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
      isPackaged: true,
      setName: vi.fn(),
      getVersion: () => '0.0.0',
      getPath: () => 'C:\\userData',
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      quit: vi.fn(),
    },
    BrowserWindow: FakeWindow,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    nativeTheme: { themeSource: 'dark' },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  };
});
vi.mock('./backend', () => ({ startBackend: hoisted.startBackend }));
vi.mock('./app-ipc', () => ({ registerAppIpc: vi.fn() }));
vi.mock('./ipc', () => ({ handleTrusted: vi.fn() }));

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

describe('T044 index.ts passes where the app runs from to the backend', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.startBackend.mockReset();
    hoisted.startBackend.mockResolvedValue({ status: 'ready', facade: { snapshot: () => ({ preferences: { theme: 'dark' } }) }, unfinishedWork: () => Promise.resolve({}), shutdown: () => Promise.resolve() });
    Object.defineProperty(process, 'resourcesPath', { value: FAKE_RESOURCES, configurable: true, writable: true });
  });
  afterEach(() => {
    if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
    else Reflect.deleteProperty(process, 'resourcesPath');
  });

  it('gives startBackend app.isPackaged and process.resourcesPath', async () => {
    await import('./index');
    await vi.waitFor(() => expect(hoisted.startBackend).toHaveBeenCalledTimes(1));
    const options = hoisted.startBackend.mock.calls[0]?.[0] as { packaged?: unknown };
    expect(options.packaged).toEqual({ isPackaged: true, resourcesPath: FAKE_RESOURCES });
  });
});
