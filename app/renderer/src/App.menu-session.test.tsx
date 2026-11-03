// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId } from '../../../contracts';
import type { AppEvent, CommandResult, LogicalSession, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import { INTERRUPT_WAIT_MS, rendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const original = fixtureSnapshot.sessions[0]!;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge; seq = fixtureSnapshot.seq;
  window.history.replaceState(null, '', '/#/workbench'); localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
async function setup() { render(<App />); await screen.findByText('IPC 已連線'); }
const shortcut = (key: string, shiftKey = false, target: HTMLElement | Window = window) => fireEvent.keyDown(target, { key, ctrlKey: key !== 'F5', shiftKey });
function fillCreate() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: fixtureSnapshot.agents[0]!.id } });
  const model = fixtureSnapshot.modelOptions.find(item => !item.hidden)!;
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: `${model.runtime}:${model.model}` } });
  fireEvent.change(screen.getByLabelText('工作資料夾'), { target: { value: 'E:\\work' } });
}
const createButton = () => screen.getByRole<HTMLButtonElement>('button', { name: '建立 session' });
function newSession(command: Extract<Command, { type: 'session.create' }>, revision: number): LogicalSession {
  const base = fixtureSnapshot.sessions.find(item => item.kind === 'ordinary')!;
  return { ...base, id: command.sessionId, title: '新建對話', revision, ...(command.agentId !== undefined && { agent: { id: command.agentId, revision: 1 } }), requestedModel: command.model, activity: 'idle', cwd: command.cwd ?? 'E:/work/auto' };
}

describe('T027 app menu', () => {
  it('opens by keyboard, navigates actions, closes with Escape/outside and restores focus', async () => {
    await setup();
    const trigger = screen.getByRole('button', { name: '應用程式選單' });
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: '應用程式選單' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: '新增 session Ctrl+N' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: '啟動 Workflow Ctrl+Shift+N' }));
    fireEvent.keyDown(menu, { key: 'End' }); expect(document.activeElement?.textContent).toBe('關於');
    fireEvent.keyDown(menu, { key: 'Home' }); fireEvent.keyDown(menu, { key: 'ArrowUp' }); expect(document.activeElement?.textContent).toBe('關於');
    fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'Enter' }); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    expect(screen.getByRole('heading', { name: '新增 session' })).toBeTruthy();
  });

  it('routes every shortcut, keeps normal editing keys, and reloads the Snapshot', async () => {
    await setup();
    const draft = screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` });
    expect(fireEvent.keyDown(draft, { key: 'n' })).toBe(true);
    shortcut('n', false, draft); expect(screen.getByRole('heading', { name: '新增 session' })).toBeTruthy();
    shortcut('N', true, screen.getByLabelText('工作資料夾')); expect(screen.getByRole('heading', { name: '啟動 Workflow' })).toBeTruthy();
    shortcut('2'); expect(screen.getByRole('heading', { level: 1, name: 'Workflow 編輯器' })).toBeTruthy();
    shortcut('3'); expect(screen.getByRole('heading', { level: 1, name: 'Agent 管理' })).toBeTruthy();
    shortcut('1'); expect(screen.getByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
    shortcut('t'); expect(document.querySelectorAll('[data-workspace]')).toHaveLength(2);
    shortcut('t'); expect(document.querySelectorAll('[data-workspace]')).toHaveLength(2);
    shortcut('F5'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('ignores repeated Enter on the trigger and menu items', async () => {
    await setup();
    const trigger = screen.getByRole('button', { name: '應用程式選單' });
    fireEvent.keyDown(trigger, { key: 'Enter', repeat: true });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', repeat: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '新增 session' })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: '新增 session' })).toBeTruthy();
  });

  it('uses physical shortcut codes with a non-Latin key, but ignores IME composition', async () => {
    await setup();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('heading', { name: '新增 session' })).toBeNull();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true });
    expect(screen.getByRole('heading', { name: '新增 session' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ㄇ', code: 'Digit3', ctrlKey: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Agent 管理' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('heading', { name: '啟動 Workflow' })).toBeTruthy();
  });

  it('uses getAppInfo for About, restores focus, changes themes via preferences and closes the window', async () => {
    fake.bridge.getAppInfo.mockResolvedValue({ name: '真實應用程式', version: '9.8.7' });
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'preferences.set') fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'preferences.updated', preferences: command.preferences, at: original.updatedAt } });
      return { ok: true, requestId: command.requestId, created: [] };
    });
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    await setup();
    click('應用程式選單');
    expect(screen.getByRole('menuitemradio', { name: '深色主題' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '深色主題' }));
    expect(fake.bridge.send).not.toHaveBeenCalled();
    for (const [name, theme] of [['淺色主題', 'light'], ['深色主題', 'dark']] as const) {
      click('應用程式選單');
      expect(screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked')).toBe('false');
      fireEvent.click(screen.getByRole('menuitemradio', { name }));
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe(theme));
      click('應用程式選單');
      expect(screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByRole('menuitemradio', { name }));
    }
    expect(new Set(fake.bridge.send.mock.calls.map(([input]) => input.requestId)).size).toBe(2);
    click('應用程式選單'); fireEvent.click(screen.getByRole('menuitem', { name: '關於' }));
    const dialog = screen.getByRole('dialog'); await within(dialog).findByText(/版本 9.8.7/);
    expect(dialog.textContent).toContain('真實應用程式'); expect(dialog.textContent).toContain('Apache-2.0');
    shortcut('n'); expect(screen.queryByRole('heading', { name: '新增 session' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: '應用程式選單' }));
    click('應用程式選單'); fireEvent.click(screen.getByRole('menuitem', { name: '結束' })); expect(close).toHaveBeenCalledTimes(1);
  });

  it('disables command actions and shortcuts when damaged but keeps reload and About', async () => {
    fake.data.snapshot.app = { status: 'damaged', reason: 'test', location: 'E:\\db' };
    render(<App />); await screen.findByRole('heading', { name: '資料損壞，所有操作已停用' });
    click('應用程式選單');
    for (const name of ['新增 session Ctrl+N', '啟動 Workflow Ctrl+Shift+N']) expect(screen.getByRole<HTMLButtonElement>('menuitem', { name }).disabled).toBe(true);
    for (const name of ['深色主題', '淺色主題']) expect(screen.getByRole<HTMLButtonElement>('menuitemradio', { name }).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '新增工作區 tab Ctrl+T' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' }); expect(document.activeElement?.textContent).toBe('關於');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    shortcut('n'); shortcut('N', true); expect(fake.bridge.send).not.toHaveBeenCalled();
    shortcut('F5'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
  });
});

describe('T027 create and first send', () => {
  it('preserves all create fields across Ctrl+1/2/3, Ctrl+T and menu navigation', async () => {
    await setup(); click('新增 session'); fillCreate();
    fireEvent.change(screen.getByLabelText('上層 session（可選）'), { target: { value: original.id } });
    const values = () => ['Agent', 'Model', '工作資料夾', '上層 session（可選）'].map(name => within(screen.getByRole('region', { name: '新增 session' })).getByLabelText<HTMLInputElement | HTMLSelectElement>(name).value);
    const expected = values();
    for (const key of ['1', '2', '3', 't']) {
      shortcut(key); shortcut('n'); expect(values()).toEqual(expected);
    }
    click('應用程式選單'); fireEvent.click(screen.getByRole('menuitem', { name: 'Agent 管理 Ctrl+3' }));
    click('應用程式選單'); fireEvent.click(screen.getByRole('menuitem', { name: '新增 session Ctrl+N' }));
    expect(values()).toEqual(expected); expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('requires a successful Snapshot read and explicit confirmation before retrying a missing create with fresh IDs', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'storage_failed', message: '', retryable: true, mayHaveSideEffects: true });
    await setup(); click('新增 session'); fillCreate(); fireEvent.click(createButton());
    await screen.findByText(/（storage_failed）/);
    const first = Command.parse(fake.bridge.send.mock.calls[0]![0]); if (first.type !== 'session.create') throw new Error('wrong command');
    const confirm = '我已確認沒有建立，重新填寫';
    expect(screen.queryByRole('button', { name: confirm })).toBeNull();
    act(() => rendererStore(fake.bridge).acknowledge('session.create', `session:${first.sessionId}`));
    expect(createButton().matches(':disabled')).toBe(true);
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    click('重新讀取資料並核對'); await screen.findByText('資料同步失敗，保留上次資料');
    expect(screen.queryByRole('button', { name: confirm })).toBeNull();
    click('重新讀取資料並核對');
    const confirmation = await within(screen.getByRole('region', { name: '新增 session' })).findByRole('button', { name: confirm });
    expect(createButton().matches(':disabled')).toBe(true); expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    fireEvent.click(confirmation); expect(createButton().matches(':disabled')).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('工作資料夾').value).toBe('E:\\work');
    fireEvent.click(createButton()); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    const second = Command.parse(fake.bridge.send.mock.calls[1]![0]); if (second.type !== 'session.create') throw new Error('wrong command');
    expect(second.sessionId).not.toBe(first.sessionId); expect(second.requestId).not.toBe(first.requestId);
  });
  it('waits for a fresh Snapshot even when a timed-out create later succeeds', async () => {
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValueOnce(response.promise);
    await setup(); click('新增 session'); fillCreate();
    vi.useFakeTimers(); fireEvent.click(createButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    vi.useRealTimers(); expect(screen.getByText(/建立結果待核對/)).toBeTruthy();
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]); if (command.type !== 'session.create') throw new Error('wrong command');
    emit({ type: 'session.updated', session: newSession(command, 0) });
    expect(screen.getByText(/目前 session 資料中已有本次 ID/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '新建對話' })).toBeNull();
    const read = deferred<Snapshot>(); fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    await act(async () => { response.resolve({ ok: true, requestId: command.requestId, created: [] }); await Promise.resolve(); });
    expect(screen.queryByRole('heading', { name: '新建對話' })).toBeNull();
    await act(async () => { read.resolve({ ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, newSession(command, 1)] }); await Promise.resolve(); });
    await screen.findByRole('heading', { name: '新建對話' });
    expect(rendererStore(fake.bridge).getSnapshot().snapshot?.sessions.find(item => item.id === command.sessionId)?.revision).toBe(1);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight create protected across navigation and waits for its receipt before enabling the new composer', async () => {
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValueOnce(response.promise);
    await setup(); click('新增 session'); fillCreate(); fireEvent.click(createButton()); fireEvent.click(createButton());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]); if (command.type !== 'session.create') throw new Error('wrong command');
    shortcut('1'); shortcut('n'); expect(createButton().matches(':disabled')).toBe(true);
    emit({ type: 'session.updated', session: newSession(command, 0) });
    shortcut('1'); fireEvent.click(screen.getByRole('button', { name: /^新建對話 / }));
    fireEvent.change(screen.getByRole('textbox', { name: '傳訊息給 新建對話' }), { target: { value: '先保留' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    expect(screen.getByText(/Session 建立中；完成後才能送出/)).toBeTruthy();
    fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, newSession(command, 1)] };
    await act(async () => { response.resolve({ ok: true, requestId: command.requestId, created: [] }); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false));
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('creates with explicit IDs and parent, reads the final revision before opening, and sends using a newer event revision', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'session.create') {
        const created = newSession(command, 0);
        fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: created } });
        fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, { ...created, revision: 1 }] };
      }
      return { ok: true, requestId: command.requestId, created: [] };
    });
    await setup(); click('新增 session'); fillCreate();
    fireEvent.change(screen.getByLabelText('上層 session（可選）'), { target: { value: original.id } });
    fireEvent.click(createButton());
    await screen.findByRole('heading', { name: '新建對話' });
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    expect(command).toMatchObject({ type: 'session.create', kind: 'ordinary', parentId: original.id, cwd: 'E:\\work' });
    if (command.type !== 'session.create') throw new Error('wrong command');
    expect(command.sessionId).not.toBe(command.requestId);
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    const draft = screen.getByRole('textbox', { name: '傳訊息給 新建對話' });
    fireEvent.change(draft, { target: { value: '第一則' } }); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'session.send', sessionId: command.sessionId, expectedRevision: 1 });
    await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe(''));
    emit({ type: 'session.updated', session: newSession(command, 3) });
    fireEvent.change(draft, { target: { value: '再送一次' } }); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(3));
    expect(fake.bridge.send.mock.calls[2]![0]).toMatchObject({ expectedRevision: 3 });
  });

  it('updates Agent options from events and preserves fields on code-based failure, using fresh IDs on resubmit', async () => {
    await setup(); click('新增 session'); fillCreate();
    emit({ type: 'agent.updated', agent: { ...fixtureSnapshot.agents[0]!, name: '即時更新 Agent', revision: 2 } });
    expect(screen.getByRole('option', { name: '即時更新 Agent' })).toBeTruthy();
    fireEvent.click(createButton()); await screen.findByText(/目前尚未支援此操作。.*unsupported/);
    expect(screen.queryByText(/misleading/)).toBeNull(); expect(screen.getByLabelText<HTMLInputElement>('工作資料夾').value).toBe('E:\\work');
    fireEvent.click(createButton()); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    const first = Command.parse(fake.bridge.send.mock.calls[0]![0]); const second = Command.parse(fake.bridge.send.mock.calls[1]![0]);
    if (first.type !== 'session.create' || second.type !== 'session.create') throw new Error('wrong command');
    expect(second.requestId).not.toBe(first.requestId); expect(second.sessionId).not.toBe(first.sessionId);
  });

  it.each(['unknown_outcome', 'storage_failed'] as const)('blocks blind retry of %s after remount and reconciles only the generated session ID', async code => {
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code, message: 'success retry', retryable: true, mayHaveSideEffects: true }));
    await setup(); click('新增 session'); fillCreate(); fireEvent.click(createButton()); await screen.findByText(new RegExp(`（${code}）`));
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]); if (command.type !== 'session.create') throw new Error('wrong command');
    shortcut('1'); shortcut('n'); expect(createButton().matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '開啟已建立的 session' })).toBeNull();
    click('重新讀取資料並核對'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rendererStore(fake.bridge).getSnapshot().connection).toBe('ready'));
    expect(createButton().matches(':disabled')).toBe(true);
    fake.data.snapshot.sessions.push(newSession(command, 1));
    click('重新讀取資料並核對'); await screen.findByRole('heading', { name: '新建對話' });
    expect(rendererStore(fake.bridge).isBlocked('session.create', `session:${command.sessionId}`)).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('blocks stale sends until a newer revision, preserves drafts across routes, and never automatically resends', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'stale_revision', message: 'ignore me', retryable: true, mayHaveSideEffects: false });
    await setup();
    fireEvent.change(screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` }), { target: { value: '保留草稿' } }); click('送出');
    await screen.findByText(/等待新的 session revision 後/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    act(() => rendererStore(fake.bridge).acknowledge('session.send', `session:${original.id}`));
    shortcut('3'); shortcut('1'); expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    emit({ type: 'session.updated', session: { ...original } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    emit({ type: 'session.updated', session: { ...original, revision: original.revision + 1 } });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: `傳訊息給 ${original.title}` }).value).toBe('保留草稿');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false); expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    click('送出'); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ expectedRevision: original.revision + 1, text: '保留草稿' });
  });

  it('releases stale_revision with possible side effects only after the user reviews the result', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'stale_revision', message: '', retryable: true, mayHaveSideEffects: true });
    await setup();
    fireEvent.change(screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` }), { target: { value: '核對後再送' } }); click('送出');
    await waitFor(() => expect(Object.values(rendererStore(fake.bridge).getSnapshot().commands).some(item => item.result && !item.result.ok && item.result.code === 'stale_revision')).toBe(true));
    emit({ type: 'session.updated', session: { ...original, revision: original.revision + 1 } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    fireEvent.click(screen.getByText('待核對操作（1）'));
    click('已核對結果');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: `傳訊息給 ${original.title}` }).value).toBe('核對後再送');
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it.each(['waiting-user', 'waiting-lock'] as const)('allows sending during %s while also offering interrupt', async activity => {
    fake.data.snapshot.sessions[0] = { ...original, activity };
    await setup();
    fireEvent.change(screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` }), { target: { value: '插入目前 turn' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '中斷' })).toBeTruthy(); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'session.send', text: '插入目前 turn' });
  });

  it('explains disabled sending during Snapshot synchronization and preserves the draft', async () => {
    await setup();
    fireEvent.change(screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` }), { target: { value: '同步草稿' } });
    const read = deferred<Snapshot>(); fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    click('重新讀取資料');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    expect(screen.getByText(/資料尚未同步完成；完成後才能送出/)).toBeTruthy();
    await act(async () => { read.resolve(fake.data.snapshot); await Promise.resolve(); });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: `傳訊息給 ${original.title}` }).value).toBe('同步草稿');
  });
});

describe('T027 interrupt', () => {
  it('releases an accepted interrupt after the wait limit without resending, including across routes', async () => {
    fake.data.snapshot.sessions[0] = { ...original, activity: 'running' };
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: true, requestId: RequestId.parse(input.requestId), created: [] }));
    await setup(); vi.useFakeTimers(); click('中斷');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    shortcut('3');
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS - 1); });
    shortcut('1'); expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷' }).disabled).toBe(false);
    expect(screen.getByText(/10 秒內仍未收到停止狀態/)).toBeTruthy(); expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    click('中斷'); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fake.bridge.send).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(fake.bridge.send.mock.calls[0]![0].requestId);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
  });
  it.each([false, true])('shows an interrupt failure by code and blocks retry when side effects are %s', async mayHaveSideEffects => {
    fake.data.snapshot.sessions[0] = { ...original, activity: 'running' };
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'storage_failed', message: 'success', retryable: true, mayHaveSideEffects });
    await setup(); click('中斷');
    await waitFor(() => expect(screen.getAllByText(/儲存失敗/).length).toBeGreaterThan(0));
    if (mayHaveSideEffects) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷結果待核對' }).disabled).toBe(true);
      shortcut('3'); shortcut('1'); expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷結果待核對' }).disabled).toBe(true);
    } else expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷' }).disabled).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'waiting-user', 'waiting-lock'] as const)('interrupts %s once, waits for observed stop, and allows a later turn to be interrupted', async activity => {
    fake.data.snapshot.sessions[0] = { ...original, activity };
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValueOnce(response.promise);
    await setup(); click('中斷');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]); expect(command).toMatchObject({ type: 'session.interrupt', sessionId: original.id });
    await act(async () => { response.resolve({ ok: true, requestId: command.requestId, created: [] }); await Promise.resolve(); });
    shortcut('3'); shortcut('1'); expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
    emit({ type: 'session.updated', session: { ...original, activity: 'interrupted' } });
    expect(screen.queryByRole('button', { name: '中斷中…' })).toBeNull();
    emit({ type: 'session.updated', session: { ...original, activity: 'running' } }); click('中斷');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(command.requestId);
  });

  it('does not treat a native child turn as the parent turn', async () => {
    const task = fake.data.snapshot.nativeTasks[0]!;
    fake.data.snapshot.turns = [{ id: fake.data.snapshot.turns[0]!.id, sessionId: original.id, nativeTaskId: task.id, state: 'running', startedAt: original.updatedAt }];
    await setup(); expect(screen.queryByRole('button', { name: '中斷' })).toBeNull();
    expect(screen.queryByRole('button', { name: '開啟對話' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: `傳訊息給 ${original.title}` }), { target: { value: '等待子 turn' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    click('送出'); expect(fake.bridge.send).not.toHaveBeenCalled();
    emit({ type: 'turn.updated', turn: { ...fake.data.snapshot.turns[0]!, state: 'completed', endedAt: original.updatedAt } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false);
  });
});
