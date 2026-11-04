// System notification for an escalation that needs the user (U3 Q-15, T055). Shown only when a *new* open escalation
// appears while the window is not in front and the setting is on. The text is plain text: the title and the body are
// handed to the `Notification` API as strings, and the body is cleaned of control characters first.
import { useEffect, useRef, useState } from 'react';
import type { SessionId, Snapshot } from '../../../contracts';
import type { RendererState } from './renderer-store';

export const NOTIFY_KEY = 'awg.notify.v1';
export const NOTIFY_TITLE = '需要你處理';
export const NOTIFY_BODY_LIMIT = 100;

// When saving fails, the last choice made on this page is kept here, so what the checkbox shows is what the notifier does.
let unsaved: boolean | undefined;

/** The setting is on unless the page saved an explicit "off"; a missing key, another value or a failing storage means on. */
export function readNotifyEnabled(): boolean {
  if (unsaved !== undefined) return unsaved;
  try {
    return localStorage.getItem(NOTIFY_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * Saves the setting. If the storage refuses, the old value is removed (a stale "off" must not outlive a choice of "on") and
 * the choice is kept in memory for this page; nothing throws.
 */
export function writeNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? 'on' : 'off');
    unsaved = undefined;
  } catch {
    unsaved = enabled;
    try { localStorage.removeItem(NOTIFY_KEY); } catch { /* Still only in memory. */ }
  }
}

/** For tests: forgets a choice that could not be saved. */
export function forgetUnsavedNotifySetting(): void {
  unsaved = undefined;
}

// Line breaks and tabs become one space; every other control character and the bidi controls are dropped.
const isBreak = (cp: number) => cp === 0x0a || cp === 0x0d || cp === 0x09 || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
const isDropped = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e)
  || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
const clean = (text: string) => Array.from(text).map(letter => {
  const cp = letter.codePointAt(0) ?? 0;
  return isBreak(cp) ? ' ' : isDropped(cp) ? '' : letter;
}).join('').replace(/[ ]{2,}/g, ' ').trim();

/** "<session title>：<escalation title>", cleaned and cut to 100 characters (code points). No `detail`. */
export function notificationBody(sessionTitle: string | undefined, escalationTitle: string): string {
  const title = clean(sessionTitle ?? '');
  const text = title ? `${title}：${clean(escalationTitle)}` : clean(escalationTitle);
  const letters = Array.from(text);
  return letters.length > NOTIFY_BODY_LIMIT ? `${letters.slice(0, NOTIFY_BODY_LIMIT - 1).join('')}…` : text;
}

/** The part of the `Notification` API used (a stand-in in tests). */
export interface NotificationLike {
  onclick: ((event?: unknown) => void) | null;
  close(): void;
}
export interface NotificationApi {
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike;
  readonly permission: string;
}

export interface NotifierOptions {
  store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => Pick<RendererState, 'connection' | 'snapshot'> };
  /** Opens the session and scrolls to the card (the click of a notification). */
  onActivate: (sessionId: SessionId, escalationId: string) => void;
  hasFocus?: () => boolean;
  enabled?: () => boolean;
  notification?: () => NotificationApi | undefined;
  focusWindow?: () => void;
}

const defaultApi = (): NotificationApi | undefined => (typeof Notification === 'undefined' ? undefined : (Notification as unknown as NotificationApi));
const defaultFocusWindow = () => {
  try {
    void window.awg?.focusWindow?.()?.catch(() => undefined);
  } catch {
    /* No bridge, or it failed: the session still opens. */
  }
};

/**
 * Watches the store. A notification needs an escalation that is `open` now and was never seen `open` before, so a repeated
 * event, a decided one and a replayed one are all silent. Whatever is open when the store first has a Snapshot, and when it
 * has one again after loading, an error or a disconnect, only becomes the baseline: better a missed notification than a
 * repeated one. Returns the function that stops watching.
 */
export function startEscalationNotifier(options: NotifierOptions): () => void {
  const { store, onActivate } = options;
  const seen = new Set<string>();
  let needsBaseline = true;
  const evaluate = () => {
    const state = store.getSnapshot();
    const snapshot: Snapshot | null = state.snapshot;
    if (state.connection !== 'ready' || !snapshot) { needsBaseline = true; return; }
    const fresh = snapshot.escalations.filter(item => item.state === 'open' && !seen.has(item.id));
    for (const item of fresh) seen.add(item.id);
    if (needsBaseline) { needsBaseline = false; return; }
    for (const item of fresh) {
      const hasFocus = options.hasFocus ?? (() => document.hasFocus());
      if (hasFocus() || !(options.enabled ?? readNotifyEnabled)()) continue;
      try {
        const api = (options.notification ?? defaultApi)();
        if (!api || api.permission !== 'granted') continue;
        const sessionTitle = snapshot.sessions.find(session => session.id === item.fromSessionId)?.title;
        const shown = new api(NOTIFY_TITLE, { body: notificationBody(sessionTitle, item.title), tag: item.id });
        shown.onclick = () => {
          try { (options.focusWindow ?? defaultFocusWindow)(); } catch { /* The session still opens. */ }
          onActivate(item.fromSessionId, item.id);
          try { shown.close(); } catch { /* Already closed. */ }
        };
      } catch {
        /* A notification that cannot be shown is skipped; the escalation card is still in the app. */
      }
    }
  };
  evaluate();
  return store.subscribe(evaluate);
}

/** Starts the notifier while the connected shell is mounted. Without a store (the demo) nothing is watched. */
export function useEscalationNotice(store: NotifierOptions['store'] | undefined, onActivate: NotifierOptions['onActivate']): void {
  const activate = useRef(onActivate);
  useEffect(() => { activate.current = onActivate; });
  useEffect(() => {
    if (!store) return undefined;
    return startEscalationNotifier({ store, onActivate: (sessionId, escalationId) => activate.current(sessionId, escalationId) });
  }, [store]);
}

/** Settings → General → Appearance: the checkbox for these notifications. Not a backend setting, so read-only mode does not matter. */
export function NotifySetting() {
  const [enabled, setEnabled] = useState(readNotifyEnabled);
  return <div className="v4-field"><label className="check-label">
    <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); writeNotifyEnabled(event.target.checked); }} />
    有需要我處理的事時通知我
  </label><p className="v4-muted v4-field-hint">視窗不在前景時，有新的待處理升級就跳出系統通知；點通知會回到這個 App 並打開那個 session。</p></div>;
}
