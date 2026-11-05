// System notification for an escalation that needs the user (U3 Q-15, T055, T057). The page decides when: a *new* open
// escalation appears while the window is not in front and the setting is on. Then it asks the main process, by the
// escalation's ID alone, to show it; the main process looks the escalation up and writes the text. A click (from the
// banner or the Windows Action Center) comes back from the main process as the ID of the escalation to open.
import { useEffect, useRef, useState } from 'react';
import type { SessionId, Snapshot } from '../../../contracts';
import type { AwgBridge } from '../../preload/bridge-types';
import type { RendererState } from './renderer-store';

export const NOTIFY_KEY = 'awg.notify.v1';

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

/** The part of the bridge the notifier uses (T057). */
export type NoticeBridge = Pick<AwgBridge, 'showEscalationNotice' | 'onEscalationActivated'>;

export interface NotifierOptions {
  store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => Pick<RendererState, 'connection' | 'snapshot'> };
  /** Opens the session and scrolls to the card (the click of a notification). */
  onActivate: (sessionId: SessionId, escalationId: string) => void;
  hasFocus?: () => boolean;
  enabled?: () => boolean;
  /** The preload bridge (`window.awg` unless given). */
  bridge?: () => NoticeBridge | undefined;
}

const defaultBridge = (): NoticeBridge | undefined => (typeof window === 'undefined' ? undefined : window.awg);

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
  // Once the notifier is stopped (the shell is gone) a click must do nothing (T055 r2 P2).
  let stopped = false;
  const bridge = (options.bridge ?? defaultBridge)();
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
        // The ID alone: the main process checks the escalation and writes the text itself.
        void bridge?.showEscalationNotice?.(item.id)?.catch(() => undefined);
      } catch {
        /* No notification then; the escalation card is still in the app. */
      }
    }
  };
  // A clicked notification: the main process brought the window forward and names the escalation to open. The page
  // finds its session in its own data; an escalation it does not know (yet) opens nothing.
  const activated = (escalationId: string) => {
    if (stopped) return;
    const item = store.getSnapshot().snapshot?.escalations.find(escalation => escalation.id === escalationId);
    if (item) onActivate(item.fromSessionId, item.id);
  };
  let stopActivated: (() => void) | undefined;
  try {
    stopActivated = bridge?.onEscalationActivated?.(activated);
  } catch {
    /* An older preload: clicks bring the window forward only. */
  }
  evaluate();
  const unsubscribe = store.subscribe(evaluate);
  return () => {
    stopped = true;
    unsubscribe();
    try { stopActivated?.(); } catch { /* Already gone. */ }
  };
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
  return <div className="v4-field"><label className="v4-check">
    <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); writeNotifyEnabled(event.target.checked); }} />
    有需要我處理的事時通知我
  </label><p className="v4-muted v4-field-hint">視窗不在前景時，有新的待處理升級就跳出系統通知；點通知會回到這個 App 並打開那個 session。</p></div>;
}
