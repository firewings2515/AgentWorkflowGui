// @vitest-environment jsdom
// T055 (U3 Q-15), T057: when the page asks for the system notification of an escalation, its setting, and what a click
// (reported by the main process) opens. The bridge is a stand-in: no system notification is shown.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION } from '../../../contracts';
import type { Escalation, EventEnvelope, Snapshot } from '../../../contracts';
import { fixtureReadOnlySnapshot, fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import {
  forgetUnsavedNotifySetting, type NotifierOptions, NOTIFY_KEY, readNotifyEnabled, startEscalationNotifier, writeNotifyEnabled,
} from './escalation-notify';
import { fakeBridge } from './ipc-test-helpers';
import { createRendererStore, rendererStore } from './renderer-store';

/** The two bridge functions of T057: what the page asked for, and a click the main process reports. */
function noticeBridge() {
  const asked: unknown[][] = [];
  const listeners = new Set<(escalationId: string) => void>();
  const bridge = {
    showEscalationNotice: vi.fn((...args: unknown[]) => { asked.push(args); return Promise.resolve(); }),
    onEscalationActivated: vi.fn((listener: (escalationId: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  return { bridge, asked, ids: () => asked.map(args => args[0]), activate: (escalationId: string) => listeners.forEach(listener => listener(escalationId)), listeners };
}

const SESSION = fixtureSnapshot.sessions.find(item => item.id === 's-research')!;
const base = fixtureSnapshot.escalations.find(item => item.state === 'open')!;
const open = (id: string, over: Partial<Escalation> = {}): Escalation => ({ ...base, id, fromSessionId: SESSION.id, kind: 'confirmation', title: `確認 ${id}`, detail: `詳細 ${id}`,
  ref: undefined, rule: undefined, createdAt: '2026-10-24T12:00:00+08:00', ...over } as Escalation);
const resolved = (item: Escalation): Escalation => ({ ...item, state: 'resolved', resolvedBy: 'system', resolvedAt: '2026-10-24T12:30:00+08:00' });
const update = (seq: number, escalation: Escalation): EventEnvelope => ({ schemaVersion: CONTRACTS_VERSION, seq, event: { type: 'escalation.updated', escalation } });
let next = fixtureSnapshot.seq;
const seq = () => ++next;

let focused: boolean;
let notices: ReturnType<typeof noticeBridge>;
beforeEach(() => {
  notices = noticeBridge();
  focused = false; next = fixtureSnapshot.seq;
  localStorage.clear(); forgetUnsavedNotifySetting();
});
afterEach(() => { cleanup(); delete window.awg; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rig(snapshot: Snapshot = fixtureSnapshot, over: { [K in keyof NotifierOptions]?: NotifierOptions[K] | undefined } = {}) {
  const fake = fakeBridge(snapshot);
  const store = createRendererStore(fake.bridge);
  await store.start();
  const onActivate = vi.fn();
  const stop = startEscalationNotifier({ store, onActivate, hasFocus: () => focused, bridge: () => notices.bridge, ...over } as NotifierOptions);
  const emit = (escalation: Escalation) => act(async () => { fake.emit(update(seq(), escalation)); await Promise.resolve(); });
  return { fake, store, onActivate, stop, emit };
}

describe('T055 when a notification is shown', () => {
  it('a new open escalation is asked for once, by its ID and nothing else (T057: the main process writes the text)', async () => {
    const { emit } = await rig();
    await emit(open('esc-new'));
    expect(notices.asked).toEqual([['esc-new']]);
  });

  it('the same escalation arriving again is silent, also after its details changed', async () => {
    const { emit } = await rig();
    await emit(open('esc-new'));
    await emit(open('esc-new'));
    await emit(open('esc-new', { title: '改過的標題' }));
    expect(notices.asked).toHaveLength(1);
  });

  it('a decided escalation is silent, whether it was seen open before or not', async () => {
    const { emit } = await rig();
    await emit(resolved(open('esc-never-open')));
    await emit(open('esc-seen'));
    await emit(resolved(open('esc-seen')));
    await emit({ ...open('esc-declined'), state: 'declined', resolvedBy: 'user', resolvedAt: '2026-10-24T12:30:00+08:00' });
    expect(notices.ids()).toEqual(['esc-seen']);
  });

  it('what the first Snapshot already holds is silent, also when the same escalation is sent again', async () => {
    const { emit } = await rig();
    const already = fixtureSnapshot.escalations.filter(item => item.state === 'open');
    expect(already.length).toBeGreaterThan(1);
    for (const item of already) await emit(item);
    expect(notices.asked).toHaveLength(0);
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
    expect(notices.asked).toHaveLength(0);
    await emit(open('esc-after'));
    expect(notices.ids()).toEqual(['esc-after']);
    // The one decided during the reconnect stays silent, and so does the one that came with the Snapshot.
    await emit(resolved(earlier));
    await emit(open('esc-while-away'));
    expect(notices.asked).toHaveLength(1);
  });

  it('an event of an older sequence is not applied, so it is not notified', async () => {
    const { fake } = await rig();
    await act(async () => { fake.emit(update(fixtureSnapshot.seq, open('esc-old'))); await Promise.resolve(); });
    expect(notices.asked).toHaveLength(0);
  });

  it('the window being in front is silent', async () => {
    focused = true;
    const { emit } = await rig();
    await emit(open('esc-front'));
    expect(notices.asked).toHaveLength(0);
  });

  it('the setting off is silent; a missing key, an unknown value or a failing storage means on', async () => {
    const { emit } = await rig();
    localStorage.setItem(NOTIFY_KEY, 'off');
    await emit(open('esc-1-off'));
    expect(notices.asked).toHaveLength(0);
    localStorage.setItem(NOTIFY_KEY, 'on');
    await emit(open('esc-2-on'));
    localStorage.setItem(NOTIFY_KEY, 'maybe');
    await emit(open('esc-3-unknown'));
    localStorage.removeItem(NOTIFY_KEY);
    await emit(open('esc-4-missing'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    await emit(open('esc-5-failing'));
    expect(notices.ids()).toEqual(['esc-2-on', 'esc-3-unknown', 'esc-4-missing', 'esc-5-failing']);
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
    expect(notices.asked).toHaveLength(1);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('a preload without the call, one that rejects and one that throws are skipped; later ones still work (T057)', async () => {
    const { emit } = await rig(fixtureSnapshot, { bridge: () => undefined });
    await emit(open('esc-no-bridge'));
    next = fixtureSnapshot.seq;
    const rejecting = await rig(fixtureSnapshot, { bridge: () => ({ showEscalationNotice: () => Promise.reject(new Error('refused')) }) });
    await rejecting.emit(open('esc-rejects'));
    next = fixtureSnapshot.seq;
    const throwing = await rig(fixtureSnapshot, { bridge: () => ({ showEscalationNotice: () => { throw new Error('gone'); }, onEscalationActivated: () => { throw new Error('gone'); } }) });
    await throwing.emit(open('esc-throws'));
    expect(notices.asked).toHaveLength(0);
    next = fixtureSnapshot.seq;
    const fine = await rig();
    await fine.emit(open('esc-fine'));
    expect(notices.ids()).toEqual(['esc-fine']);
    await Promise.resolve();
  });

  it('stops when told to', async () => {
    const { emit, stop } = await rig();
    stop();
    await emit(open('esc-stopped'));
    expect(notices.asked).toHaveLength(0);
  });

  it('a Snapshot that is loading or failed starts a new baseline', async () => {
    const { fake, store, emit } = await rig();
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await store.reconnect(); });
    expect(store.getSnapshot().connection).toBe('error');
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 5, escalations: [...fixtureSnapshot.escalations, open('esc-during-error')] };
    next = fixtureSnapshot.seq + 5;
    await act(async () => { await store.reconnect(); });
    expect(notices.asked).toHaveLength(0);
    await emit(open('esc-later'));
    expect(notices.asked).toHaveLength(1);
  });
});

describe('T055 more than one', () => {
  it('every new escalation of its own gets its notification', async () => {
    const { emit } = await rig();
    await emit(open('esc-a'));
    await emit(open('esc-b'));
    expect(notices.ids()).toEqual(['esc-a', 'esc-b']);
  });
});

describe('T057 a clicked notification, reported by the main process', () => {
  it('opens the session of the escalation the main process names', async () => {
    const { emit, onActivate } = await rig();
    await emit(open('esc-click'));
    notices.activate('esc-click');
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(SESSION.id, 'esc-click');
  });

  it('opens an escalation that was never notified, or is decided, by its own data; an unknown one opens nothing', async () => {
    const { emit, onActivate } = await rig();
    const earlier = fixtureSnapshot.escalations.find(item => item.state === 'open')!;
    notices.activate(earlier.id);
    await emit(resolved(open('esc-done')));
    notices.activate('esc-done');
    notices.activate('esc-unknown');
    expect(onActivate.mock.calls).toEqual([[earlier.fromSessionId, earlier.id], [SESSION.id, 'esc-done']]);
  });

  it('after stop() a click does nothing and the subscription is gone', async () => {
    const { emit, onActivate, stop } = await rig();
    await emit(open('esc-late'));
    expect(notices.listeners.size).toBe(1);
    stop();
    expect(notices.listeners.size).toBe(0);
    notices.activate('esc-late');
    expect(onActivate).not.toHaveBeenCalled();
  });
});

// The whole page: the real store, shell and conversation, with a fake bridge and a fake Notification.
describe('T055 in the app', () => {
  let fake: ReturnType<typeof fakeBridge>;
  let scrolled: Element[];
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
    fake = fakeBridge(fixtureSnapshot);
  });
  afterEach(() => { rendererStore(fake.bridge).dispose(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
  const mount = async (route: string, bridge = fake) => {
    window.awg = { ...bridge.bridge, ...notices.bridge };
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
    expect(notices.asked).toHaveLength(1);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await act(async () => { notices.activate('esc-app'); await Promise.resolve(); });
    await screen.findByRole('region', { name: `對話：${SESSION.title}` });
    await waitFor(() => expect(scrolled.some(item => item instanceof HTMLElement && item.dataset['escalationId'] === 'esc-app')).toBe(true));
    expect(window.location.hash).toBe(`#/sessions/${SESSION.id}`);
  });

  it('a click from the settings page opens the session too', async () => {
    await mount('/#/settings');
    await emitInApp(open('esc-from-settings'));
    await act(async () => { notices.activate('esc-from-settings'); await Promise.resolve(); });
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
    await act(async () => { notices.activate('esc-split'); await Promise.resolve(); });
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
    expect(notices.ids()).toEqual(['esc-on-again']);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await emitInApp(open('esc-off-again'));
    expect(notices.asked).toHaveLength(1);
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
    await act(async () => { notices.activate('esc-first'); await Promise.resolve(); });
    frame();
    expect(searches()).toBe(1);
    frame();
    expect(searches()).toBe(2);
    await act(async () => { notices.activate('esc-second'); await Promise.resolve(); });
    const before = searches();
    frame();
    expect(searches()).toBe(before + 1);
    view.unmount();
    frame();
    frame();
    expect(searches()).toBe(before + 1);
    expect(scrolled).toHaveLength(0);
  });

  it('a notification clicked after the shell is gone does nothing: no open, no search, no frame (r2 P2, T057)', async () => {
    const view = await mount('/#/sessions/s-plan-notes');
    await emitInApp(open('esc-late'));
    await emitInApp(resolved(open('esc-late')));
    expect(notices.asked).toHaveLength(1);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const lookups = vi.spyOn(document, 'querySelectorAll');
    const kept = [...notices.listeners];
    view.unmount();
    // The subscription is gone, and a listener kept from before is dead too.
    expect(notices.listeners.size).toBe(0);
    const hash = window.location.hash;
    kept.forEach(listener => listener('esc-late'));
    expect(frames).toHaveLength(0);
    expect(lookups.mock.calls.filter(call => call[0] === '[data-escalation-id]')).toHaveLength(0);
    expect(window.location.hash).toBe(hash);
  });

  it('with the setting off in the settings page, no notification is shown', async () => {
    await mount('/#/settings');
    fireEvent.click(screen.getByRole('checkbox', { name: '有需要我處理的事時通知我' }));
    await emitInApp(open('esc-off'));
    expect(notices.asked).toHaveLength(0);
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

// T042 style: the page hands over an ID and nothing else, and a click opens a card whose text stays text.
describe('T055 injection', () => {
  const PAYLOAD = '<img src=x onerror="window.__awgPwned=1"><script>window.__awgPwned=2</script><a href="javascript:window.__awgPwned=3">x</a><iframe src="file:///C:/Windows/win.ini"></iframe>';

  it('only the escalation ID crosses, whatever the title and the session say (T057)', async () => {
    const poisoned = structuredClone(fixtureSnapshot);
    poisoned.sessions = poisoned.sessions.map(item => item.id === SESSION.id ? { ...item, title: `標題 ${PAYLOAD}` } : item);
    const { emit } = await rig(poisoned);
    await emit(open('esc-xss', { title: PAYLOAD, detail: PAYLOAD }));
    expect(notices.asked).toEqual([['esc-xss']]);
  });

  it('in the page: the click and the opened card create no element and run nothing', async () => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const poisoned = structuredClone(fixtureSnapshot);
    const fake = fakeBridge(poisoned);
    window.awg = { ...fake.bridge, ...notices.bridge };
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    delete (window as { __awgPwned?: number }).__awgPwned;
    const view = render(<App />);
    await screen.findAllByText('IPC 已連線');
    const id = 'esc-<img src=x onerror="window.__awgPwned=4">';
    await act(async () => { fake.emit(update(fixtureSnapshot.seq + 1, open(id, { title: PAYLOAD }))); await Promise.resolve(); });
    expect(notices.asked).toEqual([[id]]);
    await act(async () => { notices.activate(id); await Promise.resolve(); });
    await screen.findAllByText(/<img src=x onerror=/);
    expect(view.container.querySelector('img[src="x"]')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect((window as { __awgPwned?: number }).__awgPwned).toBeUndefined();
    rendererStore(fake.bridge).dispose();
  });
});
