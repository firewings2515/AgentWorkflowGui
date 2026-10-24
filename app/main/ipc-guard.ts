import { pathToFileURL } from 'node:url';

/** The subset of `IpcMainInvokeEvent` the guard looks at. */
export interface IpcSenderEvent {
  readonly sender: { readonly id: number; readonly mainFrame: unknown };
  readonly senderFrame: { readonly url: string } | null;
}

/** Identity of the one window (and pages) allowed to call IPC handlers. */
export interface TrustedSender {
  readonly webContentsId: number;
  isTrustedUrl(url: string): boolean;
}

/**
 * Accepts a call only from the main frame of our own window, showing one of our own pages.
 * https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages
 */
export function isTrustedSender(event: IpcSenderEvent, trusted: TrustedSender | null): boolean {
  if (trusted === null) return false;
  const frame = event.senderFrame;
  if (frame === null) return false;
  return (
    event.sender.id === trusted.webContentsId &&
    frame === event.sender.mainFrame &&
    trusted.isTrustedUrl(frame.url)
  );
}

/**
 * Matches the dev server origin when one is configured, otherwise exactly the packaged
 * renderer page (query and hash ignored).
 */
export function createTrustedUrlMatcher(options: {
  devUrl: string | undefined;
  rendererFile: string;
}): (url: string) => boolean {
  const { devUrl, rendererFile } = options;
  if (devUrl) {
    const dev = new URL(devUrl);
    // Compare the protocol too: `blob:http://localhost:5173/…` reports the dev origin as its origin.
    return (url) => {
      if (!URL.canParse(url)) return false;
      const candidate = new URL(url);
      return candidate.protocol === dev.protocol && candidate.origin === dev.origin;
    };
  }
  const appUrl = pathToFileURL(rendererFile).href;
  return (url) => {
    if (!URL.canParse(url)) return false;
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href === appUrl;
  };
}
