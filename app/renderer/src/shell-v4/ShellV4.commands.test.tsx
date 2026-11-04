// @vitest-environment jsdom
// T051: the connected v0.4 shell sends real commands. Moved from App.menu-session (T027): shortcuts, creating a
// session (now: the new chat creates it on send, REVISION_V0_4 §3.4), first and later sends, stale revisions, interrupt.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId } from '../../../../contracts';
import type { AppEvent, CommandResult, LogicalSession, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { INTERRUPT_WAIT_MS, rendererStore } from '../renderer-store';
import { deferred, fakeBridge } from '../ipc-test-helpers';

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const original = fixtureSnapshot.sessions[0]!;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge; seq = fixtureSnapshot.seq;
  window.history.replaceState(null, '', `/#/sessions/${original.id}`); localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
async function setup(route?: string) { if (route) window.history.replaceState(null, '', `/#${route}`); render(<App />); await screen.findByText('IPC 已連線'); }
const shortcut = (key: string, shiftKey = false, target: HTMLElement | Window = window) => fireEvent.keyDown(target, { key, ctrlKey: key !== 'F5', shiftKey });
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const reply = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: new RegExp(`^回覆 ${original.title}`) });
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: '送出' });
const newChatBox = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /輸入訊息/ });
/** Leave the conversation and come back to it (the old tests used Ctrl+3 and Ctrl+1). */
const awayAndBack = () => { click('設定'); fireEvent.click(sidebar().getByRole('button', { name: original.title })); };
function newSession(command: Extract<Command, { type: 'session.create' }>, revision: number): LogicalSession {
  // A top-level ordinary session (no parent), with the Agent only when the command chose one.
  const base = fixtureSnapshot.sessions.find(item => item.id === 's-plan-notes')!;
  const session = { ...base, id: command.sessionId, title: '新建對話', revision, requestedModel: command.model, activity: 'idle' as const,
    cwd: command.cwd ?? 'C:/Users/demo/AgentWorkflowGui/2026-11-04-001' } as LogicalSession;
  if (session.kind === 'ordinary') { if (command.agentId !== undefined) session.agent = { id: command.agentId, revision: 1 }; else delete session.agent; }
  return session;
}
/** The service creates the session and has it in the next Snapshot (revision 1), like the real one does. */
function serviceCreates(onSend?: (command: Extract<Command, { type: 'session.send' }>) => CommandResult | undefined) {
  fake.bridge.send.mockImplementation(async input => {
    await Promise.resolve();
    const command = Command.parse(input);
    if (command.type === 'session.create') {
      const created = newSession(command, 0);
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: created } });
      fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, { ...created, revision: 1 }] };
    }
    if (command.type === 'session.send') { const answer = onSend?.(command); if (answer) return answer; }
    return { ok: true, requestId: command.requestId, created: [] };
  });
}
const createCalls = () => fake.bridge.send.mock.calls.map(([input]) => Command.parse(input)).filter((command): command is Extract<Command, { type: 'session.create' }> => command.type === 'session.create');

describe('T051 shortcuts (U2_PLAN §3-10, T027 rules)', () => {
  it('routes Ctrl+N by mode, Ctrl+Shift+N and F5, keeps normal editing keys, and no longer has Ctrl+T', async () => {
    await setup();
    expect(fireEvent.keyDown(reply(), { key: 'n' })).toBe(true);
    shortcut('t'); expect(document.querySelectorAll('[data-pane]')).toHaveLength(1);
    shortcut('n', false, reply()); expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    shortcut('N', true, newChatBox()); expect(screen.getByRole('heading', { level: 1, name: '開始 Workflow' })).toBeTruthy();
    // In Workflow mode Ctrl+N starts a Workflow too.
    shortcut('n'); expect(screen.getByRole('heading', { level: 1, name: '開始 Workflow' })).toBeTruthy();
    fireEvent.click(sidebar().getByRole('button', { name: /^對話(，有待處理項目)?$/ }));
    shortcut('n'); expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    shortcut('F5'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('uses physical key codes with a non-Latin key, but ignores IME composition, key repeat and an open dialog', async () => {
    await setup();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('heading', { name: '今天想做什麼？' })).toBeNull();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true, repeat: true });
    expect(screen.queryByRole('heading', { name: '今天想做什麼？' })).toBeNull();
    const dialog = document.body.appendChild(document.createElement('dialog'));
    dialog.setAttribute('open', '');
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true });
    expect(screen.queryByRole('heading', { name: '今天想做什麼？' })).toBeNull();
    dialog.remove();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true });
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ㄙ', code: 'KeyN', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('heading', { level: 1, name: '開始 Workflow' })).toBeTruthy();
  });

  it('shows About from getAppInfo on the settings page and changes themes there via preferences (Q-13)', async () => {
    fake.bridge.getAppInfo.mockResolvedValue({ name: '真實應用程式', version: '9.8.7' });
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'preferences.set') fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'preferences.updated', preferences: command.preferences, at: original.updatedAt } });
      return { ok: true, requestId: command.requestId, created: [] };
    });
    await setup();
    click('設定');
    const about = within(screen.getByRole('region', { name: '關於' }));
    await about.findByText(/版本 9.8.7/);
    expect(about.getByText(/真實應用程式/)).toBeTruthy();
    expect(about.getByText(/Apache-2.0/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: '深色' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(fake.bridge.send).not.toHaveBeenCalled();
    for (const [name, theme] of [['淺色', 'light'], ['深色', 'dark']] as const) {
      fireEvent.click(screen.getByRole('radio', { name }));
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe(theme));
      expect(screen.getByRole('radio', { name }).getAttribute('aria-checked')).toBe('true');
    }
    expect(new Set(fake.bridge.send.mock.calls.map(([input]) => input.requestId)).size).toBe(2);
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'preferences.set', preferences: { ...fixtureSnapshot.preferences, theme: 'light' } });
  });

  it('keeps only reload when damaged: Ctrl+N does nothing, F5 reads again', async () => {
    fake.data.snapshot.app = { status: 'damaged', reason: 'test', location: 'E:\\db' };
    render(<App />); await screen.findByRole('heading', { name: '資料損壞，所有操作已停用' });
    shortcut('n'); shortcut('N', true);
    expect(screen.getByRole('heading', { name: '資料損壞，所有操作已停用' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    shortcut('F5'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
  });
});

describe('T051 new chat: created on send (REVISION_V0_4 §3.4)', () => {
  it('keeps the draft, Agent and folder across pages until sent', async () => {
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '還沒送出' } });
    click('Agent：無'); fireEvent.click(screen.getByRole('menuitemradio', { name: fixtureSnapshot.agents[0]!.name }));
    click('工作資料夾：自動建立'); fireEvent.click(screen.getByRole('menuitemradio', { name: 'E:/work/demo' }));
    click('設定'); shortcut('N', true); shortcut('n');
    fireEvent.click(sidebar().getByRole('button', { name: /^對話(，有待處理項目)?$/ })); shortcut('n');
    expect(newChatBox().value).toBe('還沒送出');
    expect(screen.getByRole('button', { name: `Agent：${fixtureSnapshot.agents[0]!.name}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: '工作資料夾：E:/work/demo' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('lists recent folders from the sessions without duplicates (U2_PLAN §3-3), and no number on 自動建立 (Q-11)', async () => {
    await setup('/new');
    click('工作資料夾：自動建立');
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByRole('menuitemradio', { name: '自動建立 預設' }).getAttribute('aria-checked')).toBe('true');
    expect(menu.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['自動建立✓預設', 'E:/work/docs', 'E:/work/demo', 'E:/work/.awg/wt/t2', 'E:/work/.awg/wt/t1']);
    expect(menu.getByRole('menuitem', { name: '選擇資料夾…' })).toBeTruthy();
  });

  it('sends session.create without Agent and folder, opens the session after reading it, then sends the draft with its revision', async () => {
    serviceCreates();
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '第一則' } });
    fireEvent.keyDown(newChatBox(), { key: 'Enter' });
    await screen.findByRole('heading', { name: '新建對話' });
    const [create] = createCalls();
    expect(create).toMatchObject({ type: 'session.create', kind: 'ordinary' });
    expect(create && ('agentId' in create || 'cwd' in create || 'parentId' in create)).toBe(false);
    expect(create!.sessionId).not.toBe(create!.requestId);
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'session.send', sessionId: create!.sessionId, expectedRevision: 1, text: '第一則' });
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 新建對話/ });
    await waitFor(() => expect(box.value).toBe(''));
    expect(window.location.hash).toBe(`#/sessions/${create!.sessionId}`);
    // The new chat starts empty again.
    shortcut('n'); expect(newChatBox().value).toBe('');
    fireEvent.click(sidebar().getByRole('button', { name: '新建對話' }));
    emit({ type: 'session.updated', session: newSession(create!, 3) });
    fireEvent.change(screen.getByRole('textbox', { name: /^回覆 新建對話/ }), { target: { value: '再送一次' } }); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(3));
    expect(fake.bridge.send.mock.calls[2]![0]).toMatchObject({ expectedRevision: 3, text: '再送一次' });
  });

  it('carries the chosen Agent, model and folder into session.create', async () => {
    serviceCreates();
    await setup('/new');
    const model = fixtureSnapshot.modelOptions.filter(item => !item.hidden).at(-1)!;
    click('Agent：無'); fireEvent.click(screen.getByRole('menuitemradio', { name: fixtureSnapshot.agents[0]!.name }));
    click('工作資料夾：自動建立'); fireEvent.click(screen.getByRole('menuitemradio', { name: 'E:/work/docs' }));
    fireEvent.click(screen.getByRole('button', { name: /^Model：/ })); fireEvent.click(screen.getByRole('menuitemradio', { name: model.displayName }));
    fireEvent.change(newChatBox(), { target: { value: '帶設定' } }); click('送出');
    await screen.findByRole('heading', { name: '新建對話' });
    expect(createCalls()[0]).toMatchObject({ agentId: fixtureSnapshot.agents[0]!.id, cwd: 'E:/work/docs', model: { runtime: model.runtime, model: model.model } });
  });

  it('a refused create keeps the draft in the new chat with the code, and sending again uses fresh IDs', async () => {
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '保留' } }); click('送出');
    await screen.findByText(/沒有建立對話：目前尚未支援此操作。.*unsupported/);
    expect(screen.queryByText(/misleading/)).toBeNull();
    expect(newChatBox().value).toBe('保留');
    expect(send().disabled).toBe(false);
    click('送出'); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    const [first, second] = createCalls();
    expect(second!.requestId).not.toBe(first!.requestId); expect(second!.sessionId).not.toBe(first!.sessionId);
  });

  it('create accepted but the first send refused: the session is open and the draft stays in its box', async () => {
    serviceCreates(command => ({ ok: false, requestId: command.requestId, code: 'invalid_transition', message: 'sent!', retryable: false, mayHaveSideEffects: false }));
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '要重送' } }); click('送出');
    await screen.findByRole('heading', { name: '新建對話' });
    await screen.findByText(/訊息沒有送出/);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 新建對話/ }).value).toBe('要重送');
    expect(screen.queryByText('sent!')).toBeNull();
  });

  it('keeps an in-flight create protected across navigation, keeps a draft typed meanwhile, and sends once the receipt arrives', async () => {
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValueOnce(response.promise);
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '首句' } }); click('送出'); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const [command] = createCalls();
    click('設定'); fireEvent.click(sidebar().getByRole('button', { name: /^對話(，有待處理項目)?$/ })); shortcut('n');
    expect(send().disabled).toBe(true); expect(screen.getByText('正在建立對話…')).toBeTruthy();
    emit({ type: 'session.updated', session: newSession(command!, 0) });
    fireEvent.click(sidebar().getByRole('button', { name: '新建對話' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^回覆 新建對話/ }), { target: { value: '先保留' } });
    expect(send().disabled).toBe(true);
    expect(screen.getByText(/Session 建立中；完成後才能送出/)).toBeTruthy();
    fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, newSession(command!, 1)] };
    await act(async () => { response.resolve({ ok: true, requestId: command!.requestId, created: [] }); await Promise.resolve(); });
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'session.send', sessionId: command!.sessionId, text: '首句' });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 新建對話/ }).value).toBe('先保留');
  });

  it('a timed-out create that succeeds later is read again and opened unsent, with a note (Q-d)', async () => {
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValueOnce(response.promise);
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '逾時的第一句' } });
    vi.useFakeTimers(); click('送出');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    vi.useRealTimers(); expect(screen.getByText(/建立結果待核對/)).toBeTruthy();
    const [command] = createCalls();
    emit({ type: 'session.updated', session: newSession(command!, 0) });
    expect(screen.queryByRole('heading', { name: '新建對話' })).toBeNull();
    const read = deferred<Snapshot>(); fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    await act(async () => { response.resolve({ ok: true, requestId: command!.requestId, created: [] }); await Promise.resolve(); });
    expect(screen.queryByRole('heading', { name: '新建對話' })).toBeNull();
    await act(async () => { read.resolve({ ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, newSession(command!, 1)] }); await Promise.resolve(); });
    expect(rendererStore(fake.bridge).getSnapshot().snapshot?.sessions.find(item => item.id === command!.sessionId)?.revision).toBe(1);
    fake.data.snapshot = { ...fake.data.snapshot, seq, sessions: [...fake.data.snapshot.sessions, newSession(command!, 1)] };
    click('重新讀取資料並開啟');
    await screen.findByRole('heading', { name: '新建對話' });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 新建對話/ }).value).toBe('逾時的第一句');
    expect(screen.getByText(/第一句還沒送出/)).toBeTruthy();
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: true, requestId: RequestId.parse(input.requestId), created: [] }));
    click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'session.send', text: '逾時的第一句' });
    await waitFor(() => expect(screen.queryByText(/第一句還沒送出/)).toBeNull());
  });

  it('needs a successful Snapshot read and an explicit confirmation before sending again after a missing create, with fresh IDs', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'storage_failed', message: '', retryable: true, mayHaveSideEffects: true });
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '要確認的第一句' } }); click('送出');
    await screen.findByText(/建立結果待核對/);
    const [first] = createCalls();
    const confirm = '我已確認沒有建立，可以重新送出';
    expect(screen.queryByRole('button', { name: confirm })).toBeNull();
    act(() => rendererStore(fake.bridge).acknowledge('session.create', `session:${first!.sessionId}`));
    expect(send().disabled).toBe(true);
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    click('重新讀取資料並核對'); await screen.findByText('資料同步失敗，保留上次資料');
    expect(screen.queryByRole('button', { name: confirm })).toBeNull();
    click('重新讀取資料並核對');
    fireEvent.click(await screen.findByRole('button', { name: confirm }));
    expect(send().disabled).toBe(false); expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    expect(newChatBox().value).toBe('要確認的第一句');
    click('送出'); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    const [, second] = createCalls();
    expect(second!.sessionId).not.toBe(first!.sessionId); expect(second!.requestId).not.toBe(first!.requestId);
  });

  it.each(['unknown_outcome', 'storage_failed'] as const)('blocks a blind retry of %s after remount and opens only the generated session ID, unsent', async code => {
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code, message: 'success retry', retryable: true, mayHaveSideEffects: true }));
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '不明的第一句' } }); click('送出');
    await screen.findByText(/建立結果待核對/);
    const [command] = createCalls();
    cleanup(); window.history.replaceState(null, '', '/#/new'); render(<App />);
    expect(send().disabled).toBe(true); expect(screen.getByText(/建立結果待核對/)).toBeTruthy();
    click('重新讀取資料並核對'); await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rendererStore(fake.bridge).getSnapshot().connection).toBe('ready'));
    expect(send().disabled).toBe(true);
    fake.data.snapshot.sessions.push(newSession(command!, 1));
    click('重新讀取資料並核對'); await screen.findByRole('heading', { name: '新建對話' });
    expect(rendererStore(fake.bridge).isBlocked('session.create', `session:${command!.sessionId}`)).toBe(false);
    expect(screen.getByText(/第一句還沒送出/)).toBeTruthy();
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('does not create in read-only data (the store also refuses)', async () => {
    fake = fakeBridge({ ...fixtureSnapshot, app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } }); window.awg = fake.bridge;
    await setup('/new');
    fireEvent.change(newChatBox(), { target: { value: '唯讀' } });
    expect(send().disabled).toBe(true); expect(send().title).toContain('唯讀');
    fireEvent.keyDown(newChatBox(), { key: 'Enter' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});

describe('T027 send in the v0.4 conversation', () => {
  it('blocks stale sends until a newer revision, preserves drafts across pages, and never automatically resends', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'stale_revision', message: 'ignore me', retryable: true, mayHaveSideEffects: false });
    await setup();
    fireEvent.change(reply(), { target: { value: '保留草稿' } }); click('送出');
    await screen.findByText(/等待新的 session revision 後/);
    expect(send().disabled).toBe(true);
    act(() => rendererStore(fake.bridge).acknowledge('session.send', `session:${original.id}`));
    awayAndBack(); expect(send().disabled).toBe(true);
    emit({ type: 'session.updated', session: { ...original } });
    expect(send().disabled).toBe(true);
    emit({ type: 'session.updated', session: { ...original, revision: original.revision + 1 } });
    expect(reply().value).toBe('保留草稿');
    expect(send().disabled).toBe(false); expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    click('送出'); await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ expectedRevision: original.revision + 1, text: '保留草稿' });
  });

  it('releases stale_revision with possible side effects only after the user reviews the result', async () => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code: 'stale_revision', message: '', retryable: true, mayHaveSideEffects: true });
    await setup();
    fireEvent.change(reply(), { target: { value: '核對後再送' } }); click('送出');
    await waitFor(() => expect(Object.values(rendererStore(fake.bridge).getSnapshot().commands).some(item => item.result && !item.result.ok && item.result.code === 'stale_revision')).toBe(true));
    emit({ type: 'session.updated', session: { ...original, revision: original.revision + 1 } });
    expect(send().disabled).toBe(true);
    click('設定');
    fireEvent.click(screen.getByText('待核對操作（1）'));
    click('已核對結果');
    fireEvent.click(sidebar().getByRole('button', { name: original.title }));
    expect(send().disabled).toBe(false);
    expect(reply().value).toBe('核對後再送');
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it.each(['waiting-user', 'waiting-lock'] as const)('allows sending during %s while also offering interrupt', async activity => {
    fake.data.snapshot.sessions[0] = { ...original, activity };
    await setup();
    fireEvent.change(reply(), { target: { value: '插入目前 turn' } });
    expect(send().disabled).toBe(false);
    expect(screen.getByRole('button', { name: '中斷' })).toBeTruthy(); click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'session.send', text: '插入目前 turn' });
  });

  it('explains disabled sending during Snapshot synchronization and preserves the draft', async () => {
    await setup();
    fireEvent.change(reply(), { target: { value: '同步草稿' } });
    const read = deferred<Snapshot>(); fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    click('重新讀取資料');
    expect(send().disabled).toBe(true);
    expect(screen.getByText(/資料尚未同步完成；完成後才能送出/)).toBeTruthy();
    await act(async () => { read.resolve(fake.data.snapshot); await Promise.resolve(); });
    expect(send().disabled).toBe(false);
    expect(reply().value).toBe('同步草稿');
  });

  it('renames with session.rename and the latest revision; an empty or unchanged title sends nothing', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code: 'stale_revision', message: '', retryable: true, mayHaveSideEffects: false }));
    await setup();
    emit({ type: 'session.updated', session: { ...original, revision: original.revision + 2 } });
    fireEvent.click(screen.getByTitle('點一下改名'));
    let input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.change(input, { target: { value: '   ' } }); fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTitle('點一下改名'));
    input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('點一下改名'));
    input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.change(input, { target: { value: ' 新版規劃 ' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'session.rename', sessionId: original.id, expectedRevision: original.revision + 2, title: '新版規劃' });
    await screen.findByText(/沒有改名：標題剛被更新/);
    expect(screen.getByRole('heading', { name: original.title })).toBeTruthy();
  });

  it('opens rename from the sidebar menu and shows the new title from the service', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'session.rename') fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: { ...original, title: command.title, revision: original.revision + 1 } } });
      return { ok: true, requestId: command.requestId, created: [] };
    });
    await setup('/new');
    fireEvent.contextMenu(sidebar().getByRole('button', { name: original.title }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重新命名' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.change(input, { target: { value: '改好的名字' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sidebar().getByRole('button', { name: '改好的名字' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: '改好的名字' })).toBeTruthy();
  });

  it('changes the Agent with session.setAgent (null for none) and a same-tool model with session.setModel', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: true, requestId: RequestId.parse(input.requestId), created: [] }));
    await setup();
    click(`Agent：${fixtureSnapshot.agents.find(agent => agent.id === original.agent?.id)!.name}`);
    fireEvent.click(screen.getByRole('menuitemradio', { name: '無 只用 Model 的預設行為' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'session.setAgent', sessionId: original.id, expectedRevision: original.revision, agentId: null });
    const same = fixtureSnapshot.modelOptions.find(model => !model.hidden && model.runtime === original.requestedModel.runtime && model.model !== original.requestedModel.model)!;
    fireEvent.click(screen.getByRole('button', { name: /^Model：/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: same.displayName }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'session.setModel', sessionId: original.id, model: { runtime: same.runtime, model: same.model } });
  });
});

describe('T027 interrupt in the v0.4 conversation', () => {
  it('releases an accepted interrupt after the wait limit without resending, including across pages', async () => {
    fake.data.snapshot.sessions[0] = { ...original, activity: 'running' };
    fake.bridge.send.mockImplementation(input => Promise.resolve({ ok: true, requestId: RequestId.parse(input.requestId), created: [] }));
    await setup(); vi.useFakeTimers(); click('中斷');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    click('設定');
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS - 1); });
    fireEvent.click(sidebar().getByRole('button', { name: original.title }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
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
      awayAndBack(); expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷結果待核對' }).disabled).toBe(true);
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
    awayAndBack(); expect(screen.getByRole<HTMLButtonElement>('button', { name: '中斷中…' }).disabled).toBe(true);
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
    fireEvent.change(reply(), { target: { value: '等待子 turn' } });
    expect(send().disabled).toBe(true);
    click('送出'); expect(fake.bridge.send).not.toHaveBeenCalled();
    emit({ type: 'turn.updated', turn: { ...fake.data.snapshot.turns[0]!, state: 'completed', endedAt: original.updatedAt } });
    expect(send().disabled).toBe(false);
  });
});
