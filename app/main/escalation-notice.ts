// The system notification of an escalation that needs the user (U3 Q-15, T055), shown by the main process (T057).
//
// The renderer still decides *when* (a new open escalation, the window not in front, the setting on) and names the
// escalation by its ID, nothing else. This module looks the escalation up itself, writes the text from its own data,
// and shows an Electron `Notification`. On Windows the toast is written as `toastXml` with the escalation in its
// `launch` argument, because Electron's own toast has no `launch`: a click from the Action Center would arrive with
// empty arguments. A click arrives one of two ways (Electron 45, shell/browser/notifications/win/):
//   - in the process, while the toast object lives (the banner): only the instance's `click`;
//   - through the COM activator (the Action Center, a collected object, a restarted app): `Notification.handleActivation`
//     first, then the instance's `click` if the object still lives.
// Either way the window comes forward and, for an escalation the backend has, the renderer is told to open it.
import type { Snapshot } from '../../contracts';
import { ESCALATION_ACTIVATED_CHANNEL } from '../preload/channels';
import { type FocusableWindow, focusWindow } from './focus-window';

export const NOTICE_TITLE = '需要你處理';
export const NOTICE_BODY_LIMIT = 100;
/** The `launch` argument of a toast: this prefix, then the escalation ID, URI-encoded (so no `&` or `=`). */
export const LAUNCH_PREFIX = 'awg-escalation:';
/** The longest escalation ID taken from the page or from a click. */
export const MAX_ESCALATION_ID = 256;
/**
 * The longest `launch` argument (T057 r1 P2): long enough for every ID that may be shown, so whatever is shown can be
 * clicked. `encodeURIComponent` writes one UTF-16 unit as at most 9 characters (`%E4%B8%AD`; a surrogate pair is 12 for
 * two units), so 256 units are at most 2304.
 */
export const MAX_LAUNCH = LAUNCH_PREFIX.length + MAX_ESCALATION_ID * 9;
const LAUNCH = /^awg-escalation:([A-Za-z0-9\-_.!~*'()%]+)$/;

// Line breaks and tabs become one space. Every other control character, the bidi controls, a lone surrogate and the two
// non-characters XML does not allow are dropped.
const isBreak = (cp: number) => cp === 0x0a || cp === 0x0d || cp === 0x09 || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
const isDropped = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e)
  || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff;
const clean = (text: string) => Array.from(text).map(letter => {
  const cp = letter.codePointAt(0) ?? 0;
  return isBreak(cp) ? ' ' : isDropped(cp) ? '' : letter;
}).join('').replace(/[ ]{2,}/g, ' ').trim();

/** "<session title>：<escalation title>", cleaned and cut to 100 characters (code points). No `detail`. */
export function noticeBody(sessionTitle: string | undefined, escalationTitle: string): string {
  const title = clean(sessionTitle ?? '');
  const text = title ? `${title}：${clean(escalationTitle)}` : clean(escalationTitle);
  const letters = Array.from(text);
  return letters.length > NOTICE_BODY_LIMIT ? `${letters.slice(0, NOTICE_BODY_LIMIT - 1).join('')}…` : text;
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The `launch` argument naming an escalation. Throws for an ID that cannot be encoded (a lone surrogate). */
export function launchArgument(escalationId: string): string {
  return `${LAUNCH_PREFIX}${encodeURIComponent(escalationId)}`;
}

/** The Windows toast: the title and the body as text, a click of its body activates the app with `launch`. */
export function toastXml(launch: string, title: string, body: string): string {
  return `<toast launch="${xml(launch)}" activationType="foreground"><visual><binding template="ToastGeneric">`
    + `<text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
}

/** An escalation ID as the page or a click may give one: a string of 1 to 256 characters. */
function escalationIdOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_ESCALATION_ID ? raw : undefined;
}

/**
 * The escalation a Windows activation names, or undefined. The activation comes from outside the app: only a plain
 * click whose arguments are exactly our `launch` form, with an ID that decodes, is taken.
 */
export function activatedEscalationId(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const { type, arguments: args } = details as { type?: unknown; arguments?: unknown };
  if (type !== 'click' || typeof args !== 'string' || args.length > MAX_LAUNCH) return undefined;
  const match = LAUNCH.exec(args);
  if (!match) return undefined;
  try {
    return escalationIdOf(decodeURIComponent(match[1]!));
  } catch {
    return undefined;
  }
}

/** Electron's error text for the log: one line of at most 200 characters, cleaned; anything else is "unknown". */
const errorText = (error: unknown): string => {
  const text = typeof error === 'string' ? Array.from(clean(error)).slice(0, 200).join('') : '';
  return text === '' ? 'unknown' : text;
};

/** The part of Electron's `Notification` used (a stand-in in tests). */
export interface NoticeLike {
  /** `failed` passes Electron's error text second (after the event). */
  on(event: 'click' | 'close' | 'failed' | 'show', listener: (event?: unknown, error?: unknown) => void): unknown;
  show(): void;
}

export interface NoticeOptions {
  readonly title: string;
  readonly body: string;
  readonly toastXml?: string;
}

/** The main window as far as notices go: brought forward, and told which escalation to open. */
export interface NoticeWindow extends FocusableWindow {
  readonly webContents: { send(channel: string, payload: { escalationId: string }): void };
}

export interface EscalationNoticeDeps {
  /** The backend's current Snapshot; undefined while there is no working backend (starting, damaged). */
  snapshot(): Snapshot | Promise<Snapshot> | undefined;
  /** The main window now (read again after every wait). */
  getWindow(): NoticeWindow | null;
  createNotification(options: NoticeOptions): NoticeLike;
  /** Windows: write the toast as XML with the `launch` argument. */
  readonly useToastXml: boolean;
  log?(message: string): void;
}

export interface EscalationNotices {
  /** The page asks for the notification of one escalation (its ID; anything else is ignored). Never rejects. */
  show(raw: unknown): Promise<void>;
  /** A Windows activation (`Notification.handleActivation`). Never rejects. */
  activate(details: unknown): Promise<void>;
  /** The app is quitting: nothing is shown or sent any more. */
  stop(): void;
}

export function createEscalationNotices(deps: EscalationNoticeDeps): EscalationNotices {
  // Asked for, being looked up or shown: an escalation is notified once, however often the page asks.
  const requested = new Set<string>();
  // Notifications on screen, by escalation: held so they are not collected, and so one click is handled once.
  const live = new Map<string, NoticeLike>();
  // Requests waiting for the next Snapshot read, with what settles each (T057 r1 P1). Nothing is dropped: however many
  // arrive while the backend is read, the next read checks them all, so the backend is read once per batch, never per
  // request, and the page cannot make it read without end.
  let waiting = new Map<string, () => void>();
  let reading = false;
  let stopped = false;

  const bringForward = () => {
    try {
      focusWindow(deps.getWindow());
    } catch {
      /* A window going away: nothing to bring forward. */
    }
  };

  const read = async (): Promise<Snapshot | undefined> => {
    try {
      return await deps.snapshot();
    } catch {
      return undefined;
    }
  };

  /** Tells the page to open the escalation, if the backend has it and the window is (still) there. */
  const deliver = async (escalationId: string): Promise<void> => {
    const snapshot = await read();
    if (stopped || !snapshot?.escalations.some(item => item.id === escalationId)) return;
    const win = deps.getWindow();
    if (win === null || win.isDestroyed()) return;
    try {
      win.webContents.send(ESCALATION_ACTIVATED_CHANNEL, { escalationId });
    } catch {
      /* The page is gone; the window still came forward. */
    }
  };

  /** Shows one escalation as the Snapshot has it; one that is not there or not open is let go, to be asked for again. */
  const present = (escalationId: string, snapshot: Snapshot | undefined): void => {
    try {
      const escalation = snapshot?.escalations.find(item => item.id === escalationId);
      if (stopped || !snapshot || escalation?.state !== 'open') {
        requested.delete(escalationId);
        return;
      }
      // Throws for an ID that cannot be encoded (a lone surrogate); never longer than an activation accepts (r1 P2).
      const launch = launchArgument(escalationId);
      if (launch.length > MAX_LAUNCH) throw new RangeError('launch argument too long');
      const title = snapshot.sessions.find(item => item.id === escalation.fromSessionId)?.title;
      const body = noticeBody(title, escalation.title);
      const notice = deps.createNotification({
        title: NOTICE_TITLE,
        body,
        ...(deps.useToastXml && { toastXml: toastXml(launch, NOTICE_TITLE, body) }),
      });
      const forget = () => {
        if (live.get(escalationId) === notice) live.delete(escalationId);
      };
      notice.on('click', () => {
        // A click the activation callback already handled (the COM path calls it first) is not handled again.
        if (stopped || live.get(escalationId) !== notice) return;
        live.delete(escalationId);
        bringForward();
        void deliver(escalationId);
      });
      notice.on('close', forget);
      // One line each, with no ID and no text of the escalation: Electron's own error text only (T057 live).
      notice.on('show', () => deps.log?.('[notice] shown'));
      notice.on('failed', (_event, error) => {
        forget();
        deps.log?.(`[notice] failed: ${errorText(error)}`);
      });
      live.set(escalationId, notice);
      notice.show();
    } catch (error: unknown) {
      requested.delete(escalationId);
      live.delete(escalationId);
      deps.log?.(`[notice] not shown (${error instanceof Error ? error.name : 'unknown'})`);
    }
  };

  /**
   * Reads the Snapshot for every waiting request, one read at a time. A request that arrives during a read waits for the
   * next one, so it is checked against data at least as new as the request.
   */
  const pump = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      while (waiting.size > 0) {
        const batch = waiting;
        waiting = new Map();
        const snapshot = stopped ? undefined : await read();
        for (const [escalationId, settle] of batch) {
          present(escalationId, snapshot);
          settle();
        }
      }
    } finally {
      reading = false;
    }
  };

  const show = (raw: unknown): Promise<void> => {
    const escalationId = escalationIdOf(raw);
    if (stopped || escalationId === undefined || requested.has(escalationId)) return Promise.resolve();
    // Taken before the wait, so two requests at once show one notification.
    requested.add(escalationId);
    return new Promise<void>((settle) => {
      waiting.set(escalationId, settle);
      void pump();
    });
  };

  const activate = async (details: unknown): Promise<void> => {
    if (stopped) return;
    bringForward();
    const escalationId = activatedEscalationId(details);
    if (escalationId === undefined) return;
    // The instance's own `click`, which may follow, is then left alone.
    live.delete(escalationId);
    await deliver(escalationId);
  };

  return {
    show,
    activate,
    stop: () => {
      stopped = true;
      live.clear();
    },
  };
}
