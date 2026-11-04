// @vitest-environment jsdom
// T057: the main process shows the notification of an escalation (named by the page by its ID alone) and handles its
// click, from the banner (the instance's `click`) or from the Windows Action Center (`Notification.handleActivation`).
// `Notification` and the window are stand-ins; no system notification is shown and nothing is written to Windows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Escalation, Snapshot } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { ESCALATION_ACTIVATED_CHANNEL } from '../preload/channels';
import {
  activatedEscalationId, createEscalationNotices, type EscalationNoticeDeps, LAUNCH_PREFIX, launchArgument, MAX_ESCALATION_ID, MAX_LAUNCH, NOTICE_BODY_LIMIT,
  NOTICE_TITLE, noticeBody, type NoticeOptions, type NoticeWindow,
} from './escalation-notice';

class FakeNotice {
  listeners = new Map<string, () => void>();
  show = vi.fn();
  constructor(readonly options: NoticeOptions) {}
  on(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  fire(event: 'click' | 'close' | 'failed') {
    this.listeners.get(event)?.();
  }
}

const SESSION = fixtureSnapshot.sessions.find(item => item.id === 's-research')!;
const base = fixtureSnapshot.escalations.find(item => item.state === 'open')!;
const open = (id: string, over: Partial<Escalation> = {}): Escalation => ({ ...base, id, fromSessionId: SESSION.id, title: `確認 ${id}`, detail: `詳細 ${id}`, ...over } as Escalation);
const decided = (item: Escalation, state: 'resolved' | 'approved' | 'declined'): Escalation =>
  ({ ...item, state, resolvedBy: 'user', resolvedAt: '2026-10-24T12:30:00+08:00' });

const fakeWindow = (state: { minimized?: boolean; destroyed?: boolean } = {}) => {
  const calls: string[] = [];
  const send = vi.fn();
  const win: NoticeWindow = {
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: { send },
  };
  return { win, calls, send, state };
};

function rig(escalations: Escalation[] = [open('esc-1')], over: Partial<EscalationNoticeDeps> = {}) {
  const data = { snapshot: { ...structuredClone(fixtureSnapshot), escalations } as Snapshot | undefined };
  const made: FakeNotice[] = [];
  const window = fakeWindow({ minimized: true });
  const holder = { win: window.win as NoticeWindow | null };
  const snapshot = vi.fn(() => data.snapshot);
  const notices = createEscalationNotices({
    snapshot,
    getWindow: () => holder.win,
    createNotification: (options) => {
      const notice = new FakeNotice(options);
      made.push(notice);
      return notice;
    },
    useToastXml: true,
    ...over,
  });
  return { notices, made, data, window, holder, snapshot };
}

// The page's DOMParser (jsdom); the main process' types have no DOM, so the little used is typed here.
interface XmlElement { readonly tagName: string; readonly textContent: string | null; getAttribute(name: string): string | null }
interface XmlDocument { readonly documentElement: XmlElement; getElementsByTagName(name: string): ArrayLike<XmlElement> }
const parseXml = (text: string): XmlDocument =>
  new (globalThis as unknown as { DOMParser: new () => { parseFromString(text: string, type: string): XmlDocument } }).DOMParser().parseFromString(text, 'application/xml');

const click = (id: string) => ({ type: 'click', arguments: launchArgument(id) });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('T057 when the main process shows a notification', () => {
  it('shows an open escalation the page names, with the text written here', async () => {
    const { notices, made } = rig();
    await notices.show('esc-1');
    expect(made).toHaveLength(1);
    expect(made[0]!.options.title).toBe(NOTICE_TITLE);
    expect(made[0]!.options.title).toBe('需要你處理');
    expect(made[0]!.options.body).toBe(`${SESSION.title}：確認 esc-1`);
    expect(made[0]!.options.toastXml).toContain(`launch="${LAUNCH_PREFIX}esc-1"`);
    expect(made[0]!.show).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an escalation the backend does not have', 'esc-missing'],
    ['a number', 7],
    ['an empty string', ''],
    ['an ID longer than 256 characters', 'e'.repeat(257)],
    ['an object', { escalationId: 'esc-1' }],
    ['an array', ['esc-1']],
    ['nothing', undefined],
    ['null', null],
  ])('shows nothing for %s', async (_name, raw) => {
    const { notices, made } = rig();
    await notices.show(raw);
    expect(made).toHaveLength(0);
  });

  it.each(['resolved', 'approved', 'declined'] as const)('shows nothing for a %s escalation', async (state) => {
    const { notices, made } = rig([decided(open('esc-1'), state)]);
    await notices.show('esc-1');
    expect(made).toHaveLength(0);
  });

  it('shows one escalation once: asked again, or twice at the same time', async () => {
    const { notices, made } = rig([open('esc-1'), open('esc-2')]);
    await Promise.all([notices.show('esc-1'), notices.show('esc-1')]);
    await notices.show('esc-1');
    await notices.show('esc-2');
    expect(made.map(item => item.options.body)).toEqual([`${SESSION.title}：確認 esc-1`, `${SESSION.title}：確認 esc-2`]);
  });

  it('one refused while it was not open yet is shown when asked again once it is', async () => {
    const { notices, made, data } = rig([]);
    await notices.show('esc-later');
    data.snapshot = { ...data.snapshot!, escalations: [open('esc-later')] };
    await notices.show('esc-later');
    expect(made).toHaveLength(1);
  });

  it('shows nothing without a working backend, or when reading it fails, and never rejects', async () => {
    const none = rig();
    none.data.snapshot = undefined;
    await expect(none.notices.show('esc-1')).resolves.toBeUndefined();
    const failing = rig([open('esc-1')], { snapshot: () => Promise.reject(new Error('busy')) });
    await expect(failing.notices.show('esc-1')).resolves.toBeUndefined();
    const throwing = rig([open('esc-1')], { createNotification: () => { throw new Error('no service'); } });
    await expect(throwing.notices.show('esc-1')).resolves.toBeUndefined();
    expect(none.made.length + failing.made.length + throwing.made.length).toBe(0);
  });

  it('r1 P1: none is dropped while the backend is slow: 40 requests during one read all show, with one more read for them', async () => {
    const waiting: (() => void)[] = [];
    const escalations = Array.from({ length: 41 }, (_, i) => open(`esc-${String(i)}`));
    const snapshot = { ...structuredClone(fixtureSnapshot), escalations };
    const { notices, made } = rig(escalations, { snapshot: () => new Promise<Snapshot>(resolve => waiting.push(() => resolve(snapshot))) });
    const asked = escalations.map(item => notices.show(item.id));
    // The first is being read; the other 40 wait for one read together.
    expect(waiting).toHaveLength(1);
    waiting[0]!();
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[1]!();
    await Promise.all(asked);
    expect(waiting).toHaveLength(2);
    expect(made.map(item => item.options.body)).toEqual(escalations.map(item => `${SESSION.title}：${item.title}`));
  });

  it('r1 P1: a request made during a read is checked against the next read, so an escalation newer than that read shows', async () => {
    const reads: ((snapshot: Snapshot) => void)[] = [];
    const { notices, made } = rig([], { snapshot: () => new Promise<Snapshot>(resolve => reads.push(resolve)) });
    const first = notices.show('esc-old');
    const second = notices.show('esc-new');
    // The first read was taken before esc-new existed; esc-new waits for the second one.
    reads[0]!({ ...structuredClone(fixtureSnapshot), escalations: [open('esc-old')] });
    await first;
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!({ ...structuredClone(fixtureSnapshot), escalations: [open('esc-old'), open('esc-new')] });
    await second;
    expect(made.map(item => item.options.body)).toEqual([`${SESSION.title}：確認 esc-old`, `${SESSION.title}：確認 esc-new`]);
  });

  it('r1 P1 end to end: 17 new escalations arriving while the backend is slow give 17 notifications', async () => {
    const reads: (() => void)[] = [];
    const escalations = Array.from({ length: 17 }, (_, i) => open(`esc-${String(i)}`));
    const snapshot = { ...structuredClone(fixtureSnapshot), escalations };
    const { notices, made } = rig(escalations, { snapshot: () => new Promise<Snapshot>(resolve => reads.push(() => resolve(snapshot))) });
    const asked = escalations.map(item => notices.show(item.id));
    while (made.length < 17) {
      reads.shift()?.();
      await flush();
    }
    await Promise.all(asked);
    expect(made).toHaveLength(17);
  });

  it('stopped while requests wait: they settle and nothing is shown', async () => {
    const reads: (() => void)[] = [];
    const escalations = [open('esc-1'), open('esc-2')];
    const snapshot = { ...structuredClone(fixtureSnapshot), escalations };
    const { notices, made } = rig(escalations, { snapshot: () => new Promise<Snapshot>(resolve => reads.push(() => resolve(snapshot))) });
    const asked = [notices.show('esc-1'), notices.show('esc-2')];
    notices.stop();
    reads[0]!();
    await Promise.all(asked);
    expect(reads).toHaveLength(1);
    expect(made).toHaveLength(0);
  });

  it('without toastXml (not Windows) the title and body are given as they are', async () => {
    const { notices, made } = rig([open('esc-1')], { useToastXml: false });
    await notices.show('esc-1');
    expect(made[0]!.options).toEqual({ title: NOTICE_TITLE, body: `${SESSION.title}：確認 esc-1` });
  });

  it('stopped: nothing is shown', async () => {
    const { notices, made } = rig();
    notices.stop();
    await notices.show('esc-1');
    expect(made).toHaveLength(0);
  });
});

describe('T057 the text of a notification', () => {
  it('is cut to 100 characters by code points, with … as the last one, and has no detail', async () => {
    const long = noticeBody('標題', '很'.repeat(300));
    expect(Array.from(long)).toHaveLength(NOTICE_BODY_LIMIT);
    expect(long.endsWith('…')).toBe(true);
    const emoji = noticeBody(undefined, '😀'.repeat(150));
    expect(Array.from(emoji)).toHaveLength(NOTICE_BODY_LIMIT);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji)).toBe(false);
    expect(noticeBody('a', 'b')).toBe('a：b');
    const { notices, made } = rig([open('esc-detail', { detail: 'SECRET-DETAIL token sk-live-1234', fromSessionId: 'no-such-session' as Escalation['fromSessionId'] })]);
    await notices.show('esc-detail');
    expect(made[0]!.options.body).toBe('確認 esc-detail');
    expect(JSON.stringify(made[0]!.options)).not.toContain('SECRET-DETAIL');
  });
});

// T042 style: whatever the escalation and the session say, the toast is two texts and one launch argument.
describe('T057 injection', () => {
  const PAYLOAD = '<script>window.__awgPwned=1</script></text></binding></visual><actions><action content="x" arguments="type=action&amp;action=0" '
    + 'activationType="protocol"/></actions><visual><binding template="ToastGeneric"><text>&amp; " \' <img src=x onerror="window.__awgPwned=2">';
  const CONTROLS = '\u0000\u0007\u001b[31m\u202e\u2066\u009b\u007f\ud800\ufffe\uffff';

  it('the toast XML parses, has two texts and no action, and its texts are the cleaned plain text', async () => {
    const poisoned = structuredClone(fixtureSnapshot);
    poisoned.sessions = poisoned.sessions.map(item => item.id === SESSION.id ? { ...item, title: `標題${CONTROLS}\n<b>&amp;</b>` } : item);
    const { notices, made, data } = rig();
    data.snapshot = { ...poisoned, escalations: [open('esc-xss', { title: `${PAYLOAD}\r\n第二行${CONTROLS}` })] };
    await notices.show('esc-xss');
    const { toastXml, body, title } = made[0]!.options;
    const doc = parseXml(toastXml!);
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const toast = doc.documentElement;
    expect(toast.tagName).toBe('toast');
    expect(toast.getAttribute('launch')).toBe(`${LAUNCH_PREFIX}esc-xss`);
    expect(toast.getAttribute('activationType')).toBe('foreground');
    expect(doc.getElementsByTagName('action')).toHaveLength(0);
    expect(doc.getElementsByTagName('actions')).toHaveLength(0);
    expect(doc.getElementsByTagName('script')).toHaveLength(0);
    const texts = Array.from(doc.getElementsByTagName('text')).map(item => item.textContent);
    expect(texts).toEqual([title, body]);
    expect(body).toContain('</text></binding>');
    expect(body).toContain('<script>');
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffe\uffff]/);
    expect(Array.from(body).length).toBeLessThanOrEqual(NOTICE_BODY_LIMIT);
  });

  it('an ID with markup or URI characters is encoded in the launch argument and comes back as it was', async () => {
    const id = 'esc-<b>&"\'=type=action&x=%41 中';
    const { notices, made } = rig([open(id)]);
    await notices.show(id);
    const doc = parseXml(made[0]!.options.toastXml!);
    const launch = doc.documentElement.getAttribute('launch')!;
    expect(launch).not.toMatch(/[&=]/);
    expect(activatedEscalationId({ type: 'click', arguments: launch })).toBe(id);
  });

  it('an ID that cannot be encoded (a lone surrogate) is not shown, and nothing throws', async () => {
    const { notices, made } = rig([open('esc-\ud800')]);
    await expect(notices.show('esc-\ud800')).resolves.toBeUndefined();
    expect(made).toHaveLength(0);
  });

  // r1 P2: whatever is shown can be clicked; the launch limit follows from the ID limit.
  it.each([
    ['112 CJK characters (r1)', '中'.repeat(112)],
    ['256 CJK characters, the longest ID', '中'.repeat(MAX_ESCALATION_ID)],
    ['128 emoji (256 UTF-16 units)', '😀'.repeat(MAX_ESCALATION_ID / 2)],
    ['256 characters encoded as is', 'e'.repeat(MAX_ESCALATION_ID)],
  ])('an ID of %s is shown, and a click on it opens it', async (_name, id) => {
    const { notices, made, window } = rig([open(id)]);
    await notices.show(id);
    expect(made).toHaveLength(1);
    const launch = parseXml(made[0]!.options.toastXml!).documentElement.getAttribute('launch')!;
    expect(launch.length).toBeLessThanOrEqual(MAX_LAUNCH);
    await notices.activate({ type: 'click', arguments: launch });
    expect(window.send.mock.calls).toEqual([[ESCALATION_ACTIVATED_CHANNEL, { escalationId: id }]]);
  });
});

describe('T057 the arguments of a Windows activation', () => {
  it.each([
    ['not an object', 'awg-escalation:esc-1'],
    ['null', null],
    ['an action', { type: 'action', arguments: `${LAUNCH_PREFIX}esc-1`, actionIndex: 0 }],
    ['a reply', { type: 'reply', arguments: `${LAUNCH_PREFIX}esc-1`, reply: 'x' }],
    ['no type', { arguments: `${LAUNCH_PREFIX}esc-1` }],
    ['arguments that are not a string', { type: 'click', arguments: ['esc-1'] }],
    ['empty arguments (Electron’s own toast)', { type: 'click', arguments: '' }],
    ['another prefix', { type: 'click', arguments: 'escalation:esc-1' }],
    ['the prefix alone', { type: 'click', arguments: LAUNCH_PREFIX }],
    ['more after a space', { type: 'click', arguments: `${LAUNCH_PREFIX}esc-1 --flag` }],
    ['a second argument', { type: 'click', arguments: `${LAUNCH_PREFIX}esc-1&type=action` }],
    ['a broken escape', { type: 'click', arguments: `${LAUNCH_PREFIX}%E0%A4%A` }],
    ['an ID longer than 256 characters', { type: 'click', arguments: `${LAUNCH_PREFIX}${'e'.repeat(257)}` }],
    ['an encoded ID that decodes to more than 256 characters', { type: 'click', arguments: `${LAUNCH_PREFIX}${'%41'.repeat(400)}` }],
    ['arguments longer than the longest launch', { type: 'click', arguments: `${LAUNCH_PREFIX}${'A'.repeat(MAX_LAUNCH)}` }],
  ])('%s is no escalation', (_name, details) => {
    expect(activatedEscalationId(details)).toBeUndefined();
  });

  it('our own launch argument is', () => {
    expect(activatedEscalationId({ type: 'click', arguments: `${LAUNCH_PREFIX}esc-1`, userInputs: { x: 'y' } })).toBe('esc-1');
  });
});

describe('T057 a click', () => {
  it('an activation naming an escalation the backend has: restore, show, focus, then the page is told once', async () => {
    const { notices, window } = rig();
    await notices.activate(click('esc-1'));
    expect(window.calls).toEqual(['restore', 'show', 'focus']);
    expect(window.send.mock.calls).toEqual([[ESCALATION_ACTIVATED_CHANNEL, { escalationId: 'esc-1' }]]);
  });

  it('a decided escalation the backend still has opens too', async () => {
    const { notices, window } = rig([decided(open('esc-1'), 'resolved')]);
    await notices.activate(click('esc-1'));
    expect(window.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['arguments that are not ours', { type: 'click', arguments: 'something else' }],
    ['an escalation the backend does not have', click('esc-missing')],
    ['an action', { type: 'action', arguments: launchArgument('esc-1') }],
  ])('%s only brings the window forward', async (_name, details) => {
    const { notices, window } = rig();
    await notices.activate(details);
    expect(window.calls).toEqual(['restore', 'show', 'focus']);
    expect(window.send).not.toHaveBeenCalled();
  });

  it('the banner (the instance’s click alone) tells the page once', async () => {
    const { notices, made, window } = rig();
    await notices.show('esc-1');
    made[0]!.fire('click');
    made[0]!.fire('click');
    await flush();
    expect(window.calls).toEqual(['restore', 'show', 'focus']);
    expect(window.send).toHaveBeenCalledTimes(1);
  });

  it('the COM path (the activation first, then the instance’s click) tells the page once', async () => {
    const { notices, made, window } = rig();
    await notices.show('esc-1');
    const activated = notices.activate(click('esc-1'));
    made[0]!.fire('click');
    await activated;
    await flush();
    expect(window.send).toHaveBeenCalledTimes(1);
  });

  it('the Action Center after the banner went away (closed, no instance left) tells the page once', async () => {
    const { notices, made, window } = rig();
    await notices.show('esc-1');
    made[0]!.fire('close');
    await notices.activate(click('esc-1'));
    made[0]!.fire('click');
    await flush();
    expect(window.send).toHaveBeenCalledTimes(1);
  });

  it('a window closed or replaced while the backend is read is not sent to', async () => {
    let release: (() => void) | undefined;
    const escalations = [open('esc-1')];
    const snapshot = { ...structuredClone(fixtureSnapshot), escalations };
    const { notices, window, holder } = rig(escalations, { snapshot: () => new Promise<Snapshot>(resolve => { release = () => resolve(snapshot); }) });
    const first = notices.activate(click('esc-1'));
    const replacement = fakeWindow();
    holder.win = replacement.win;
    release!();
    await first;
    expect(window.send).not.toHaveBeenCalled();
    expect(replacement.send).toHaveBeenCalledTimes(1);

    const second = notices.activate(click('esc-1'));
    replacement.state.destroyed = true;
    release!();
    await second;
    expect(replacement.send).toHaveBeenCalledTimes(1);
  });

  it('after stop() nothing is sent, also for a click that was waiting', async () => {
    let release: (() => void) | undefined;
    const escalations = [open('esc-1')];
    const snapshot = { ...structuredClone(fixtureSnapshot), escalations };
    const { notices, window } = rig(escalations, { snapshot: () => new Promise<Snapshot>(resolve => { release = () => resolve(snapshot); }) });
    const waiting = notices.activate(click('esc-1'));
    notices.stop();
    release!();
    await waiting;
    await notices.activate(click('esc-1'));
    expect(window.send).not.toHaveBeenCalled();
  });

  it('a cold start (no window, no backend yet) does nothing and does not throw', async () => {
    const { notices, holder, data } = rig();
    holder.win = null;
    data.snapshot = undefined;
    await expect(notices.activate(click('esc-1'))).resolves.toBeUndefined();
    await expect(notices.activate(undefined)).resolves.toBeUndefined();
  });

  it('a page that is gone does not make the click throw', async () => {
    const { notices, window } = rig();
    window.send.mockImplementation(() => { throw new Error('Object has been destroyed'); });
    await expect(notices.activate(click('esc-1'))).resolves.toBeUndefined();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
