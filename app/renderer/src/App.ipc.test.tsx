// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId } from '../../../contracts';
import type { CommandResult, ErrorCode, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import { rendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';

let fake: ReturnType<typeof fakeBridge>;
const planner = fixtureSnapshot.agents[0]!;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge;
  window.history.replaceState(null, '', '/#/workbench');
  localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reply = (title: string) => screen.getByRole<HTMLTextAreaElement>('textbox', { name: new RegExp(`^回覆 ${escape(title)}`) });
const sidebarRow = (title: string) => within(screen.getByRole('complementary', { name: '側欄' })).getByRole('button', { name: title });
const openSession = (id: string) => window.history.replaceState(null, '', `/#/sessions/${id}`);
async function openAgents() {
  window.history.replaceState(null, '', '/#/agents');
  render(<App />);
  await screen.findByRole('button', { name: '編輯' });
}

describe('IPC rendering and actions', () => {
  it('shows loading/error separately, recovers an empty snapshot without demo data', async () => {
    const read = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    render(<App />);
    expect(screen.getByText('正在同步資料…')).toBeTruthy();
    expect(screen.queryByText(/示意資料/)).toBeNull();
    await act(async () => { read.reject(new Error('offline')); await Promise.resolve(); });
    expect(screen.getByText(/資料同步失敗/)).toBeTruthy();
    fake.data.snapshot = { ...fixtureSnapshot, sessions: [], agents: [], workflows: [] };
    click('重新讀取資料');
    // T051: with no sessions the app opens on the new chat.
    await screen.findByRole('heading', { name: '今天想做什麼？' });
    expect(screen.queryByText(/示意資料/)).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('applies increasing seq in the UI and reconnects on online without resending after remount', async () => {
    openSession(fixtureSnapshot.sessions[0]!.id);
    const first = render(<StrictMode><App /></StrictMode>);
    await screen.findByText('IPC 已連線');
    const session = fixtureSnapshot.sessions[0]!;
    await act(async () => {
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'session.updated', session: { ...session, title: '更新名稱' } } });
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq, event: { type: 'session.updated', session: { ...session, title: '舊事件名稱' } } });
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: '更新名稱' })).toBeTruthy();
    expect(screen.queryByText('舊事件名稱')).toBeNull();
    expect(fake.listeners.size).toBe(1);
    first.unmount();
    expect(fake.listeners.size).toBe(0);
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 2, sessions: [{ ...session, title: '重新掛載快照' }] };
    const second = render(<App />);
    expect(screen.getByRole('heading', { name: '更新名稱' })).toBeTruthy();
    await screen.findByRole('heading', { name: '重新掛載快照' });
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.listeners.size).toBe(1);
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 3, sessions: [{ ...session, title: '重連快照' }] };
    await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: '重連快照' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(1);
    second.unmount();
    expect(fake.listeners.size).toBe(0);
  });

  it.each<[ErrorCode, string]>([
    ['unsupported', '目前尚未支援此操作'], ['stale_revision', '版本已變更'],
    ['permission_denied', '操作遭拒絕'], ['runtime_unavailable', 'Runtime 目前無法使用'],
    ['invalid_transition', '目前狀態不允許'], ['unknown_outcome', '結果未知'],
    ['storage_failed', '儲存失敗'], ['not_found', '找不到指定目標'],
    ['already_exists', '目標 ID 已存在'], ['invalid_request', '操作內容不符合契約'],
    ['usage_limit', '已達使用限制'], ['internal_error', '服務發生錯誤'],
  ])('presents %s by code even when requestId is null and message text is misleading', async (code, text) => {
    fake.bridge.send.mockResolvedValue({ ok: false, requestId: null, code, message: 'SUCCESS: saved, retry now', retryable: true, mayHaveSideEffects: false });
    await openAgents();
    click('編輯');
    fireEvent.change(screen.getByLabelText('指示（必填）'), { target: { value: '保留我的草稿' } });
    click('儲存');
    const role = code === 'unknown_outcome' ? 'status' : 'alert';
    await waitFor(() => expect(screen.getAllByRole(role).some(alert => alert.textContent?.includes(text))).toBe(true));
    expect(screen.getAllByRole(role).map(alert => alert.textContent).join('')).not.toContain('SUCCESS');
    const feedback = document.querySelector('[data-agent-feedback]');
    expect(feedback?.className).toBe(code === 'unknown_outcome' ? 'command-warning' : code === 'stale_revision' ? 'agent-feedback' : 'field-error');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '指示（必填）' }).value).toBe('保留我的草稿');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(code === 'unknown_outcome' || code === 'stale_revision');
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('示意模式測試')).toBeNull();
  });

  it('does not offer blind resubmission for possible side effects, including after remount', async () => {
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'storage_failed', message: 'retry', retryable: true, mayHaveSideEffects: true }));
    await openAgents(); click('編輯'); click('儲存');
    await screen.findByText(/不可直接重試/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(true);
    cleanup(); render(<App />); click('編輯');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('sends unique request and entity IDs for a new Agent and reads its saved revision', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      expect(Command.safeParse(command).success).toBe(true);
      if (command.type === 'agent.save') fake.data.snapshot.agents.push({ ...command.agent, revision: 1 });
      return { ok: true, requestId: command.requestId, revision: 1, created: [] };
    });
    await openAgents(); click('＋ 建立 Agent');
    fireEvent.change(screen.getByLabelText('名稱（必填）'), { target: { value: '新角色' } });
    fireEvent.change(screen.getByLabelText('指示（必填）'), { target: { value: '新指示' } });
    click('儲存');
    await screen.findByText(/已儲存「新角色」/);
    const sent = fake.bridge.send.mock.calls[0]![0];
    expect(sent.type).toBe('agent.save');
    if (sent.type !== 'agent.save') throw new Error('wrong command');
    expect(sent.expectedRevision).toBeNull();
    expect(fixtureSnapshot.agents.some(agent => agent.id === sent.agent.id)).toBe(false);
    click('編輯'); click('儲存');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(sent.requestId);
    await screen.findByText(/已儲存「新角色」/);
  });

  it('sends a captured delete target and presents Agent-in-use rejection without parsing message', async () => {
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'invalid_transition', message: 'totally unrelated', retryable: false, mayHaveSideEffects: false }));
    await openAgents(); screen.getByRole('button', { name: '刪除' }).focus(); click('刪除');
    const dialog = screen.getByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const confirm = within(dialog).getByRole('button', { name: '確認刪除' });
    cancel.focus(); fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(dialog, { key: 'Tab' }); expect(document.activeElement).toBe(cancel);
    fireEvent.click(confirm);
    await screen.findByText('Agent 仍被 Workflow 或 session 使用，無法刪除。');
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'agent.delete', agentId: planner.id, expectedRevision: planner.revision });
    click('取消');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '刪除' }));
  });

  it('removes a deleted Agent only after receiving the authoritative snapshot', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'agent.delete') fake.data.snapshot.agents = fake.data.snapshot.agents.filter(agent => agent.id !== command.agentId);
      return { ok: true, requestId: command.requestId, created: [] };
    });
    await openAgents(); click('刪除'); click('確認刪除');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rendererStore(fake.bridge).getSnapshot().snapshot?.agents.some(agent => agent.id === planner.id)).toBe(false);
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('keeps an in-flight message bound to its original session when selection changes', async () => {
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const original = fixtureSnapshot.sessions[0]!;
    const target = fixtureSnapshot.sessions.find(session => session.kind === 'ordinary' && session.id !== original.id)!;
    openSession(original.id);
    render(<App />); await screen.findByText('IPC 已連線');
    fireEvent.change(reply(original.title), { target: { value: '固定目標' } });
    click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const sent = fake.bridge.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ type: 'session.send', sessionId: original.id, expectedRevision: original.revision, text: '固定目標' });
    expect(Command.safeParse(sent).success).toBe(true);
    fireEvent.click(sidebarRow(target.title));
    fireEvent.change(reply(target.title), { target: { value: '另一個草稿' } });
    await act(async () => { response.resolve({ ok: true, requestId: RequestId.parse(sent.requestId), created: [] }); await Promise.resolve(); });
    expect(reply(target.title).value).toBe('另一個草稿');
    // The accepted message clears only its own session's draft.
    fireEvent.click(sidebarRow(original.title));
    expect(reply(original.title).value).toBe('');
    cleanup(); render(<App />);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('sends workflow.save and retains graph edits on unsupported responses', async () => {
    window.history.replaceState(null, '', `/#/workflows/${fixtureSnapshot.workflows[0]!.id}/edit`);
    render(<App />); await screen.findByText('IPC 已連線');
    click('儲存 Workflow');
    await screen.findByText('目前尚未支援此操作。');
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'workflow.save', workflow: { id: fixtureSnapshot.workflows[0]!.id }, expectedRevision: fixtureSnapshot.workflows[0]!.revision });
  });

  it('changes theme through preferences.set and applies its event without a snapshot read', async () => {
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'preferences.set') fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'preferences.updated', preferences: command.preferences, at: '2026-10-26T00:00:00Z' } });
      return { ok: true, requestId: command.requestId, created: [] };
    });
    render(<App />); await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: '切換成淺色' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'preferences.set', preferences: { ...fixtureSnapshot.preferences, theme: 'light' } });
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['agent', 'workflow'] as const)('unlocks an unknown %s save only after the user checks the result, preserving the draft', async kind => {
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true }));
    if (kind === 'agent') { await openAgents(); click('編輯'); }
    else {
      window.history.replaceState(null, '', `/#/workflows/${fixtureSnapshot.workflows[0]!.id}/edit`);
      render(<App />); await screen.findByText('IPC 已連線');
    }
    const label = kind === 'agent' ? '指示（必填）' : '範本名稱';
    const input = screen.getByLabelText<HTMLInputElement>(label);
    fireEvent.change(input, { target: { value: '保留核對中的草稿' } });
    const save = kind === 'agent' ? '儲存' : '儲存 Workflow';
    click(save);
    await waitFor(() => expect(document.querySelector(kind === 'agent' ? '[data-agent-feedback]' : '[data-workflow-feedback]')?.textContent).toContain('結果未知'));
    const feedback = document.querySelector(kind === 'agent' ? '[data-agent-feedback]' : '[data-workflow-feedback]');
    expect(feedback?.getAttribute('role')).toBe('status');
    expect(feedback?.className).toBe('command-warning');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: save }).disabled).toBe(true);
    click('已核對結果，保留草稿');
    expect(input.value).toBe('保留核對中的草稿');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: save }).disabled).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    click(save);
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
  });

  it('presents an unknown delete as a warning and allows explicit acknowledgement in the dialog', async () => {
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true }));
    await openAgents(); click('刪除'); click('確認刪除');
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toContain('結果未知'));
    expect(within(dialog).getByRole('status').className).toBe('command-warning');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '確認刪除' }).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '已核對結果' }));
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '確認刪除' }).disabled).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    click('確認刪除');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
  });

  it('keeps stopping a native task available after session.send times out and restores sending after checking', async () => {
    const session = fixtureSnapshot.sessions[0]!;
    const task = { ...fixtureSnapshot.nativeTasks.find(item => item.state === 'running')!, sessionId: session.id };
    fake.data.snapshot.nativeTasks = [task];
    fake.bridge.send.mockReturnValueOnce(deferred<CommandResult>().promise);
    openSession(session.id);
    render(<App />); await screen.findByText('IPC 已連線');
    vi.useFakeTimers();
    fireEvent.change(reply(session.title), { target: { value: '待核對的訊息' } });
    click('送出');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    vi.useRealTimers();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Model：/ }));
    expect(screen.getAllByRole<HTMLButtonElement>('menuitemradio').some(item => !item.disabled)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    click('開啟細節窗格');
    fireEvent.click(screen.getByRole('tab', { name: '任務流程' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '停止這個子 agent' }).disabled).toBe(false);
    click('停止這個子 agent');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ type: 'nativeTask.stop', sessionId: session.id, nativeTaskId: task.id });
    // T051: the outcomes to check moved from the footer to the settings page.
    click('設定');
    fireEvent.click(screen.getByText('待核對操作（1）'));
    click('已核對結果');
    fireEvent.click(sidebarRow(session.title));
    expect(reply(session.title).value).toBe('待核對的訊息');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(false);
    expect(fake.bridge.send).toHaveBeenCalledTimes(2);
    click('送出');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(3));
  });
});
