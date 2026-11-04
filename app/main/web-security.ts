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

/** The part of `WebContents` the permission guard uses. */
export interface PermissionContents {
  getURL(): string;
}

/** What Electron tells a permission request or check about where it comes from (the part the guard uses). */
export interface PermissionDetails {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
}

/** The part of Electron's `Session` the guard uses. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (webContents: PermissionContents | null | undefined, permission: string, callback: (granted: boolean) => void, details?: PermissionDetails) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: PermissionContents | null | undefined, permission: string, requestingOrigin?: string, details?: PermissionDetails) => boolean,
  ): void;
  on(event: 'will-download', listener: (event: NavigationEvent) => void): unknown;
}

/** An origin written for comparison: Electron may or may not end a `file://` origin with slashes, and Node gives it as "null". */
function originKey(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'file:' ? 'file:' : parsed.origin.replace(/\/+$/, '');
}

/**
 * The one permission the app grants (U3 Q-15, T055): system notifications for a new escalation that needs the user.
 * Every piece of evidence has to be there and has to be ours, or the answer is no: only `notifications`; the web contents
 * exists and shows the app's own page; the request comes from its main frame (`isMainFrame === true`, not merely "not
 * false"); the requesting URL is the app's own page; and, in a check, the requesting origin is that page's origin.
 * Anything missing (a field Electron did not send, a null contents) means a refusal, like every other permission.
 */
function notificationsAllowed(
  contents: PermissionContents | null | undefined, permission: string, details: PermissionDetails | undefined,
  isTrustedUrl: (url: string) => boolean, origin?: { given: string | undefined },
): boolean {
  if (permission !== 'notifications' || !contents || !details) return false;
  if (details.isMainFrame !== true || typeof details.requestingUrl !== 'string' || !isTrustedUrl(details.requestingUrl)) return false;
  const shown = contents.getURL();
  if (!isTrustedUrl(shown)) return false;
  if (origin === undefined) return true;
  const expected = originKey(details.requestingUrl);
  return expected !== undefined && typeof origin.given === 'string' && originKey(origin.given) === expected && originKey(shown) === expected;
}

/**
 * Electron grants every permission unless told otherwise (notifications, media, geolocation, opening an
 * external protocol). The renderer needs none of them except the notification above, so every other request and
 * check is refused.
 */
export function guardSession(session: GuardedSession, isTrustedUrl: (url: string) => boolean = () => false): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(notificationsAllowed(contents, permission, details, isTrustedUrl)));
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    notificationsAllowed(contents, permission, details, isTrustedUrl, { given: requestingOrigin }));
  session.on('will-download', (event) => event.preventDefault());
}
