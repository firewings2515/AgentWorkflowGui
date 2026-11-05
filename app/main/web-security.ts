// What the app's web contents may do (T042, V-18). The renderer is one local page that shows untrusted text
// (conversations, file names, errors): nothing in it may open a window, leave the page, load a frame, attach a
// <webview>, start a download or be granted a permission (the system notifications of escalations are shown by the main
// process, T057, so the page needs none). Applied to every web contents the app creates, not only the main window, so a contents made some other way gets the same rules.
// https://www.electronjs.org/docs/latest/tutorial/security

/** A cancellable navigation; `url` and `isMainFrame` as Electron's `will-frame-navigate` gives them. */
export interface NavigationEvent {
  preventDefault(): void;
}

/** The part of `WebContents` the guard uses. */
export interface GuardedContents {
  getURL(): string;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): unknown;
  on(event: 'will-frame-navigate', listener: (details: NavigationEvent & { url: string; isMainFrame: boolean }) => void): unknown;
  on(event: 'will-redirect', listener: (details: NavigationEvent & { url: string }) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: NavigationEvent) => void): unknown;
}

export function guardWebContents(contents: GuardedContents, isTrustedUrl: (url: string) => boolean): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The page itself may only reload; a link, `location`, a form or a dropped file never replaces it.
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL() || !isTrustedUrl(url)) event.preventDefault();
  });
  // The page has no frames: none may navigate anywhere.
  contents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame) details.preventDefault();
  });
  contents.on('will-redirect', (details) => {
    if (!isTrustedUrl(details.url)) details.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** The part of Electron's `Session` the guard uses. */
export interface GuardedSession {
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  on(event: 'will-download', listener: (event: NavigationEvent) => void): unknown;
}

/**
 * Electron grants every permission unless told otherwise (notifications, media, geolocation, opening an
 * external protocol). The renderer needs none of them, so every request and check is refused. The escalation
 * notifications of U3 are shown by the main process (T057), which needs no permission of the page; the exception T055
 * made for the page's own notifications is gone.
 */
export function guardSession(session: GuardedSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
}
