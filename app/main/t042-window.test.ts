// T042 (V-18): untrusted content is never run, and IPC from anything but the app's own page is refused. The
// Electron objects are stand-ins with the same events; the live run checks the real window (T042-report.md).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_INFO_CHANNEL, COMMAND_CHANNEL, FOCUS_WINDOW_CHANNEL, FOLDER_CHANNEL, SNAPSHOT_CHANNEL } from '../preload/channels';
import { guardHandler } from './ipc';
import type { IpcSenderEvent, TrustedSender } from './ipc-guard';
import { type GuardedContents, type GuardedSession, guardSession, guardWebContents, type NavigationEvent, type PermissionDetails } from './web-security';
import { createWebPreferences } from './window-options';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const APP = 'file:///C:/app/resources/app.asar/out/renderer/index.html';
const isTrustedUrl = (url: string) => url.split('#')[0] === APP;

const fakeContents = (url = `${APP}#/workbench`) => {
  const listeners = new Map<string, (...args: never[]) => void>();
  let openHandler: (() => { action: string }) | undefined;
  const contents: GuardedContents = {
    getURL: () => url,
    setWindowOpenHandler: (h) => {
      openHandler = h;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    },
  };
  guardWebContents(contents, isTrustedUrl);
  const prevented = (event: string, ...args: unknown[]) => {
    const e: NavigationEvent & Record<string, unknown> = { preventDefault: vi.fn(), ...(typeof args[0] === 'object' ? (args[0] as object) : {}) };
    (listeners.get(event) as unknown as (...a: unknown[]) => void)(e, ...args.slice(typeof args[0] === 'object' ? 1 : 0));
    return (e.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0;
  };
  return { open: () => openHandler?.(), prevented };
};

describe('T042 C2/C3/C6: the window never leaves its page', () => {
  it('window.open and target=_blank are denied', () => {
    expect(fakeContents().open()).toEqual({ action: 'deny' });
  });

  it.each([
    'https://example.com/',
    'file:///C:/Windows/win.ini',
    'file:///C:/Users/x/Downloads/evil.html',
    `${APP}/../other.html`,
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
  ])('the main frame cannot navigate to %s', (url) => {
    expect(fakeContents().prevented('will-navigate', url)).toBe(true);
  });

  it('only a reload of the same page goes through', () => {
    const url = `${APP}#/workbench`;
    expect(fakeContents(url).prevented('will-navigate', url)).toBe(false);
    // The same URL while the window shows something that is not the app is still refused.
    expect(fakeContents('https://example.com/').prevented('will-navigate', 'https://example.com/')).toBe(true);
  });

  it('no frame may navigate, and redirects off the app are cancelled', () => {
    const c = fakeContents();
    expect(c.prevented('will-frame-navigate', { url: APP, isMainFrame: false })).toBe(true);
    expect(c.prevented('will-frame-navigate', { url: 'https://example.com/', isMainFrame: false })).toBe(true);
    // The main frame's own navigation is will-navigate's to decide.
    expect(c.prevented('will-frame-navigate', { url: APP, isMainFrame: true })).toBe(false);
    expect(c.prevented('will-redirect', { url: 'https://example.com/' })).toBe(true);
    expect(c.prevented('will-attach-webview')).toBe(true);
  });
});

describe('T055: the one permission, notifications for the app’s own main frame', () => {
  type Contents = { getURL(): string } | null | undefined;
  const appContents = { getURL: () => `${APP}#/settings` };
  const main = { requestingUrl: APP, isMainFrame: true };
  const rig = () => {
    let request: ((wc: Contents, permission: string, cb: (granted: boolean) => void, details?: PermissionDetails) => void) | undefined;
    let check: ((wc: Contents, permission: string, origin?: string, details?: PermissionDetails) => boolean) | undefined;
    const session: GuardedSession = {
      setPermissionRequestHandler: (h) => {
        request = h;
      },
      setPermissionCheckHandler: (h) => {
        check = h;
      },
      on: () => undefined,
    };
    guardSession(session, isTrustedUrl);
    const asked = (permission: string, details?: PermissionDetails, opts: { contents?: Contents | undefined } = {}) => {
      const cb = vi.fn();
      request!('contents' in opts ? opts.contents : appContents, permission, cb, details);
      return cb.mock.calls[0]![0] as boolean;
    };
    const checked = (permission: string, details?: PermissionDetails, opts: { contents?: Contents | undefined; origin?: string | undefined } = {}) =>
      check!('contents' in opts ? opts.contents : appContents, permission, 'origin' in opts ? opts.origin : 'file:///', details);
    return { asked, checked };
  };

  it('notifications are granted when every piece of evidence is the app’s own, in a request and in a check', () => {
    const { asked, checked } = rig();
    for (const details of [main, { requestingUrl: `${APP}#/settings`, isMainFrame: true }]) {
      expect(asked('notifications', details)).toBe(true);
      expect(checked('notifications', details)).toBe(true);
    }
    // Electron may write the origin of a file page with or without the slashes.
    expect(checked('notifications', main, { origin: 'file://' })).toBe(true);
  });

  it('the development server’s page is granted by its own origin only', () => {
    const dev = 'http://localhost:5173/';
    const session = { handlers: {} as { check?: (...args: never[]) => boolean } };
    guardSession({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: (h) => { session.handlers.check = h; }, on: () => undefined },
      (url) => URL.canParse(url) && new URL(url).origin === 'http://localhost:5173');
    const call = session.handlers.check as unknown as (wc: Contents, p: string, origin: string, d: PermissionDetails) => boolean;
    const page = { getURL: () => dev };
    expect(call(page, 'notifications', 'http://localhost:5173', { requestingUrl: dev, isMainFrame: true })).toBe(true);
    expect(call(page, 'notifications', 'http://localhost:5174', { requestingUrl: dev, isMainFrame: true })).toBe(false);
  });

  it.each([
    ['another URL', { requestingUrl: 'https://example.com/', isMainFrame: true }],
    ['a local file that is not the app', { requestingUrl: 'file:///C:/Windows/win.ini', isMainFrame: true }],
    ['a sub-frame, even with the app’s URL', { requestingUrl: APP, isMainFrame: false }],
    ['a request that does not say whether it is the main frame', { requestingUrl: APP }],
    ['a request that names no URL', { isMainFrame: true }],
    ['a request with no details', undefined],
  ])('notifications are refused for %s', (_name, details) => {
    const { asked, checked } = rig();
    expect(asked('notifications', details)).toBe(false);
    expect(checked('notifications', details)).toBe(false);
  });

  it.each([
    ['no web contents (null)', null],
    ['no web contents (undefined)', undefined],
    ['a web contents that shows another page', { getURL: () => 'https://example.com/' }],
    ['a web contents that shows a local file that is not the app', { getURL: () => 'file:///C:/Windows/win.ini' }],
    ['a web contents that shows nothing', { getURL: () => '' }],
  ])('notifications are refused with %s, even for the app’s URL', (_name, contents) => {
    const { asked, checked } = rig();
    expect(asked('notifications', main, { contents })).toBe(false);
    expect(checked('notifications', main, { contents })).toBe(false);
  });

  it.each([
    ['a different origin', 'https://example.com'],
    ['the origin of another port', 'http://localhost:5173'],
    ['an origin that is not written as one', 'not an origin'],
    ['an empty origin', ''],
    ['no origin', undefined],
  ])('a check is refused with %s as the requesting origin', (_name, origin) => {
    const { checked } = rig();
    expect(checked('notifications', main, { origin })).toBe(false);
  });

  it('every other permission is refused for the app’s own page too', () => {
    const { asked, checked } = rig();
    for (const permission of ['media', 'geolocation', 'openExternal', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'midi', 'Notifications']) {
      expect(asked(permission, main), permission).toBe(false);
      expect(checked(permission, main), permission).toBe(false);
    }
  });
});

describe('T042 F3/C5: no permission is ever granted', () => {
  it('every request and check is refused, and downloads are cancelled', () => {
    let request: Parameters<GuardedSession['setPermissionRequestHandler']>[0] | undefined;
    let check: Parameters<GuardedSession['setPermissionCheckHandler']>[0] | undefined;
    let download: ((e: NavigationEvent) => void) | undefined;
    const session: GuardedSession = {
      setPermissionRequestHandler: (h) => {
        request = h;
      },
      setPermissionCheckHandler: (h) => {
        check = h;
      },
      on: (_event, listener) => {
        download = listener;
      },
    };
    guardSession(session);
    for (const permission of ['notifications', 'media', 'geolocation', 'openExternal', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']) {
      const cb = vi.fn();
      request!(undefined, permission, cb);
      expect(cb, permission).toHaveBeenCalledWith(false);
    }
    expect(check!(undefined, 'notifications')).toBe(false);
    const e = { preventDefault: vi.fn() };
    download!(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe('T042 C6: webPreferences', () => {
  it('keeps the renderer isolated, sandboxed, without Node, webviews or insecure content', () => {
    expect(createWebPreferences('p.js')).toEqual({
      preload: 'p.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      experimentalFeatures: false,
    });
  });
});

describe('T042 C4: the renderer page CSP', () => {
  const html = readFileSync(join(import.meta.dirname, '../renderer/index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  const directives = new Map(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0] !== '')
      .map(([name, ...values]) => [name!, values]),
  );

  it('allows scripts only from the app itself: no inline script, no eval', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-hashes|strict-dynamic|wasm-unsafe-eval|\*|https?:|data:|blob:/);
  });

  it('closes what default-src does not cover: base URL and form targets; no plugins', () => {
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('has no inline script in the page itself', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('T042 C1: the renderer has no way to turn text into markup or code', () => {
  // The rendering half is app/renderer/src/T042-injection.test.tsx; the renderer layer may not read files.
  const dir = join(import.meta.dirname, '../renderer/src');
  const sources = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.includes('test-'));
  it.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML / outerHTML', /\.(inner|outer)HTML\b/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\.write/],
    ['eval / new Function', /\beval\(|new Function\(/],
    ['window.open', /window\.open\(/],
    ['srcDoc / iframe / webview', /srcDoc|<iframe|<webview/],
    ['javascript: URLs', /javascript:/],
  ])('no source uses %s', (_name, pattern) => {
    expect(sources.length).toBeGreaterThan(20);
    for (const file of sources) expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(pattern);
  });
});

describe('T042 D1: IPC from anything but the app’s own page', () => {
  const mainFrame = { url: APP };
  const trusted: TrustedSender = { webContentsId: 7, isTrustedUrl };
  const SECRET = 'C:\\Users\\someone\\.ssh\\id_rsa Bearer sk-live-0123';
  const senders: [string, IpcSenderEvent][] = [
    ['another web contents', { sender: { id: 8, mainFrame }, senderFrame: mainFrame }],
    // Another frame object than the main frame, even with the app's URL.
    ['a sub-frame of the window', { sender: { id: 7, mainFrame }, senderFrame: { url: APP } }],
    ['another page in the window', { sender: { id: 7, mainFrame: { url: 'https://example.com/' } }, senderFrame: { url: 'https://example.com/' } }],
    ['a frame that is gone', { sender: { id: 7, mainFrame }, senderFrame: null }],
  ];

  it.each(senders)('is refused on every channel from %s; the handler never sees the arguments', (_name, event) => {
    for (const channel of [APP_INFO_CHANNEL, SNAPSHOT_CHANNEL, COMMAND_CHANNEL, FOLDER_CHANNEL, FOCUS_WINDOW_CHANNEL]) {
      const handler = vi.fn();
      const guarded = guardHandler(channel, () => trusted, handler);
      let message = '';
      try {
        guarded(event, { type: 'session.create', cwd: SECRET });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(handler).not.toHaveBeenCalled();
      expect(message).toMatch(/untrusted sender/);
      expect(message).not.toContain('someone');
      expect(message).not.toContain('sk-live');
    }
  });

  it('is refused while the window does not exist', () => {
    const handler = vi.fn(() => undefined);
    expect(() => guardHandler(COMMAND_CHANNEL, () => null, handler)({ sender: { id: 7, mainFrame }, senderFrame: mainFrame })).toThrow(/untrusted sender/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the app’s own main frame goes through', () => {
    const handler = vi.fn(() => 'ok');
    expect(guardHandler(COMMAND_CHANNEL, () => trusted, handler)({ sender: { id: 7, mainFrame }, senderFrame: mainFrame }, 'arg')).toBe('ok');
    expect(handler).toHaveBeenCalledWith('arg');
  });
});
