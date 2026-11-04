// @vitest-environment jsdom
// T053 (WB-04): the sidebar menu's 「移到…底下」／「移到最上層」 in the connected v0.4 shell, sending session.reparent.
// Fixture tree: 規劃想法 (s-plan-notes) → 參考資料整理 (s-research); 規劃想法（轉交 Codex） (s-handoff-codex) on top.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId } from '../../../../contracts';
import type { AppEvent, CommandResult, ErrorCode, LogicalSession, Message } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { rendererStore } from '../renderer-store';
import { readOnlyProps } from '../read-only';
import { deferred, fakeBridge } from '../ipc-test-helpers';
import { STALE_MOVE } from './ShellV4';

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const byId = (id: string) => fixtureSnapshot.sessions.find(session => session.id === id)!;
const plan = byId('s-plan-notes'); const research = byId('s-research'); const handoff = byId('s-handoff-codex');
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge; seq = fixtureSnapshot.seq;
  window.history.replaceState(null, '', `/#/sessions/${plan.id}`); localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

async function setup() { render(<App />); await screen.findByText('IPC 已連線'); }
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const rowButton = (id: string) => document.querySelector<HTMLButtonElement>(`.v4-sidebar [data-session-id="${id}"] .v4-session`)!;
const openMenu = (id: string) => { fireEvent.contextMenu(rowButton(id)); return within(screen.getByRole('menu')); };
const moveItems = (id: string) => {
  const items = openMenu(id).getAllByRole<HTMLButtonElement>('menuitem').filter(item => item.textContent?.startsWith('移到'));
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  return items.map(item => ({ label: item.textContent, disabled: item.disabled, title: item.title }));
};
const choose = (id: string, label: string) => fireEvent.click(openMenu(id).getByRole('menuitem', { name: label }));
const picker = () => within(screen.getByRole('dialog'));
const searchBox = () => picker().getByRole<HTMLInputElement>('combobox', { name: '搜尋對話' });
const options = () => picker().queryAllByRole('option').map(option => option.textContent);
const reparents = () => fake.bridge.send.mock.calls.map(([input]) => Command.parse(input)).filter(command => command.type === 'session.reparent');
const answer = (code: ErrorCode, mayHaveSideEffects = false) => fake.bridge.send.mockImplementation(input =>
  Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code, message: '', retryable: false, mayHaveSideEffects }));
const accepted = (input: { requestId: string }): CommandResult => ({ ok: true, requestId: RequestId.parse(input.requestId), created: [] });
/** Extra top-level ordinary sessions; newer createdAt than the fixture's, so they come first in the picker. */
const addSessions = (...items: Array<[id: string, title: string, createdAt: string]>) => {
  const added = items.map(([id, title, createdAt]) => {
    const session = { ...handoff, id, title, createdAt, updatedAt: createdAt } as LogicalSession;
    delete session.parentId;
    return session;
  });
  fake.data.snapshot = { ...fake.data.snapshot, sessions: [...fake.data.snapshot.sessions, ...added] };
};
/** Longer than the store's command time-out (15 s), so a delayed resend or local update would have happened. */
const LONG_WAIT = 20_000;
const parentRowOf = (id: string) => document.querySelector(`.v4-sidebar [data-session-id="${id}"]`)?.parentElement?.closest('li')?.getAttribute('data-session-id') ?? null;

describe('T053 menu items (WB-04)', () => {
  it('a top-level ordinary session has only 移到…底下; one with a parent also has 移到最上層', async () => {
    await setup();
    expect(moveItems(plan.id).map(item => item.label)).toEqual(['移到…底下']);
    expect(moveItems(research.id).map(item => item.label)).toEqual(['移到…底下', '移到最上層']);
    expect(moveItems(research.id).every(item => !item.disabled)).toBe(true);
  });

  it('workflow runs and node sessions have neither; an ordinary session in a search result has them in either mode (Q2)', async () => {
    await setup();
    fireEvent.click(sidebar().getByRole('button', { name: /^Workflow/ }));
    fireEvent.contextMenu(document.querySelector<HTMLButtonElement>('.v4-sidebar [data-run-id] .v4-session')!);
    expect(within(screen.getByRole('menu')).queryAllByRole('menuitem').map(item => item.textContent)).not.toContain('移到…底下');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '登入功能' } });
    expect(moveItems('s-wf-root')).toEqual([]);
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '參考資料' } });
    expect(moveItems(research.id).map(item => item.label)).toEqual(['移到…底下', '移到最上層']);
  });

  it('read-only: both are disabled with the read-only reason and send nothing', async () => {
    fake = fakeBridge({ ...fixtureSnapshot, app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } }); window.awg = fake.bridge;
    await setup();
    expect(moveItems(research.id)).toEqual([
      { label: '移到…底下', disabled: true, title: readOnlyProps(true).title },
      { label: '移到最上層', disabled: true, title: readOnlyProps(true).title },
    ]);
    fireEvent.click(openMenu(research.id).getByRole('menuitem', { name: '移到最上層' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});

describe('T053 picker', () => {
  it('lists the other ordinary sessions only: not itself, not below it, not its current parent', async () => {
    await setup();
    choose(plan.id, '移到…底下');
    expect(picker().getByRole('heading', { name: `把「${plan.title}」移到…底下` })).toBeTruthy();
    expect(options()).toEqual([handoff.title]);
    fireEvent.click(picker().getByRole('button', { name: '取消' }));
    choose(research.id, '移到…底下');
    expect(options()).toEqual([handoff.title]);
  });

  it('says so when nothing can be chosen', async () => {
    fake.data.snapshot = { ...fake.data.snapshot, sessions: fake.data.snapshot.sessions.map(session => session.id === handoff.id ? { ...session, parentId: plan.id } : session) };
    await setup();
    choose(plan.id, '移到…底下');
    expect(picker().getByText('沒有可以移過去的對話')).toBeTruthy();
    expect(options()).toEqual([]);
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('sorts by the last message and filters by title; no match shows the empty note', async () => {
    addSessions(['s-new-a', '新的 Alpha', '2026-11-04T01:00:00.000Z'], ['s-new-b', '新的 Beta', '2026-11-04T02:00:00.000Z']);
    await setup();
    choose(research.id, '移到…底下');
    expect(options()).toEqual(['新的 Beta', '新的 Alpha', handoff.title]);
    fireEvent.change(searchBox(), { target: { value: ' alpha ' } });
    expect(options()).toEqual(['新的 Alpha']);
    fireEvent.change(searchBox(), { target: { value: '沒有這個' } });
    expect(picker().getByText('沒有可以移過去的對話')).toBeTruthy();
  });

  it('r1 P2-2: the default choice is kept by ID when another session gets a newer message and moves first', async () => {
    addSessions(['s-new-a', '新的 Alpha', '2026-11-04T02:00:00.000Z'], ['s-new-b', '新的 Beta', '2026-11-04T01:00:00.000Z']);
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    choose(research.id, '移到…底下');
    const selected = () => picker().getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true')?.textContent;
    expect(options()).toEqual(['新的 Alpha', '新的 Beta', handoff.title]);
    expect(selected()).toBe('新的 Alpha');
    emit({ type: 'message.completed', message: { ...fixtureSnapshot.messages[0]!, id: 'm-new-b', sessionId: 's-new-b', createdAt: '2026-11-04T03:00:00.000Z' } as Message });
    expect(options()).toEqual(['新的 Beta', '新的 Alpha', handoff.title]);
    expect(selected()).toBe('新的 Alpha');
    expect(searchBox().getAttribute('aria-activedescendant')).toBe(picker().getByRole('option', { name: '新的 Alpha' }).id);
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ parentId: 's-new-a' });
  });

  it('works by keyboard: ↓↑ choose, Enter sends the chosen parent with the latest revision', async () => {
    addSessions(['s-new-a', '新的 Alpha', '2026-11-04T01:00:00.000Z'], ['s-new-b', '新的 Beta', '2026-11-04T02:00:00.000Z']);
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    emit({ type: 'session.updated', session: { ...research, revision: research.revision + 3 } });
    choose(research.id, '移到…底下');
    const box = searchBox();
    expect(document.activeElement).toBe(box);
    const selected = () => picker().getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true')!;
    expect(selected().textContent).toBe('新的 Beta');
    expect(box.getAttribute('aria-activedescendant')).toBe(selected().id);
    fireEvent.keyDown(box, { key: 'ArrowDown' }); fireEvent.keyDown(box, { key: 'ArrowDown' }); fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected().textContent).toBe(handoff.title);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(selected().textContent).toBe('新的 Alpha');
    expect(box.getAttribute('aria-activedescendant')).toBe(selected().id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ sessionId: research.id, parentId: 's-new-a', expectedRevision: research.revision + 3 });
  });

  it('Esc closes without sending and gives focus back to the row', async () => {
    await setup();
    choose(plan.id, '移到…底下');
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(rowButton(plan.id));
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('r1 P2-1: closes the modal first and gives focus back only after the picker is gone (Esc, cancel, a choice)', async () => {
    const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
    const saved = { showModal: proto.showModal, close: proto.close };
    const log: string[] = [];
    // A modal like the browser's: open while shown, and the page behind it does not take focus.
    proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); log.push('showModal'); };
    proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); log.push('close'); };
    const realFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')!.value as (this: HTMLElement) => void;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      const modal = document.querySelector('dialog[open]');
      if (modal && !modal.contains(this)) { log.push('focus ignored'); return; }
      if (this.classList.contains('v4-session')) log.push(`focus row ${document.querySelector('dialog') ? 'with dialog' : 'after dialog'}`);
      realFocus.call(this);
    });
    try {
      fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
      await setup();
      const leave: Array<() => void> = [
        () => fireEvent.keyDown(searchBox(), { key: 'Escape' }),
        () => fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true })),
        () => fireEvent.keyDown(searchBox(), { key: 'Enter' }),
      ];
      for (const exit of leave) {
        choose(plan.id, '移到…底下');
        log.length = 0;
        exit();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(log).toEqual(['close', 'focus row after dialog']);
      }
    } finally {
      focus.mockRestore();
      for (const key of ['showModal', 'close'] as const) { if (saved[key]) proto[key] = saved[key]; else delete proto[key]; }
    }
  });

  it('shows titles as plain text (T042)', async () => {
    addSessions(['s-evil', '<img src=x onerror="alert(1)">\u0007<b>粗</b>', '2026-11-04T01:00:00.000Z']);
    await setup();
    choose(plan.id, '移到…底下');
    expect(options()).toContain('<img src=x onerror="alert(1)">\u0007<b>粗</b>');
    expect(screen.getByRole('dialog').querySelector('img, b')).toBeNull();
  });
});

describe('T053 sending session.reparent', () => {
  it('移到最上層 sends parentId null with the latest revision', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    choose(research.id, '移到最上層');
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ sessionId: research.id, parentId: null, expectedRevision: research.revision });
  });

  it.each(['stale_revision', 'not_found', 'invalid_request'] as const)('%s: says the conversation just changed and never sends again (Q1)', async code => {
    answer(code);
    await setup();
    // r1 P2-3: a fake clock from the send on, moved past any retry delay and the store's 15 s time-out.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    choose(research.id, '移到最上層');
    expect(await screen.findByText(STALE_MOVE)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(LONG_WAIT); });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    expect(screen.getByText(STALE_MOVE)).toBeTruthy();
    // Nothing stays blocked: the user can try again by hand.
    expect(moveItems(research.id).every(item => !item.disabled)).toBe(true);
  });

  it('other refusals say why, with the general words', async () => {
    answer('storage_failed');
    await setup();
    choose(research.id, '移到最上層');
    expect(await screen.findByText(/^沒有移動：儲存失敗/)).toBeTruthy();
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('while in flight the row\'s two items are disabled and a second choice sends nothing; another row can still move', async () => {
    const pending = deferred<CommandResult>();
    let requestId = '';
    fake.bridge.send.mockImplementation(input => { if (input.type === 'session.reparent' && input.sessionId === research.id) { requestId = input.requestId; return pending.promise; } return Promise.resolve(accepted(input)); });
    await setup();
    choose(research.id, '移到…底下');
    const option = picker().getByRole('option', { name: handoff.title });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    // A second Enter or click in the same moment finds no picker any more.
    fireEvent.click(option);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(moveItems(research.id)).toEqual([
      { label: '移到…底下', disabled: true, title: '正在移動這個對話…' },
      { label: '移到最上層', disabled: true, title: '正在移動這個對話…' },
    ]);
    fireEvent.click(openMenu(research.id).getByRole('menuitem', { name: '移到最上層' }));
    expect(reparents()).toHaveLength(1);
    // A different session moves on its own.
    choose(plan.id, '移到…底下');
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    await waitFor(() => expect(reparents()).toHaveLength(2));
    expect(reparents()[1]).toMatchObject({ sessionId: plan.id, parentId: handoff.id });
    await act(async () => { pending.resolve({ ok: true, requestId: RequestId.parse(requestId), created: [] }); await pending.promise; });
    await waitFor(() => expect(moveItems(research.id).every(item => !item.disabled)).toBe(true));
  });

  it('a success changes nothing by itself: the tree follows session.updated', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    expect(parentRowOf(research.id)).toBe(plan.id);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    choose(research.id, '移到最上層');
    await waitFor(() => expect(reparents()).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(LONG_WAIT); });
    expect(parentRowOf(research.id)).toBe(plan.id);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    const moved = { ...research, revision: research.revision + 1 };
    delete moved.parentId;
    emit({ type: 'session.updated', session: moved });
    expect(parentRowOf(research.id)).toBeNull();
    expect(moveItems(research.id).map(item => item.label)).toEqual(['移到…底下']);
  });

  it('an unconfirmed result keeps the row blocked until checked, and is never sent again', async () => {
    answer('unknown_outcome', true);
    await setup();
    choose(research.id, '移到最上層');
    expect(await screen.findByText(/^沒有移動：結果未知/)).toBeTruthy();
    const reason = '上次移動的結果無法確認，請到設定頁「待核對操作」核對後再試。';
    expect(moveItems(research.id)).toEqual([
      { label: '移到…底下', disabled: true, title: reason },
      { label: '移到最上層', disabled: true, title: reason },
    ]);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('checks the choice again against the latest Snapshot: a move it no longer allows is not sent', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const item = openMenu(research.id).getByRole('menuitem', { name: '移到最上層' });
    // The store already has the update; the menu on screen was drawn before it.
    const moved = { ...research, revision: research.revision + 1 };
    delete moved.parentId;
    fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: moved } });
    fireEvent.click(item);
    expect(await screen.findByText(STALE_MOVE)).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});
