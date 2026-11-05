// @vitest-environment jsdom
// T060 (U4-C): archive in the connected v0.4 shell — the 「已封存」 sections, 封存／取消封存 in the menu, the banner, moves
// and drags leaving archived trees out, and the auto-archive setting.
// Data: the fixture plus
// - archived conversations: 規劃想法 (s-plan-notes, its child 參考資料整理 is running), s-old (child s-old-child) and s-older;
// - a quiet top conversation s-quiet (nothing in the way of archiving it);
// - the 文件 review run (inst-docs) ended and archived (its node Review（Codex） still running, ★D);
// - pins left behind for archived items: s-older, s-old-child (chat), inst-docs, s-docs-rev-claude (workflow).
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId, Snapshot, UiPreferences } from '../../../../contracts';
import type { AppEvent, CommandResult, ErrorCode, Escalation, LogicalSession } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { rendererStore } from '../renderer-store';
import { readOnlyProps } from '../read-only';
import { deferred, fakeBridge } from '../ipc-test-helpers';
import { ARCHIVED_OPEN_KEY } from './archive';
import { AUTO_ARCHIVE_RANGE } from './Pages';
import { SESSION_DRAG_TYPE } from './session-drag';
import { ARCHIVE_UNCERTAIN, ARCHIVED_MOVE, STALE_MOVE, STALE_RUN } from './ShellV4';
import { ARCHIVED_PIN } from './Sidebar';

const at = '2026-11-05T10:00:00.000Z';
const byId = (id: string) => fixtureSnapshot.sessions.find(session => session.id === id)!;
const handoff = byId('s-handoff-codex');
const top = (id: string, title: string, createdAt: string, patch: Record<string, unknown> = {}) => {
  const session = { ...handoff, id, title, createdAt, updatedAt: createdAt, activity: 'idle', ...patch } as LogicalSession;
  if (!('parentId' in patch)) delete (session as { parentId?: string }).parentId;
  return session;
};

function archivedData(patch: (snapshot: Snapshot) => Partial<Snapshot> = () => ({})): Snapshot {
  const base = {
    ...fixtureSnapshot,
    sessions: [
      ...fixtureSnapshot.sessions.map(session => session.id === 's-plan-notes' ? { ...session, archivedAt: at } : session),
      top('s-quiet', '安靜的對話', '2026-04-01T00:00:00.000Z'),
      top('s-old', '舊對話', '2026-01-01T00:00:00.000Z', { archivedAt: at }),
      top('s-old-child', '舊對話的子對話', '2026-03-01T00:00:00.000Z', { parentId: 's-old' }),
      top('s-older', '更舊的對話', '2026-02-01T00:00:00.000Z', { archivedAt: at }),
    ],
    instances: fixtureSnapshot.instances.map(item => item.id === 'inst-docs'
      ? { ...item, state: 'completed', endedAt: at, archivedAt: at, tasks: [], rounds: [], mergeQueue: [], taskPlans: [] } : item),
    preferences: { ...fixtureSnapshot.preferences, pinned: { chat: ['s-older', 's-old-child', 's-handoff-codex'], workflow: ['inst-docs', 's-docs-rev-claude'] } },
  };
  return Snapshot.parse({ ...base, ...patch(base as Snapshot) });
}

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const loadData = (snapshot: Snapshot) => { fake = fakeBridge(snapshot); window.awg = fake.bridge; seq = snapshot.seq; };
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  loadData(archivedData());
  window.history.replaceState(null, '', '/#/sessions/s-handoff-codex'); localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

async function setup() { render(<App />); await screen.findAllByText('IPC 已連線'); }
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const toWorkflow = () => fireEvent.click(sidebar().getByRole('button', { name: /^Workflow/ }));
const region = (name: string) => screen.queryByRole('region', { name });
/** Row ids shown in a section, in order (sessions and runs). */
const ids = (name: string) => Array.from(region(name)?.querySelectorAll<HTMLElement>('[data-session-id], [data-run-id]') ?? [])
  .map(item => item.dataset['sessionId'] ?? item.dataset['runId']);
const archivedHeading = () => region('已封存')!.querySelector<HTMLButtonElement>('h2 button')!;
const toggleArchived = () => fireEvent.click(region('已封存')!.querySelector('h2 button')!);
const rowButton = (id: string, attribute = 'session') => document.querySelector<HTMLButtonElement>(`.v4-sidebar [data-${attribute}-id="${id}"] > .v4-row > .v4-session`)!;
const openMenu = (id: string, attribute = 'session') => { fireEvent.contextMenu(rowButton(id, attribute)); return within(screen.getByRole('menu')); };
const menuItems = (id: string, attribute = 'session') => {
  const items = openMenu(id, attribute).getAllByRole<HTMLButtonElement>('menuitem').map(item => ({ label: item.textContent, disabled: item.disabled, title: item.title }));
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  return items;
};
const archiveItem = (id: string, attribute = 'session') => menuItems(id, attribute).find(item => item.label === '封存' || item.label === '取消封存');
const sent = () => fake.bridge.send.mock.calls.map(([input]) => Command.parse(input));
const archiveCommands = () => sent().filter(command => /archive$/.test(command.type));
const accepted = (input: { requestId: string }): CommandResult => ({ ok: true, requestId: RequestId.parse(input.requestId), created: [] });
const refuse = (code: ErrorCode, extra: Record<string, unknown> = {}) => fake.bridge.send.mockImplementation(input =>
  Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code, message: '', retryable: false, mayHaveSideEffects: false, ...extra } as CommandResult));
const notice = () => document.querySelector('.v4-notice span')?.textContent;
const LONG_WAIT = 20_000;
/** An open escalation of a conversation (no run). */
const openEscalation = (id: string, from: string, root: string): Escalation => {
  const item = { ...fixtureSnapshot.escalations.find(entry => entry.state === 'open')!, id: id as never, fromSessionId: from as never, rootSessionId: root as never };
  delete (item as { instanceId?: string }).instanceId;
  return item;
};
const revisionOf = (id: string) => fake.data.snapshot.sessions.find(session => session.id === id)!.revision;
const sessionNow = (id: string) => fake.data.snapshot.sessions.find(session => session.id === id)!;

describe('the 已封存 section (chat mode)', () => {
  it('archived conversations are only there: not in the list, not pinned (pins left behind too); closed by default with the count', async () => {
    await setup();
    expect(ids('對話')).toEqual(expect.arrayContaining(['s-quiet']));
    for (const id of ['s-plan-notes', 's-research', 's-old', 's-old-child', 's-older']) {
      expect(ids('對話')).not.toContain(id);
      expect(ids('釘選')).not.toContain(id);
    }
    expect(ids('釘選')).toEqual(['s-handoff-codex']);
    expect(within(region('釘選')!).getByText('1', { selector: '.v4-count' })).toBeTruthy();
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('false');
    expect(within(region('已封存')!).getByText('3', { selector: '.v4-count' })).toBeTruthy();
    expect(ids('已封存')).toEqual([]);
  });

  it('open: tops by the newest time of the whole tree (s-old\'s child is newer than s-older); children folded', async () => {
    await setup();
    toggleArchived();
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('true');
    expect(ids('已封存')).toEqual(['s-plan-notes', 's-old', 's-older']);
    fireEvent.click(within(region('已封存')!).getByRole('button', { name: '展開 舊對話' }));
    expect(ids('已封存')).toEqual(['s-plan-notes', 's-old', 's-old-child', 's-older']);
  });

  it('the heading marks a running session in it (★D) and an open escalation from it; neither when there is none', async () => {
    await setup();
    expect(within(region('已封存')!).getByRole('img', { name: '已封存的項目裡有工作正在進行' })).toBeTruthy();
    expect(within(region('已封存')!).queryByRole('img', { name: '已封存的項目有待處理項目' })).toBeNull();
    emit({ type: 'escalation.updated', escalation: openEscalation('esc-old', 's-old-child', 's-old') });
    expect(within(region('已封存')!).getByRole('img', { name: '已封存的項目有待處理項目' })).toBeTruthy();
    emit({ type: 'session.updated', session: { ...sessionNow('s-research'), activity: 'idle', revision: revisionOf('s-research') + 1 } });
    expect(within(region('已封存')!).queryByRole('img', { name: '已封存的項目裡有工作正在進行' })).toBeNull();
  });

  it('follows session.updated: archived by the backend (auto-archive) moves to the section; unarchived moves back', async () => {
    await setup();
    emit({ type: 'session.updated', session: { ...sessionNow('s-quiet'), archivedAt: at, revision: revisionOf('s-quiet') + 1 } as LogicalSession });
    expect(ids('對話')).not.toContain('s-quiet');
    expect(within(region('已封存')!).getByText('4', { selector: '.v4-count' })).toBeTruthy();
    const old = { ...sessionNow('s-old') } as LogicalSession & { archivedAt?: string };
    delete old.archivedAt;
    emit({ type: 'session.updated', session: { ...old, revision: old.revision + 1 } });
    // Its child's pin was left behind: unarchived, it shows pinned again (nothing is pinned again by the backend, T059).
    expect(ids('對話')).toContain('s-old');
    expect(ids('釘選')).toContain('s-old-child');
  });

  it('no archived item: no section', async () => {
    loadData(Snapshot.parse({ ...fixtureSnapshot }));
    await setup();
    expect(region('已封存')).toBeNull();
  });

  it('search finds archived sessions (a child, a node of an archived run) with the 已封存 mark; others without', async () => {
    await setup();
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '對話' } });
    const tags = (id: string) => Array.from(document.querySelectorAll(`[data-session-id="${id}"] .v4-row-tag`)).map(item => item.textContent);
    expect(tags('s-old-child')).toEqual(['已封存']);
    expect(tags('s-quiet')).toEqual([]);
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'Review（Claude）' } });
    expect(tags('s-docs-rev-claude')).toEqual(['文件 review', '已封存']);
  });
});

describe('the 已封存 section (Workflow mode)', () => {
  it('an archived run is only there, also with its run and node pins left behind; marked running', async () => {
    await setup();
    toWorkflow();
    expect(ids('執行')).not.toContain('inst-docs');
    expect(region('釘選')).toBeNull();
    expect(within(region('已封存')!).getByText('1', { selector: '.v4-count' })).toBeTruthy();
    expect(within(region('已封存')!).getByRole('img', { name: '已封存的項目裡有工作正在進行' })).toBeTruthy();
    toggleArchived();
    expect(ids('已封存')[0]).toBe('inst-docs');
    // Its node pinned before (left behind) is listed under the run, not lost.
    fireEvent.click(within(region('已封存')!).getByRole('button', { name: '展開 文件 review' }));
    expect(ids('已封存')).toContain('s-docs-rev-claude');
  });
});

describe('the open state is kept (T054 way)', () => {
  it('each mode by itself, in localStorage, read again on the next start; a broken value is closed', async () => {
    await setup();
    toggleArchived();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(ARCHIVED_OPEN_KEY) ?? 'null')).toEqual({ chat: true, workflow: false }));
    cleanup(); rendererStore(fake.bridge).dispose();
    loadData(archivedData());
    await setup();
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('true');
    toWorkflow();
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('false');
    cleanup(); rendererStore(fake.bridge).dispose();
    localStorage.setItem(ARCHIVED_OPEN_KEY, '{broken');
    loadData(archivedData());
    await setup();
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('false');
  });

  it('nothing is written before the user opens or closes a section', async () => {
    await setup();
    await act(() => new Promise<void>(resolve => { setTimeout(resolve, 600); }));
    expect(localStorage.getItem(ARCHIVED_OPEN_KEY)).toBeNull();
  });

  it('the demo neither reads nor writes it', async () => {
    delete window.awg;
    localStorage.setItem(ARCHIVED_OPEN_KEY, JSON.stringify({ chat: true, workflow: true }));
    render(<App snapshot={archivedData()} />);
    expect(archivedHeading().getAttribute('aria-expanded')).toBe('false');
    toggleArchived();
    await act(() => new Promise<void>(resolve => { setTimeout(resolve, 600); }));
    expect(JSON.parse(localStorage.getItem(ARCHIVED_OPEN_KEY)!)).toEqual({ chat: true, workflow: true });
  });
});

describe('封存／取消封存 in the menu', () => {
  it('only a top conversation and a run have it; a child and a node session do not', async () => {
    await setup();
    expect(archiveItem('s-quiet')).toEqual({ label: '封存', disabled: false, title: '' });
    toggleArchived();
    expect(archiveItem('s-old')).toEqual({ label: '取消封存', disabled: false, title: '' });
    fireEvent.click(within(region('已封存')!).getByRole('button', { name: '展開 舊對話' }));
    expect(archiveItem('s-old-child')).toBeUndefined();
    toWorkflow();
    toggleArchived(); // each mode has its own section, closed
    expect(archiveItem('inst-docs', 'run')).toEqual({ label: '取消封存', disabled: false, title: '' });
    expect(archiveItem('inst-login', 'run')?.label).toBe('封存');
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '登入功能' } });
    expect(archiveItem('s-wf-root')).toBeUndefined();
  });

  it('disabled with the reason the Snapshot shows: a running turn, an open escalation, a run not ended', async () => {
    loadData(archivedData(s => ({ sessions: s.sessions.map(session => session.id === 's-plan-notes' ? { ...session, archivedAt: undefined } : session) })));
    await setup();
    expect(archiveItem('s-plan-notes')).toEqual({ label: '封存', disabled: true, title: '有工作正在進行，結束後才能封存。' });
    emit({ type: 'escalation.updated', escalation: openEscalation('esc-q', 's-quiet', 's-quiet') });
    expect(archiveItem('s-quiet')).toEqual({ label: '封存', disabled: true, title: '有待處理的項目，處理後才能封存。' });
    toWorkflow();
    expect(archiveItem('inst-login', 'run')).toEqual({ label: '封存', disabled: true, title: '這次執行還沒結束，結束後才能封存。' });
    fireEvent.click(openMenu('inst-login', 'run').getByRole('menuitem', { name: '封存' }));
    expect(archiveCommands()).toEqual([]);
  });

  it('sends session.archive with the top session\'s revision in the latest Snapshot; the list follows the event', async () => {
    await setup();
    const menu = openMenu('s-quiet');
    // A newer revision arrives while the menu is open: the command carries it.
    emit({ type: 'session.updated', session: { ...sessionNow('s-quiet'), title: '安靜的對話（改）', revision: revisionOf('s-quiet') + 1 } });
    fake.data.snapshot = { ...fake.data.snapshot, sessions: fake.data.snapshot.sessions.map(session => session.id === 's-quiet' ? { ...session, revision: session.revision + 1 } : session) };
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    fireEvent.click(menu.getByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(archiveCommands()).toHaveLength(1));
    expect(archiveCommands()[0]).toMatchObject({ type: 'session.archive', sessionId: 's-quiet', expectedRevision: revisionOf('s-quiet') });
    expect(ids('對話')).toContain('s-quiet');
    emit({ type: 'session.updated', session: { ...sessionNow('s-quiet'), archivedAt: at, revision: revisionOf('s-quiet') + 1 } as LogicalSession });
    expect(ids('對話')).not.toContain('s-quiet');
  });

  it('while it is on its way the item says so; an uncertain result keeps it disabled with the check note', async () => {
    await setup();
    const reply = deferred<CommandResult>();
    fake.bridge.send.mockImplementation(() => reply.promise);
    fireEvent.click(openMenu('s-quiet').getByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(archiveItem('s-quiet')).toEqual({ label: '封存', disabled: true, title: '正在封存…' }));
    reply.resolve({ ok: false, requestId: archiveCommands()[0]!.requestId, code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true });
    await waitFor(() => expect(archiveItem('s-quiet')).toEqual({ label: '封存', disabled: true, title: ARCHIVE_UNCERTAIN }));
  });

  it('the backend\'s answer has the last word: a reason the Snapshot could not show is said in words', async () => {
    await setup();
    refuse('invalid_transition', { reason: 'turn-running', retryable: true });
    fireEvent.click(openMenu('s-quiet').getByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(notice()).toBe('沒有封存：有工作正在進行，結束後才能封存。'));
    refuse('invalid_transition');
    fireEvent.click(openMenu('s-quiet').getByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(notice()).toBe('沒有封存：目前狀態不允許此操作。'));
  });

  it('stale_revision: the T053 words, never sent again on its own; a run has its own words', async () => {
    await setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    refuse('stale_revision');
    fireEvent.click(openMenu('s-quiet').getByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(notice()).toBe(STALE_MOVE));
    await act(async () => { await vi.advanceTimersByTimeAsync(LONG_WAIT); });
    expect(archiveCommands()).toHaveLength(1);
    toWorkflow();
    toggleArchived();
    fireEvent.click(openMenu('inst-docs', 'run').getByRole('menuitem', { name: '取消封存' }));
    await waitFor(() => expect(notice()).toBe(STALE_RUN));
    expect(archiveCommands()[1]).toMatchObject({ type: 'workflow.unarchive', instanceId: 'inst-docs', expectedRevision: fake.data.snapshot.instances.find(item => item.id === 'inst-docs')!.revision });
  });

  it('an archived item is not pinned (a pin left behind can be taken away); it does not move', async () => {
    await setup();
    toggleArchived();
    expect(menuItems('s-old').find(item => item.label === '釘選')).toEqual({ label: '釘選', disabled: true, title: ARCHIVED_PIN });
    expect(menuItems('s-older').find(item => item.label === '取消釘選')?.disabled).toBe(false);
    expect(menuItems('s-old').filter(item => item.label?.startsWith('移到'))).toEqual([{ label: '移到…底下', disabled: true, title: ARCHIVED_MOVE }]);
  });

  it('read-only: both items and the banner are disabled with the read-only reason; nothing is sent', async () => {
    loadData(archivedData(() => ({ app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } })));
    window.history.replaceState(null, '', '/#/sessions/s-old');
    await setup();
    expect(archiveItem('s-quiet')).toEqual({ label: '封存', disabled: true, title: readOnlyProps(true).title });
    toggleArchived();
    expect(archiveItem('s-old')).toEqual({ label: '取消封存', disabled: true, title: readOnlyProps(true).title });
    const banner = screen.getByRole('button', { name: '取消封存' });
    expect(banner).toHaveProperty('disabled', true);
    fireEvent.click(banner);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});

describe('the archived banner', () => {
  it('on a session below an archived top: 取消封存 sends the top\'s id and revision', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-old-child');
    await setup();
    const status = screen.getByText(/這個對話已封存。送出訊息會自動取消封存。/);
    expect(status.closest('[role="status"]')).toBeTruthy();
    // Its tree is unfolded in the section (the open session is inside); the others stay folded.
    toggleArchived();
    expect(ids('已封存')).toEqual(['s-plan-notes', 's-old', 's-old-child', 's-older']);
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    fireEvent.click(screen.getByRole('button', { name: '取消封存' }));
    await waitFor(() => expect(archiveCommands()).toHaveLength(1));
    expect(archiveCommands()[0]).toMatchObject({ type: 'session.unarchive', sessionId: 's-old', expectedRevision: revisionOf('s-old') });
    // The banner goes with the event.
    const old = { ...sessionNow('s-old') } as LogicalSession & { archivedAt?: string };
    delete old.archivedAt;
    emit({ type: 'session.updated', session: { ...old, revision: old.revision + 1 } });
    expect(screen.queryByText(/這個對話已封存/)).toBeNull();
  });

  it('on a node session of an archived run: the run\'s words, workflow.unarchive with the run', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-docs-rev-claude');
    await setup();
    expect(screen.getByText(/這次執行已封存。/)).toBeTruthy();
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    fireEvent.click(screen.getByRole('button', { name: '取消封存' }));
    await waitFor(() => expect(archiveCommands()).toEqual([expect.objectContaining({ type: 'workflow.unarchive', instanceId: 'inst-docs' })]));
  });

  it('the input still sends: session.send to that session with its own revision, nothing else (the backend unarchives)', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-old-child');
    await setup();
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    fireEvent.change(screen.getByRole('textbox', { name: /訊息|回覆/ }), { target: { value: '再看一次' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ type: 'session.send', sessionId: 's-old-child', expectedRevision: revisionOf('s-old-child'), text: '再看一次' });
    expect(archiveCommands()).toEqual([]);
  });

  it('a session not archived has no banner', async () => {
    await setup();
    expect(screen.queryByText(/已封存。送出訊息/)).toBeNull();
  });
});

describe('moves and drags leave archived trees out', () => {
  it('the picker offers no session of an archived tree', async () => {
    await setup();
    fireEvent.click(openMenu('s-quiet').getByRole('menuitem', { name: '移到…底下' }));
    const options = within(screen.getByRole('dialog')).queryAllByRole('option').map(option => option.textContent ?? '');
    expect(options.some(text => /^(舊對話|更舊的對話|參考資料整理|規劃想法(?!（))/.test(text))).toBe(false);
    expect(options.some(text => text.startsWith('規劃想法（轉交 Codex）'))).toBe(true);
  });

  it('an archived row is no drag source and no drop place', async () => {
    await setup();
    toggleArchived();
    expect(rowButton('s-old').getAttribute('draggable')).not.toBe('true');
    const items = new Map<string, string>();
    const dataTransfer = { get types() { return [...items.keys()]; }, getData: (type: string) => items.get(type) ?? '', setData: (type: string, value: string) => { items.set(type, value); },
      dropEffect: 'none', effectAllowed: 'uninitialized', files: [] as File[], items: [] as unknown[] };
    fireEvent.dragStart(rowButton('s-quiet'), { dataTransfer });
    await act(() => new Promise<void>(resolve => { setTimeout(resolve, 0); }));
    expect(items.has(SESSION_DRAG_TYPE)).toBe(true);
    const target = document.querySelector('.v4-sidebar [data-session-id="s-old"] > .v4-row')!;
    const over = createEvent.dragOver(target, { dataTransfer });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(false);
    fireEvent(target, createEvent.drop(target, { dataTransfer }));
    expect(sent().filter(command => command.type === 'session.reparent')).toEqual([]);
  });
});

describe('the auto-archive setting', () => {
  const settings = async (snapshot = archivedData()) => {
    loadData(snapshot);
    window.history.replaceState(null, '', '/#/settings');
    await setup();
    return { box: screen.getByRole<HTMLInputElement>('checkbox', { name: /自動封存/ }), days: screen.getByRole<HTMLInputElement>('spinbutton', { name: '自動封存天數' }), save: screen.getByRole<HTMLButtonElement>('button', { name: '儲存天數' }) };
  };
  const prefs = () => sent().flatMap(command => command.type === 'preferences.set' ? [command.preferences] : []);
  /** preferences.set is accepted and announced, as the service does. */
  const announce = () => fake.bridge.send.mockImplementation(input => {
    const command = Command.parse(input);
    if (command.type === 'preferences.set') queueMicrotask(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'preferences.updated', preferences: command.preferences, at } }));
    return Promise.resolve(accepted(input));
  });

  it('absent is 14 and on; a new number is saved with the whole latest preferences (pins changed meanwhile too)', async () => {
    const { box, days, save } = await settings();
    expect(box.checked).toBe(true);
    expect(days.value).toBe('14');
    expect(save.disabled).toBe(true);
    // The archive took a pin away after the page was drawn: the save must not put it back (T059 §6-5).
    const latest = UiPreferences.parse({ ...fake.data.snapshot.preferences, pinned: { chat: ['s-handoff-codex'], workflow: [] } });
    emit({ type: 'preferences.updated', preferences: latest, at });
    announce();
    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.click(save);
    await waitFor(() => expect(prefs()).toEqual([{ ...latest, autoArchiveDays: 30 }]));
    await waitFor(() => expect(screen.getByText('已儲存。')).toBeTruthy());
  });

  it('turned off: null at once; off shows the days disabled; on again sends the days shown (or 14)', async () => {
    const { box } = await settings();
    announce();
    fireEvent.click(box);
    await waitFor(() => expect(prefs().at(-1)).toMatchObject({ autoArchiveDays: null }));
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /自動封存/ }).checked).toBe(false));
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '自動封存天數' }).disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /自動封存/ }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: /自動封存/ }));
    await waitFor(() => expect(prefs().at(-1)).toMatchObject({ autoArchiveDays: 14 }));
  });

  it('reads a saved number and null', async () => {
    const { days } = await settings(archivedData(s => ({ preferences: { ...s.preferences, autoArchiveDays: 45 } })));
    expect(days.value).toBe('45');
    cleanup(); rendererStore(fake.bridge).dispose();
    const off = await settings(archivedData(s => ({ preferences: { ...s.preferences, autoArchiveDays: null } })));
    expect(off.box.checked).toBe(false);
    expect(off.days.disabled).toBe(true);
  });

  it.each(['0', '366', '1.5', '', 'abc'])('%j is refused: the range note, nothing sent', async value => {
    const { days, save } = await settings();
    fireEvent.change(days, { target: { value } });
    expect(screen.getByText(AUTO_ARCHIVE_RANGE).getAttribute('role')).toBe('alert');
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(prefs()).toEqual([]);
  });

  it('read-only: all disabled, nothing sent', async () => {
    const { box, days, save } = await settings(archivedData(() => ({ app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } })));
    expect([box.disabled, days.disabled, save.disabled]).toEqual([true, true, true]);
    fireEvent.click(box);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});
