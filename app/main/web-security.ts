// What the app's web contents may do (T042, V-18). The renderer is one local page that shows untrusted text
// (conversations, file names, errors): nothing in it may open a window, leave the page, load a frame, attach a
// <webview>, start a download or be granted a permission (the one exception is
// the notification of an escalation that needs the user, see `guardSession`: U3 Q-15, T055). Applied to every web contents the app creates, not
// only the main window, so a contents made some other way gets the same rules.
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

/** What Electron tells a permission request or check about where it comes from (the part the guard uses). */
export interface PermissionDetails {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
}

/** The part of Electron's `Session` the guard uses. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void, details?: PermissionDetails) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string, requestingOrigin?: string, details?: PermissionDetails) => boolean): void;
  on(event: 'will-download', listener: (event: NavigationEvent) => void): unknown;
}

/**
 * The one permission the app grants (U3 Q-15, T055): system notifications for a new escalation that needs the user.
 * Only `notifications`, only to the main frame of the app's own page (`isTrustedUrl`); a request without those details,
 * from another URL or from a frame is refused like every other permission.
 */
function notificationsAllowed(permission: string, details: PermissionDetails | undefined, isTrustedUrl: (url: string) => boolean): boolean {
  if (permission !== 'notifications' || details === undefined) return false;
  return details.isMainFrame !== false && typeof details.requestingUrl === 'string' && isTrustedUrl(details.requestingUrl);
}

/**
 * Electron grants every permission unless told otherwise (notifications, media, geolocation, opening an
 * external protocol). The renderer needs none of them except the notification above, so every other request and
 * check is refused.
 */
export function guardSession(session: GuardedSession, isTrustedUrl: (url: string) => boolean = () => false): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(notificationsAllowed(permission, details, isTrustedUrl)));
  session.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => notificationsAllowed(permission, details, isTrustedUrl));
  session.on('will-download', (event) => event.preventDefault());
}
