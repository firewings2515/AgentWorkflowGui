// @vitest-environment jsdom
// T054 (U3-B) in the connected v0.4 shell: sidebar order by last message (Q-17), unread dots (Q-14) and the split layout
// kept across restarts (Q-16). Fixture chats: 規劃想法 (s-plan-notes, last message 10:30) → 參考資料整理 (s-research,
// reply 10:20); 規劃想法（轉交 Codex） (s-handoff-codex, no messages, created 10:40). Runs: inst-docs (12:03), inst-login (11:22).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, MessageId, SessionId } from '../../../../contracts';
import type { AppEvent, Escalation, LogicalSession, Message, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { fakeBridge } from '../ipc-test-helpers';
import { rendererStore } from '../renderer-store';
import { PANES_KEY } from './pane-memory';
import { SEEN_KEY } from './seen';
import { NARROW_MAX_WIDTH } from './ShellV4';
import v4css from './styles.css?raw';

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const byId = (id: string) => fixtureSnapshot.sessions.find(session => session.id === id)!;
const plan = byId('s-plan-notes'); const research = byId('s-research'); const handoff = byId('s-handoff-codex');
const at = (time: string) => `2026-10-24T${time}:00+08:00`;
const connect = (snapshot: Snapshot = fixtureSnapshot) => { fake = fakeBridge(snapshot); window.awg = fake.bridge; seq = snapshot.seq; };
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  // r1: the 500 ms write throttle is passed with a fake clock (which still runs, so findBy works).
  vi.useFakeTimers({ shouldAdvanceTime: true });
  connect();
  window.history.replaceState(null, '', `/#/sessions/${plan.id}`); localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); localStorage.clear(); });

async function setup(hash?: string) { if (hash !== undefined) window.history.replaceState(null, '', `/${hash}`); render(<App />); await screen.findAllByText('IPC 已連線'); }
/** Unmounts (which writes what is pending) and starts again with a fresh service on the same localStorage. */
async function restart(hash = '', snapshot: Snapshot = fixtureSnapshot) { cleanup(); rendererStore(fake.bridge).dispose(); connect(snapshot); await setup(hash); }
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const ids = (selector: string, attribute = 'data-session-id') => Array.from(document.querySelectorAll(selector)).map(item => item.getAttribute(attribute));
const chatOrder = () => ids('.v4-sidebar section[aria-label="對話"] > ul > li');
const runOrder = () => ids('.v4-sidebar section[aria-label="執行"] > ul > li', 'data-run-id');
const rowOf = (id: string) => document.querySelector(`.v4-sidebar [data-session-id="${id}"] > .v4-row`)!;
const runRowOf = (id: string) => document.querySelector(`.v4-sidebar [data-run-id="${id}"] > .v4-row`)!;
const openRow = (id: string) => fireEvent.click(rowOf(id).querySelector('.v4-session')!);
const dotted = (row: Element) => row.querySelector('.v4-unread') !== null;
const anyUnread = () => document.querySelectorAll('.v4-unread').length;
const workflowMode = () => fireEvent.click(sidebar().getByRole('button', { name: /^Workflow/ }));
let counter = 0;
const message = (sessionId: string, createdAt: string, extra: Partial<Message> = {}): Message =>
  ({ id: MessageId.parse(`m-t054-${++counter}`), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: '回覆', attachments: [], createdAt, ...extra }) as Message;
const reply = (sessionId: string, createdAt: string, extra: Partial<Message> = {}) => emit({ type: 'message.completed', message: message(sessionId, createdAt, extra) });
const userSays = (sessionId: string, createdAt: string) => reply(sessionId, createdAt, { role: 'user', origin: { kind: 'user' } });
const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
const seenRecord = () => stored(SEEN_KEY) as { version: number; since: string | null; seen: Record<string, string> };
/** Past the 500 ms write throttle. */
const settle = () => act(() => { vi.advanceTimersByTime(600); });
/** The newest message in the fixture (m11, 11:22 +08:00): the baseline's `since`. */
const FIXTURE_SINCE = '2026-10-24T03:22:00.000Z';
const paneTitles = () => Array.from(document.querySelectorAll('[data-pane]')).map(pane => pane.getAttribute('aria-label'));
const activePane = () => document.querySelector('.v4-pane-active')?.getAttribute('aria-label');

describe('T054 order by last message (Q-17)', () => {
  it('renaming, changing the model and opening or closing the runtime keep the order; a new message moves the session up', async () => {
    await setup();
    expect(chatOrder()).toEqual([handoff.id, plan.id]);
    const later = at('13:00');
    emit({ type: 'session.updated', session: { ...plan, title: '改過名的規劃', updatedAt: later, revision: plan.revision + 1 } });
    emit({ type: 'session.updated', session: { ...plan, title: '改過名的規劃', requestedModel: handoff.requestedModel, updatedAt: at('13:01'), revision: plan.revision + 2 } });
    emit({ type: 'session.activity', sessionId: plan.id, activity: 'closed', at: at('13:02') });
    emit({ type: 'session.activity', sessionId: plan.id, activity: 'idle', at: at('13:03') });
    expect(chatOrder()).toEqual([handoff.id, plan.id]);
    // System notes and a sub-agent's messages do not count either.
    reply(plan.id, at('13:04'), { role: 'system', origin: { kind: 'system' } });
    reply(plan.id, at('13:05'), { nativeTaskId: 'nt-1' } as Partial<Message>);
    expect(chatOrder()).toEqual([handoff.id, plan.id]);
    userSays(plan.id, '2026-10-24T02:50:00Z'); // 10:50 +08:00, written in Z
    expect(chatOrder()).toEqual([plan.id, handoff.id]);
  });

  it('children are ordered by last message too', async () => {
    const sibling = { ...research, id: 's-research-2', title: '第二份資料', createdAt: at('10:05') } as LogicalSession;
    connect({ ...fixtureSnapshot, sessions: [...fixtureSnapshot.sessions, sibling] });
    await setup();
    const children = () => ids(`.v4-sidebar [data-session-id="${plan.id}"] > ul > li`);
    expect(children()).toEqual([research.id, sibling.id]);
    emit({ type: 'session.activity', sessionId: research.id, activity: 'running', at: at('14:00') });
    expect(children()).toEqual([research.id, sibling.id]);
    reply(sibling.id, at('10:25'));
    expect(children()).toEqual([sibling.id, research.id]);
  });

  it('a run is ordered by the newest message of any of its node sessions, not by activity', async () => {
    await setup();
    workflowMode();
    expect(runOrder()).toEqual(['inst-docs', 'inst-login']);
    emit({ type: 'session.activity', sessionId: SessionId.parse('s-wf-root'), activity: 'running', at: at('15:00') });
    expect(runOrder()).toEqual(['inst-docs', 'inst-login']);
    reply('s-wf-build-a', '2026-10-24T05:00:00.000Z'); // 13:00 +08:00
    expect(runOrder()).toEqual(['inst-login', 'inst-docs']);
  });

  it('search results and the pinned section follow the same order', async () => {
    connect({ ...fixtureSnapshot, preferences: { ...fixtureSnapshot.preferences, pinned: { chat: [plan.id, handoff.id], workflow: [] } } });
    await setup();
    const pinned = () => ids('.v4-sidebar section[aria-label="釘選"] > ul > li');
    expect(pinned()).toEqual([handoff.id, plan.id]);
    reply(plan.id, at('11:00'));
    expect(pinned()).toEqual([plan.id, handoff.id]);
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '規劃想法' } });
    const results = () => ids('.v4-sidebar section[aria-label="搜尋結果"] > ul > li');
    expect(results()).toEqual([plan.id, handoff.id]);
    reply(handoff.id, at('11:30'));
    expect(results()).toEqual([handoff.id, plan.id]);
  });
});

describe('T054 unread dots (Q-14)', () => {
  it('nothing lights up on the first start, and the baseline is saved', async () => {
    await setup('#/new');
    expect(anyUnread()).toBe(0);
    settle();
    expect(stored(SEEN_KEY)).toEqual({ version: 2, since: FIXTURE_SINCE,
      seen: { [plan.id]: '2026-10-24T02:01:00.000Z', [research.id]: '2026-10-24T02:20:00.000Z', 's-wf-root': '2026-10-24T03:05:00.000Z', 's-wf-build-a': '2026-10-24T03:20:00.000Z' } });
    // r1 P2-2: an older reply (as a history page brings) in a session the baseline has no reply for stays unlit.
    reply(handoff.id, at('09:30'));
    expect(dotted(rowOf(handoff.id))).toBe(false);
  });

  it('a reply lights up another session; the user\'s own message and a reply in a shown session do not; opening it clears the dot', async () => {
    await setup();
    reply(handoff.id, at('12:00'));
    expect(dotted(rowOf(handoff.id))).toBe(true);
    expect(within(rowOf(handoff.id) as HTMLElement).getByRole('img', { name: '有新訊息' })).toBeTruthy();
    userSays(research.id, at('11:01'));
    expect(dotted(rowOf(research.id))).toBe(false);
    reply(plan.id, at('12:02'));
    expect(dotted(rowOf(plan.id))).toBe(false);
    // A sub-agent's reply does not count.
    reply(research.id, at('11:03'), { nativeTaskId: 'nt-1' } as Partial<Message>);
    expect(dotted(rowOf(research.id))).toBe(false);
    openRow(handoff.id);
    expect(anyUnread()).toBe(0);
    settle();
    expect(seenRecord().seen).toMatchObject({ [handoff.id]: '2026-10-24T04:00:00.000Z', [plan.id]: '2026-10-24T04:02:00.000Z' });
  });

  it('a session shown in either pane of a split stays unlit; it lights up once it is not shown (another page)', async () => {
    await setup();
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(paneTitles()).toHaveLength(2);
    reply(plan.id, at('11:00')); reply(handoff.id, at('11:01'));
    expect(anyUnread()).toBe(0);
    fireEvent.click(sidebar().getByRole('button', { name: /設定/ }));
    reply(handoff.id, at('11:05'));
    expect(dotted(rowOf(handoff.id))).toBe(true);
    expect(dotted(rowOf(plan.id))).toBe(false);
  });

  it('the first reply of a new chat sent from this app does not light up while it is shown', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'session.create') {
        const created = { ...handoff, id: command.sessionId, title: '新建對話', revision: 0, activity: 'idle', createdAt: at('16:00') } as LogicalSession;
        fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: created } });
        fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, { ...created, revision: 1 }] };
      }
      return { ok: true, requestId: command.requestId, created: [] };
    });
    await setup('#/new');
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /輸入訊息/ });
    fireEvent.change(box, { target: { value: '第一則' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByRole('heading', { name: '新建對話' });
    const created = fake.bridge.send.mock.calls.map(([input]) => Command.parse(input)).find(command => command.type === 'session.create')!;
    userSays(created.sessionId, at('16:00'));
    reply(created.sessionId, at('16:01'));
    expect(anyUnread()).toBe(0);
    settle();
    expect(seenRecord().seen).toMatchObject({ [created.sessionId]: '2026-10-24T08:01:00.000Z' });
    // A chat that appeared elsewhere (not shown) lights up with its first reply.
    const other = { ...handoff, id: 's-elsewhere', title: '別處建立', createdAt: at('16:02') } as LogicalSession;
    emit({ type: 'session.updated', session: other });
    reply(other.id, at('16:03'));
    expect(dotted(rowOf(other.id))).toBe(true);
  });

  it('a pending escalation\'s dot wins over the unread dot', async () => {
    await setup('#/new');
    reply(handoff.id, at('12:00'));
    expect(dotted(rowOf(handoff.id))).toBe(true);
    const escalation = { ...fixtureSnapshot.escalations[0]!, id: 'esc-t054', rootSessionId: handoff.id, fromSessionId: handoff.id } as Escalation;
    delete (escalation as Partial<Escalation>).instanceId;
    emit({ type: 'escalation.updated', escalation });
    expect(rowOf(handoff.id).querySelector('.v4-alert')).not.toBeNull();
    expect(dotted(rowOf(handoff.id))).toBe(false);
  });

  it('a run row lights up when any node session has an unseen reply, unless it has a pending escalation', async () => {
    await setup('#/new');
    workflowMode();
    expect(anyUnread()).toBe(0);
    reply('s-docs-rev-codex', at('12:30'));
    expect(dotted(runRowOf('inst-docs'))).toBe(true);
    reply('s-wf-review-a', at('12:31'));
    expect(runRowOf('inst-login').querySelector('.v4-alert')).not.toBeNull();
    expect(dotted(runRowOf('inst-login'))).toBe(false);
  });

  it('a stored record lights up replies after the seen time at start-up, and one after since in a session it does not name', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ version: 2, since: at('10:10'), seen: { [plan.id]: at('09:00'), 's-gone': at('09:00'), 's-wf-root': at('12:00'), 's-wf-build-a': at('12:00') } }));
    await setup('#/new');
    expect(dotted(rowOf(plan.id))).toBe(true);
    expect(dotted(rowOf(research.id))).toBe(true); // reply 10:20, after since
    settle();
    expect(Object.keys(seenRecord().seen)).not.toContain('s-gone');
    expect(seenRecord().since).toBe(at('10:10'));
    // With since after research's reply, it stays unlit.
    cleanup(); localStorage.setItem(SEEN_KEY, JSON.stringify({ version: 2, since: at('10:30'), seen: { [plan.id]: at('09:00') } }));
    await restart('#/new');
    expect(dotted(rowOf(plan.id))).toBe(true);
    expect(dotted(rowOf(research.id))).toBe(false);
  });

  it('T058: a session that goes away while the app runs (a restored backup) is dropped from the record at the next write', async () => {
    await setup('#/new');
    settle();
    expect(Object.keys(seenRecord().seen)).toEqual(expect.arrayContaining([plan.id, research.id]));
    const gone = (id: string) => id === research.id;
    fake.data.snapshot = { ...fixtureSnapshot, seq: seq + 1, sessions: fixtureSnapshot.sessions.filter(session => !gone(session.id)),
      messages: fixtureSnapshot.messages.filter(item => !gone(item.sessionId)) };
    emit({ type: 'snapshot.invalidated', reason: 'event-write-failed', at: at('13:00') });
    await vi.waitFor(() => expect(document.querySelector(`.v4-sidebar [data-session-id="${research.id}"]`)).toBeNull());
    settle();
    expect(Object.keys(seenRecord().seen)).not.toContain(research.id);
    expect(Object.keys(seenRecord().seen)).toContain(plan.id);
    expect(seenRecord().since).toBe(FIXTURE_SINCE);
  });

  it('r2: a v2 record that is broken JSON takes the baseline and lights nothing, like one with the wrong shape', async () => {
    for (const bad of ['{invalid JSON', JSON.stringify({ version: 2, since: at('08:00'), seen: [] })]) {
      cleanup(); localStorage.setItem(SEEN_KEY, bad);
      await restart('#/new');
      expect(anyUnread()).toBe(0);
      settle();
      expect(seenRecord()).toEqual({ version: 2, since: FIXTURE_SINCE, seen: expect.objectContaining({ [plan.id]: '2026-10-24T02:01:00.000Z' }) as unknown });
    }
  });

  it('r2 P2-1: without matchMedia, the window width decides; with neither, only the active pane of a split is seen', async () => {
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('innerWidth', 1200);
    await setup();
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(activePane()).toBe(`對話：${handoff.title}`);
    act(() => { vi.stubGlobal('innerWidth', NARROW_MAX_WIDTH - 100); window.dispatchEvent(new Event('resize')); });
    reply(plan.id, at('12:00'));
    fireEvent.click(screen.getByRole('button', { name: '開啟側欄' }));
    expect(dotted(rowOf(plan.id))).toBe(true);
    act(() => { vi.stubGlobal('innerWidth', 1200); window.dispatchEvent(new Event('resize')); });
    expect(anyUnread()).toBe(0);
    // Neither matchMedia nor a width: the wide layout, but a reply in the inactive pane still lights up.
    act(() => { vi.stubGlobal('innerWidth', undefined); window.dispatchEvent(new Event('resize')); });
    expect(paneTitles()).toHaveLength(2);
    reply(plan.id, at('12:10'));
    expect(dotted(rowOf(plan.id))).toBe(true);
    reply(handoff.id, at('12:11'));
    expect(dotted(rowOf(handoff.id))).toBe(false);
  });

  it('r1 P1-1: when narrow, the hidden pane of a split is not seen; it is once the window is wide again', async () => {
    let narrow = false;
    const query = new EventTarget();
    Object.defineProperty(query, 'matches', { get: () => narrow });
    vi.stubGlobal('matchMedia', vi.fn(() => query));
    await setup();
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(activePane()).toBe(`對話：${handoff.title}`);
    act(() => { narrow = true; query.dispatchEvent(new Event('change')); });
    reply(plan.id, at('12:00')); reply(handoff.id, at('12:01'));
    fireEvent.click(screen.getByRole('button', { name: '開啟側欄' }));
    expect(dotted(rowOf(plan.id))).toBe(true);
    expect(dotted(rowOf(handoff.id))).toBe(false);
    settle();
    expect(seenRecord().seen[plan.id]).toBe('2026-10-24T02:01:00.000Z');
    act(() => { narrow = false; query.dispatchEvent(new Event('change')); });
    expect(anyUnread()).toBe(0);
    settle();
    expect(seenRecord().seen[plan.id]).toBe('2026-10-24T04:00:00.000Z');
  });

  it('the narrow breakpoint is the one the stylesheet hides inactive panes at', () => {
    const style = document.createElement('style');
    style.textContent = v4css;
    document.head.append(style);
    const media = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
    style.remove();
    const hiding = media.filter(rule => Array.from(rule.cssRules).some(inner => inner instanceof CSSStyleRule
      && inner.selectorText === '.v4-split .v4-pane:not(.v4-pane-active)' && inner.style.display === 'none'));
    expect(hiding.map(rule => rule.media.mediaText)).toEqual([`(max-width: ${NARROW_MAX_WIDTH}px)`]);
  });

  it('r1 P1-2: the demo neither reads nor writes the stored layout and seen times', () => {
    const layout = JSON.stringify({ version: 1, active: 1, panes: [{ sessionId: plan.id, details: true, tab: 'tasks' }, { sessionId: handoff.id, details: false, tab: 'files' }] });
    const seen = JSON.stringify({ version: 2, since: at('08:00'), seen: { [plan.id]: at('09:00'), 's-real-only': at('09:00') } });
    localStorage.setItem(PANES_KEY, layout); localStorage.setItem(SEEN_KEY, seen);
    delete window.awg;
    window.history.replaceState(null, '', '/');
    render(<App />);
    expect(screen.getByText('示意模式 · 未連接 runtime')).toBeTruthy();
    // Not restored, and nothing lit from the stored seen times.
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    expect(anyUnread()).toBe(0);
    openRow(plan.id);
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(paneTitles()).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(2000); });
    cleanup();
    expect([localStorage.getItem(PANES_KEY), localStorage.getItem(SEEN_KEY)]).toEqual([layout, seen]);
  });

  it('localStorage that throws on read and write changes nothing visible and raises nothing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const errors = vi.spyOn(console, 'error');
    await setup();
    expect(anyUnread()).toBe(0);
    reply(handoff.id, at('12:00'));
    expect(dotted(rowOf(handoff.id))).toBe(true);
    openRow(handoff.id);
    expect(anyUnread()).toBe(0);
    settle();
    expect(write.mock.calls.some(([key]) => key === SEEN_KEY)).toBe(true);
    cleanup();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('T054 split layout across restarts (Q-16)', () => {
  async function splitWithDetails() {
    await setup();
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    const planPane = within(screen.getByRole('region', { name: `對話：${plan.title}` }));
    fireEvent.click(planPane.getByRole('button', { name: '開啟細節窗格' }));
    fireEvent.click(planPane.getByRole('tab', { name: '任務流程' }));
    fireEvent.change(planPane.getByRole('textbox', { name: new RegExp(`^回覆 ${plan.title}`) }), { target: { value: '還沒送的草稿' } });
    // The split made the 轉交 pane active; the detail click focused nothing else.
    expect(activePane()).toBe(`對話：${handoff.title}`);
  }

  it('restores two panes, the active pane and the detail pane with its tab after a restart, without the draft', async () => {
    await splitWithDetails();
    await restart('');
    expect(paneTitles()).toEqual([`對話：${plan.title}`, `對話：${handoff.title}`]);
    expect(activePane()).toBe(`對話：${handoff.title}`);
    expect(window.location.hash).toBe(`#/sessions/${handoff.id}`);
    const planPane = within(screen.getByRole('region', { name: `對話：${plan.title}` }));
    expect(planPane.getByRole('tab', { name: '任務流程' }).getAttribute('aria-selected')).toBe('true');
    expect(planPane.getByRole<HTMLTextAreaElement>('textbox', { name: new RegExp(`^回覆 ${plan.title}`) }).value).toBe('');
    expect(localStorage.getItem(PANES_KEY)).not.toContain('還沒送的草稿');
  });

  it('an address naming a session shows it in the restored layout; another page keeps its page', async () => {
    await splitWithDetails();
    await restart(`#/sessions/${research.id}`);
    expect(paneTitles()).toEqual([`對話：${plan.title}`, `對話：${research.title}`]);
    expect(activePane()).toBe(`對話：${research.title}`);
    await restart(`#/sessions/${plan.id}`);
    expect(activePane()).toBe(`對話：${plan.title}`);
    await restart('#/settings');
    expect(screen.getByRole('heading', { level: 1, name: '設定' })).toBeTruthy();
    openRow(research.id);
    expect(paneTitles()).toHaveLength(2);
  });

  it('skips a pane whose session is gone; falls back to the default screen when none is left or the record is malformed', async () => {
    localStorage.setItem(PANES_KEY, JSON.stringify({ version: 1, active: 0, panes: [{ sessionId: 's-gone', details: true, tab: 'info' }, { sessionId: handoff.id, details: false, tab: 'files' }] }));
    await setup('');
    expect(paneTitles()).toEqual([`對話：${handoff.title}`]);
    expect(activePane()).toBe(`對話：${handoff.title}`);
    // Unmounting writes the current layout, so the record is replaced after that.
    cleanup(); localStorage.setItem(PANES_KEY, JSON.stringify({ version: 1, active: 0, panes: [{ sessionId: 's-gone', details: false, tab: 'files' }] }));
    await restart('');
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    for (const bad of ['{not json', JSON.stringify({ version: 2, active: 0, panes: [{ sessionId: plan.id, details: false, tab: 'files' }] }), JSON.stringify({ panes: 'x' })]) {
      cleanup(); localStorage.setItem(PANES_KEY, bad);
      await restart('');
      expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
      expect(paneTitles()).toEqual([]);
    }
  });

  it('typing a draft does not write the layout; a failing write is ignored', async () => {
    await setup();
    settle();
    expect(localStorage.getItem(PANES_KEY)).not.toBeNull();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const box = screen.getByRole('textbox', { name: new RegExp(`^回覆 ${plan.title}`) });
    for (const text of ['一', '一二', '一二三']) fireEvent.change(box, { target: { value: text } });
    settle();
    expect(write.mock.calls.filter(([key]) => key === PANES_KEY)).toHaveLength(0);
    write.mockImplementation(() => { throw new Error('quota'); });
    fireEvent.contextMenu(rowOf(handoff.id).querySelector('.v4-session')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(paneTitles()).toHaveLength(2);
    expect(() => cleanup()).not.toThrow();
  });
});
