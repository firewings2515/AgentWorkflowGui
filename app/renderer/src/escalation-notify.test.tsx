// @vitest-environment jsdom
// T055 (U3 Q-15): the system notification for an escalation that needs the user, its setting, and what a click does.
// `Notification` is a stand-in: no real system notification is shown.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION } from '../../../contracts';
import type { Escalation, EventEnvelope, Snapshot } from '../../../contracts';
import { fixtureReadOnlySnapshot, fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import {
  forgetUnsavedNotifySetting, type NotificationApi, type NotifierOptions, NOTIFY_BODY_LIMIT, NOTIFY_KEY, NOTIFY_TITLE, notificationBody, readNotifyEnabled, startEscalationNotifier, writeNotifyEnabled,
} from './escalation-notify';
import { fakeBridge } from './ipc-test-helpers';
import { createRendererStore, rendererStore } from './renderer-store';

class FakeNotification {
  static shown: FakeNotification[] = [];
  static permission = 'granted';
  static failing = false;
  onclick: ((event?: unknown) => void) | null = null;
  close = vi.fn();
  constructor(readonly title: string, readonly options: { body?: string; tag?: string } = {}) {
    if (FakeNotification.failing) throw new Error('no notification');
    FakeNotification.shown.push(this);
  }
}
const api = FakeNotification as unknown as NotificationApi;

const SESSION = fixtureSnapshot.sessions.find(item => item.id === 's-research')!;
const base = fixtureSnapshot.escalations.find(item => item.state === 'open')!;
const open = (id: string, over: Partial<Escalation> = {}): Escalation => ({ ...base, id, fromSessionId: SESSION.id, kind: 'confirmation', title: `確認 ${id}`, detail: `詳細 ${id}`,
  ref: undefined, rule: undefined, createdAt: '2026-10-24T12:00:00+08:00', ...over } as Escalation);
const resolved = (item: Escalation): Escalation => ({ ...item, state: 'resolved', resolvedBy: 'system', resolvedAt: '2026-10-24T12:30:00+08:00' });
const update = (seq: number, escalation: Escalation): EventEnvelope => ({ schemaVersion: CONTRACTS_VERSION, seq, event: { type: 'escalation.updated', escalation } });
let next = fixtureSnapshot.seq;
const seq = () => ++next;

let focused: boolean;
beforeEach(() => {
  FakeNotification.shown = []; FakeNotification.permission = 'granted'; FakeNotification.failing = false;
  focused = false; next = fixtureSnapshot.seq;
  localStorage.clear(); forgetUnsavedNotifySetting();
});
afterEach(() => { cleanup(); delete window.awg; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rig(snapshot: Snapshot = fixtureSnapshot, over: { [K in keyof NotifierOptions]?: NotifierOptions[K] | undefined } = {}) {
  const fake = fakeBridge(snapshot);
  const store = createRendererStore(fake.bridge);
  await store.start();
  const onActivate = vi.fn();
  const focusWindow = vi.fn();
  const stop = startEscalationNotifier({ store, onActivate, focusWindow, hasFocus: () => focused, notification: () => api, ...over } as NotifierOptions);
  const emit = (escalation: Escalation) => act(async () => { fake.emit(update(seq(), escalation)); await Promise.resolve(); });
  return { fake, store, onActivate, focusWindow, stop, emit };
}

describe('T055 when a notification is shown', () => {
  it('a new open escalation shows one: the fixed title, "session title：escalation title", the escalation ID as its tag', async () => {
    const { emit } = await rig();
    await emit(open('esc-new'));
    expect(FakeNotification.shown).toHaveLength(1);
    const [shown] = FakeNotification.shown;
    expect(shown!.title).toBe(NOTIFY_TITLE);
    expect(shown!.title).toBe('需要你處理');
    expect(shown!.options).toEqual({ body: `${SESSION.title}：確認 esc-new`, tag: 'esc-new' });
  });

  it('the same escalation arriving again is silent, also after its details changed', async () => {
    const { emit } = await rig();
    await emit(open('esc-new'));
    await emit(open('esc-new'));
    await emit(open('esc-new', { title: '改過的標題' }));
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('a decided escalation is silent, whether it was seen open before or not', async () => {
    const { emit } = await rig();
    await emit(resolved(open('esc-never-open')));
    await emit(open('esc-seen'));
    await emit(resolved(open('esc-seen')));
    await emit({ ...open('esc-declined'), state: 'declined', resolvedBy: 'user', resolvedAt: '2026-10-24T12:30:00+08:00' });
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-seen']);
  });

  it('what the first Snapshot already holds is silent, also when the same escalation is sent again', async () => {
    const { emit } = await rig();
    const already = fixtureSnapshot.escalations.filter(item => item.state === 'open');
    expect(already.length).toBeGreaterThan(1);
    for (const item of already) await emit(item);
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('a reconnect only sets a new baseline: what the new Snapshot shows is silent, what comes after it is not', async () => {
    const { fake, store, emit } = await rig();
    const earlier = fixtureSnapshot.escalations.find(item => item.state === 'open')!;
    // While the connection was reloading, `earlier` was decided and another escalation opened (all in the same Snapshot).
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 10,
      escalations: [...fixtureSnapshot.escalations.map(item => item.id === earlier.id ? resolved(item) : item), open('esc-while-away')] };
    next = fixtureSnapshot.seq + 10;
    await act(async () => { await store.reconnect(); });
    expect(store.getSnapshot().snapshot!.escalations.some(item => item.id === 'esc-while-away')).toBe(true);
    expect(FakeNotification.shown).toHaveLength(0);
    await emit(open('esc-after'));
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-after']);
    // The one decided during the reconnect stays silent, and so does the one that came with the Snapshot.
    await emit(resolved(earlier));
    await emit(open('esc-while-away'));
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('an event of an older sequence is not applied, so it is not notified', async () => {
    const { fake } = await rig();
    await act(async () => { fake.emit(update(fixtureSnapshot.seq, open('esc-old'))); await Promise.resolve(); });
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('the window being in front is silent', async () => {
    focused = true;
    const { emit } = await rig();
    await emit(open('esc-front'));
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('the setting off is silent; a missing key, an unknown value or a failing storage means on', async () => {
    const { emit } = await rig();
    localStorage.setItem(NOTIFY_KEY, 'off');
    await emit(open('esc-1-off'));
    expect(FakeNotification.shown).toHaveLength(0);
    localStorage.setItem(NOTIFY_KEY, 'on');
    await emit(open('esc-2-on'));
    localStorage.setItem(NOTIFY_KEY, 'maybe');
    await emit(open('esc-3-unknown'));
    localStorage.removeItem(NOTIFY_KEY);
    await emit(open('esc-4-missing'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    await emit(open('esc-5-failing'));
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-2-on', 'esc-3-unknown', 'esc-4-missing', 'esc-5-failing']);
  });

  it('read and write of the setting never throw', () => {
    expect(readNotifyEnabled()).toBe(true);
    writeNotifyEnabled(false);
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('off');
    expect(readNotifyEnabled()).toBe(false);
    writeNotifyEnabled(true);
    expect(readNotifyEnabled()).toBe(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => writeNotifyEnabled(false)).not.toThrow();
  });

  it('a choice that cannot be saved still decides (r1 P2-1): the old value is removed, and the choice holds in memory', () => {
    localStorage.setItem(NOTIFY_KEY, 'off');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    writeNotifyEnabled(true);
    expect(localStorage.getItem(NOTIFY_KEY)).toBeNull();
    expect(readNotifyEnabled()).toBe(true);
    writeNotifyEnabled(false);
    expect(readNotifyEnabled()).toBe(false);
    // Even when the old value cannot be removed either.
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => writeNotifyEnabled(true)).not.toThrow();
    expect(readNotifyEnabled()).toBe(true);
  });

  it('a choice saved after one that could not be is read from the storage again', () => {
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    writeNotifyEnabled(false);
    failing.mockRestore();
    writeNotifyEnabled(true);
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('on');
    localStorage.setItem(NOTIFY_KEY, 'off');
    expect(readNotifyEnabled()).toBe(false);
  });

  it('read-only data still notifies, and nothing is sent to the backend', async () => {
    const session = fixtureReadOnlySnapshot.sessions[0]!;
    const { fake, emit } = await rig(fixtureReadOnlySnapshot);
    await emit(open('esc-ro', { fromSessionId: session.id }));
    expect(FakeNotification.shown).toHaveLength(1);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('one that cannot be shown (no API, no permission, a failing constructor) is skipped and later ones still work', async () => {
    const holder: { available?: NotificationApi } = {};
    const { emit } = await rig(fixtureSnapshot, { notification: () => holder.available });
    await emit(open('esc-no-api'));
    holder.available = api;
    FakeNotification.permission = 'denied';
    await emit(open('esc-denied'));
    FakeNotification.permission = 'granted';
    FakeNotification.failing = true;
    await emit(open('esc-throws'));
    FakeNotification.failing = false;
    await emit(open('esc-fine'));
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-fine']);
  });

  it('stops when told to', async () => {
    const { emit, stop } = await rig();
    stop();
    await emit(open('esc-stopped'));
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('a Snapshot that is loading or failed starts a new baseline', async () => {
    const { fake, store, emit } = await rig();
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await store.reconnect(); });
    expect(store.getSnapshot().connection).toBe('error');
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 5, escalations: [...fixtureSnapshot.escalations, open('esc-during-error')] };
    next = fixtureSnapshot.seq + 5;
    await act(async () => { await store.reconnect(); });
    expect(FakeNotification.shown).toHaveLength(0);
    await emit(open('esc-later'));
    expect(FakeNotification.shown).toHaveLength(1);
  });
});

describe('T055 the text of a notification', () => {
  it('is cut to 100 characters by code points, with … as the last one', () => {
    const long = notificationBody('標題', '很'.repeat(300));
    expect(Array.from(long)).toHaveLength(NOTIFY_BODY_LIMIT);
    expect(long.endsWith('…')).toBe(true);
    const emoji = notificationBody(undefined, '😀'.repeat(150));
    expect(Array.from(emoji)).toHaveLength(NOTIFY_BODY_LIMIT);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji)).toBe(false);
    expect(notificationBody('a', 'b')).toBe('a：b');
  });

  it('has no detail, and only the escalation title when its session is unknown', async () => {
    const { emit } = await rig();
    await emit(open('esc-detail', { detail: 'SECRET-DETAIL token sk-live-1234', fromSessionId: 'no-such-session' as Escalation['fromSessionId'] }));
    expect(FakeNotification.shown[0]!.options.body).toBe('確認 esc-detail');
    expect(JSON.stringify(FakeNotification.shown[0])).not.toContain('SECRET-DETAIL');
  });

  it('every new escalation of its own gets its notification', async () => {
    const { emit } = await rig();
    await emit(open('esc-a'));
    await emit(open('esc-b'));
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-a', 'esc-b']);
  });
});

describe('T055 clicking a notification', () => {
  it('brings the window forward with no argument, opens the session of the escalation and closes the notification', async () => {
    const { emit, onActivate, focusWindow } = await rig();
    await emit(open('esc-click'));
    FakeNotification.shown[0]!.onclick?.({ detail: 'ignored' });
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(focusWindow.mock.calls[0]).toEqual([]);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(SESSION.id, 'esc-click');
    expect(FakeNotification.shown[0]!.close).toHaveBeenCalled();
  });

  it('opens the session even when bringing the window forward fails', async () => {
    const { emit, onActivate } = await rig(fixtureSnapshot, { focusWindow: () => { throw new Error('gone'); } });
    await emit(open('esc-click'));
    FakeNotification.shown[0]!.onclick?.();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('works with a preload that has no focusWindow, and with one that rejects', async () => {
    const { fake, emit, onActivate } = await rig(fixtureSnapshot, { focusWindow: undefined });
    window.awg = fake.bridge;
    await emit(open('esc-first'));
    FakeNotification.shown[0]!.onclick?.();
    const focusWindow = vi.fn(() => Promise.reject(new Error('refused')));
    window.awg = { ...fake.bridge, focusWindow };
    await emit(open('esc-second'));
    FakeNotification.shown[1]!.onclick?.();
    expect(focusWindow).toHaveBeenCalledWith();
    expect(onActivate).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });
});

// The whole page: the real store, shell and conversation, with a fake bridge and a fake Notification.
describe('T055 in the app', () => {
  let fake: ReturnType<typeof fakeBridge>;
  let focusWindow: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let scrolled: Element[];
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
    focusWindow = vi.fn(() => Promise.resolve());
    fake = fakeBridge(fixtureSnapshot);
  });
  afterEach(() => { rendererStore(fake.bridge).dispose(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
  const mount = async (route: string, bridge = fake) => {
    window.awg = { ...bridge.bridge, focusWindow };
    window.history.replaceState(null, '', route);
    const view = render(<App />);
    await screen.findAllByText('IPC 已連線');
    return view;
  };
  const emitInApp = (escalation: Escalation) => act(async () => { fake.emit(update(seq(), escalation)); await Promise.resolve(); });

  it('a click opens the session and scrolls to the card of the escalation', async () => {
    await mount('/#/sessions/s-plan-notes');
    expect(screen.getByRole('region', { name: `對話：規劃想法` })).toBeTruthy();
    await emitInApp(open('esc-app'));
    expect(FakeNotification.shown).toHaveLength(1);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await act(async () => { FakeNotification.shown[0]!.onclick?.(); await Promise.resolve(); });
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(focusWindow.mock.calls[0]).toEqual([]);
    await screen.findByRole('region', { name: `對話：${SESSION.title}` });
    await waitFor(() => expect(scrolled.some(item => item instanceof HTMLElement && item.dataset['escalationId'] === 'esc-app')).toBe(true));
    expect(window.location.hash).toBe(`#/sessions/${SESSION.id}`);
  });

  it('a click from the settings page opens the session too', async () => {
    await mount('/#/settings');
    await emitInApp(open('esc-from-settings'));
    await act(async () => { FakeNotification.shown[0]!.onclick?.(); await Promise.resolve(); });
    await screen.findByRole('region', { name: `對話：${SESSION.title}` });
  });

  it('a session that is already in a pane is selected there, and no pane is added', async () => {
    await mount('/#/sessions/s-plan-notes');
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: SESSION.title } });
    const result = within(screen.getByRole('region', { name: '搜尋結果' })).getAllByRole('button')[0]!;
    fireEvent.contextMenu(result);
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    fireEvent.change(search, { target: { value: '' } });
    const panes = () => Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'));
    await waitFor(() => expect(panes()).toHaveLength(2));
    const planPane = panes().find(item => item.getAttribute('aria-label') === '對話：規劃想法')!;
    fireEvent.pointerDown(planPane);
    await waitFor(() => expect(planPane.classList.contains('v4-pane-active')).toBe(true));
    await emitInApp(open('esc-split'));
    await act(async () => { FakeNotification.shown[0]!.onclick?.(); await Promise.resolve(); });
    await waitFor(() => expect(panes().find(item => item.getAttribute('aria-label') === `對話：${SESSION.title}`)!.classList.contains('v4-pane-active')).toBe(true));
    expect(panes()).toHaveLength(2);
  });

  it('the settings page has the checkbox: on by default, saved when changed, kept after a remount, also in read-only mode', async () => {
    const view = await mount('/#/settings');
    const box = () => screen.getByRole<HTMLInputElement>('checkbox', { name: '有需要我處理的事時通知我' });
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('off');
    view.unmount();
    rendererStore(fake.bridge).dispose();
    await mount('/#/settings');
    expect(box().checked).toBe(false);
    fireEvent.click(box());
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('on');
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('"off" saved earlier, then a storage that refuses: turning it on notifies, turning it off again does not (r1 P2-1)', async () => {
    localStorage.setItem(NOTIFY_KEY, 'off');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await mount('/#/settings');
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: '有需要我處理的事時通知我' });
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    await emitInApp(open('esc-on-again'));
    expect(FakeNotification.shown.map(item => item.options.tag)).toEqual(['esc-on-again']);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await emitInApp(open('esc-off-again'));
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('the search for the card is replaced by a newer click and ends when the shell goes away (r1 P2-2)', async () => {
    const view = await mount('/#/sessions/s-plan-notes');
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle); });
    const lookups = vi.spyOn(document, 'querySelectorAll');
    const searches = () => lookups.mock.calls.filter(call => call[0] === '[data-escalation-id]').length;
    const frame = () => { const due = [...frames.values()]; frames.clear(); act(() => due.forEach(callback => callback(0))); };
    // Both escalations are decided before their notifications are clicked, so no card is ever found.
    for (const name of ['esc-first', 'esc-second']) {
      await emitInApp(open(name));
      await emitInApp(resolved(open(name)));
    }
    await act(async () => { FakeNotification.shown[0]!.onclick?.(); await Promise.resolve(); });
    frame();
    expect(searches()).toBe(1);
    frame();
    expect(searches()).toBe(2);
    await act(async () => { FakeNotification.shown[1]!.onclick?.(); await Promise.resolve(); });
    const before = searches();
    frame();
    expect(searches()).toBe(before + 1);
    view.unmount();
    frame();
    frame();
    expect(searches()).toBe(before + 1);
    expect(scrolled).toHaveLength(0);
  });

  it('with the setting off in the settings page, no notification is shown', async () => {
    await mount('/#/settings');
    fireEvent.click(screen.getByRole('checkbox', { name: '有需要我處理的事時通知我' }));
    await emitInApp(open('esc-off'));
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('the checkbox works when the storage fails, and in read-only mode', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const readOnly = fakeBridge(fixtureReadOnlySnapshot);
    await mount('/#/settings', readOnly);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: '有需要我處理的事時通知我' });
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(readOnly.bridge.send).not.toHaveBeenCalled();
    rendererStore(readOnly.bridge).dispose();
  });
});

// T042 style: what the notification shows is text, and nothing runs.
describe('T055 injection', () => {
  const PAYLOAD = '<img src=x onerror="window.__awgPwned=1"><script>window.__awgPwned=2</script><a href="javascript:window.__awgPwned=3">x</a><iframe src="file:///C:/Windows/win.ini"></iframe>';
  const CONTROLS = '\u0000\u0007\u001b[31m\u202e\u2066\u009b\u007f';

  it('the body keeps HTML as it is, as text, and has no control characters or line breaks', async () => {
    const poisoned = structuredClone(fixtureSnapshot);
    poisoned.sessions = poisoned.sessions.map(item => item.id === SESSION.id ? { ...item, title: `標題${CONTROLS}\n${PAYLOAD}` } : item);
    const { emit } = await rig(poisoned);
    await emit(open('esc-xss', { title: `${PAYLOAD}\r\n第二行${CONTROLS}` }));
    const body = FakeNotification.shown[0]!.options.body!;
    expect(body).toContain('<img src=x onerror=');
    expect(body).toContain('<script>');
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(Array.from(body).length).toBeLessThanOrEqual(NOTIFY_BODY_LIMIT);
    expect(FakeNotification.shown[0]!.title).toBe(NOTIFY_TITLE);
    expect(Object.keys(FakeNotification.shown[0]!.options).sort()).toEqual(['body', 'tag']);
  });

  it('in the page: the notification, the click and the opened card create no element and run nothing', async () => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const poisoned = structuredClone(fixtureSnapshot);
    const fake = fakeBridge(poisoned);
    window.awg = { ...fake.bridge, focusWindow: () => Promise.resolve() };
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    delete (window as { __awgPwned?: number }).__awgPwned;
    const view = render(<App />);
    await screen.findAllByText('IPC 已連線');
    await act(async () => { fake.emit(update(fixtureSnapshot.seq + 1, open('esc-page', { title: `${PAYLOAD}${CONTROLS}` }))); await Promise.resolve(); });
    expect(FakeNotification.shown[0]!.options.body).toContain('<img src=x onerror=');
    await act(async () => { FakeNotification.shown[0]!.onclick?.(); await Promise.resolve(); });
    await screen.findAllByText(/<img src=x onerror=/);
    expect(view.container.querySelector('img[src="x"]')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect((window as { __awgPwned?: number }).__awgPwned).toBeUndefined();
    rendererStore(fake.bridge).dispose();
  });
});
