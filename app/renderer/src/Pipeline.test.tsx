// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, JoinRound, MergeAttempt, RequestId } from '../../../contracts';
import type { CommandResult, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowProgress } from './WorkflowProgress';
import { createRendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { LockWaits } from './LockWaits';
import { ConversationHarness } from './shell-v4/conversation-test-harness';

const stores: RendererStore[] = [];
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); stores.forEach(s => s.dispose()); stores.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });
function Harness({ store, instanceId = 'inst-login' }: { store: RendererStore; instanceId?: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <WorkflowProgress snapshot={state.snapshot!} instanceId={instanceId} store={store} ipcState={state} onOpen={vi.fn()} onBack={vi.fn()} />;
}
async function setup(snapshot: Snapshot = fixtureSnapshot) {
  const fake = fakeBridge(snapshot); const store = createRendererStore(fake.bridge); stores.push(store); await store.start();
  const view = render(<Harness store={store} />); return { fake, store, ...view };
}
const select = (name: string) => fireEvent.click(within(screen.getByRole('region', { name: '群組 task 清單' })).getByRole('button', { name }));
const confirm = (type: 'workflow.complete' | 'workflow.cancel') => fireEvent.click(screen.getByRole('button', { name: type === 'workflow.complete' ? '確認結束為已完成' : '確認取消執行群組' }));
describe('T034 task pipeline', () => {
  it('hides the merge queue for same-folder runs and keeps it for worktree runs', () => {
    const props = { snapshot: fixtureSnapshot, onOpen: vi.fn(), onBack: vi.fn() };
    const view = render(<WorkflowProgress {...props} instanceId="inst-docs" />);
    expect(screen.queryByRole('region', { name: '合併佇列' })).toBeNull();
    expect(screen.queryByText(/目標分支 尚未指定/)).toBeNull();
    expect(screen.queryByText(/依序處理，一次一個 task/)).toBeNull();
    expect(screen.getByText('同資料夾模式不經合併佇列')).toBeTruthy();
    expect(screen.getByRole('region', { name: '唯讀流程圖' })).toBeTruthy();
    view.rerender(<WorkflowProgress {...props} instanceId="inst-login" />);
    expect(screen.getByRole('region', { name: '合併佇列' })).toBeTruthy();
    expect(screen.queryByText('同資料夾模式不經合併佇列')).toBeNull();
  });

  it('scopes tasks, graph sessions and handoffs to the chosen run/task and keeps selection on live updates', async () => {
    const { fake } = await setup();
    const list = within(screen.getByRole('region', { name: '群組 task 清單' }));
    expect(list.getAllByRole('button', { pressed: false })).toHaveLength(5);
    expect(list.queryByText('文件 review')).toBeNull();
    expect(screen.getByRole('region', { name: 'Task 依賴關係圖' }).querySelectorAll('.react-flow__node')).toHaveLength(6);
    expect(list.getByText(/目前節點：尚未指定 · 依賴：表單驗證/)).toBeTruthy();
    select('Session 儲存 · task-b');
    const logs = within(screen.getByRole('region', { name: '各 node 的 session 與日誌' }));
    expect(logs.getByRole('button', { name: '開啟 實作：Session 儲存' })).toBeTruthy();
    expect(logs.queryByRole('button', { name: '開啟 Review：表單驗證' })).toBeNull();
    const handoffs = screen.getByRole('region', { name: '交接紀錄' });
    expect(handoffs.textContent).toContain(fixtureSnapshot.handoffs[2]!.payload);
    expect(handoffs.textContent).not.toContain(fixtureSnapshot.handoffs[0]!.payload);
    const instance = structuredClone(fixtureSnapshot.instances[0]!); instance.tasks[1]!.status = 'blocked'; instance.tasks[1]!.blockedReason = 'setup-failed';
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'instance.updated', instance } }));
    expect(list.getByRole('button', { name: 'Session 儲存 · task-b' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('受阻原因：初始化失敗')).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('renders queue sequence, active integration, conflicts, test failures and pending cleanup independently of merged status', async () => {
    const data = structuredClone(fixtureSnapshot); const instance = data.instances[0]!;
    instance.mergeQueue.push(MergeAttempt.parse({ ...instance.mergeQueue[0], taskId: 'task-a', seq: 4, state: 'tests-failed', test: { ...instance.mergeQueue[0]!.test, passed: false, exitCode: 1, outputTail: 'integration failed' } }));
    instance.mergeQueue.push(MergeAttempt.parse({ taskId: 'task-b', attempt: 0, seq: 3, state: 'queued', enqueuedAt: instance.createdAt }));
    await setup(data);
    const queue = within(screen.getByRole('region', { name: '合併佇列' }));
    expect(queue.getAllByRole('heading', { name: /^順序/ }).map(h => h.textContent)).toEqual(['順序 0 · 錯誤訊息文字', '順序 1 · 記住我', '順序 2 · 登入失敗鎖定', '順序 3 · Session 儲存', '順序 4 · 表單驗證']);
    expect(queue.getByText(/整合測試中 ·/)).toBeTruthy();
    expect(queue.getByText('src/auth/session.ts')).toBeTruthy();
    expect(queue.getByText('integration failed')).toBeTruthy();
    expect(queue.getByText(/Task Worktree：待清理/)).toBeTruthy();
    expect(queue.getByRole('button', { name: '重試清理' })).toBeTruthy();
    select('錯誤訊息文字 · task-d');
    expect(screen.getByRole('button', { name: '重試清理' })).toBeTruthy();
    expect(screen.getByText(/完成時間/)).toBeTruthy();
  });

  it('uses the persisted expected upstream set for each round and never fills a new round with old arrivals', () => {
    const data = structuredClone(fixtureSnapshot); const instance = data.instances[1]!; const first = instance.rounds[0]!;
    instance.rounds.push(JoinRound.parse({ ...first, round: 2, arrived: [], state: 'blocked', blockedReason: 'upstream-cancelled', blockedUpstream: 'n-rev-codex', settledAt: first.openedAt }));
    render(<WorkflowProgress snapshot={data} instanceId={instance.id} onOpen={vi.fn()} onBack={vi.fn()} />);
    const rounds = screen.getAllByRole('article', { name: /第 [12] 輪/ });
    expect(rounds).toHaveLength(2);
    expect(within(rounds[0]!).getByText(/本輪已到：.*h-6/)).toBeTruthy();
    expect(within(rounds[1]!).getByText('本輪已到：無')).toBeTruthy();
    expect(within(rounds[1]!).getByText(/受阻原因：上游已取消.*不視為完成/)).toBeTruthy();
    expect(within(rounds[1]!).getByText(/預期上游/).textContent).toContain('Codex');
  });

  it.each(['workflow.complete', 'workflow.cancel', 'task.retryCleanup'] as const)('sends fresh explicit targets for %s and reports unsupported by code', async type => {
    const { fake } = await setup();
    if (type === 'task.retryCleanup') select('錯誤訊息文字 · task-d');
    const button = screen.getByRole('button', { name: type === 'workflow.complete' ? '結束群組為已完成' : type === 'workflow.cancel' ? '取消執行群組' : '重試清理' });
    fireEvent.click(button);
    if (type !== 'task.retryCleanup') {
      expect(fake.bridge.send).not.toHaveBeenCalled();
      confirm(type);
    }
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    await screen.findByText(/目前尚未支援此操作/);
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    expect(command).toMatchObject({ type, instanceId: 'inst-login', ...(type === 'task.retryCleanup' ? { taskId: 'task-d' } : { expectedRevision: 4 }) });
    expect(screen.queryByText(/misleading/)).toBeNull();
    fireEvent.click(button);
    if (type !== 'task.retryCleanup') confirm(type);
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(command.requestId);
  });

  it.each(['workflow.complete', 'workflow.cancel'] as const)('explains consequences and dismisses %s without sending a command', async type => {
    const { fake } = await setup();
    fireEvent.click(screen.getByRole('button', { name: type === 'workflow.complete' ? '結束群組為已完成' : '取消執行群組' }));
    const confirmation = within(screen.getByRole('region', { name: '確認群組操作' }));
    expect(confirmation.getByText(type === 'workflow.complete' ? /未完成的 task 將視為已完成，不再合併/ : /不可逆/)).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(confirmation.getByRole('button', { name: '返回，不送出' }));
    expect(screen.queryByRole('region', { name: '確認群組操作' })).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('requires a new confirmation when the instance revision changes', async () => {
    const { fake } = await setup();
    fireEvent.click(screen.getByRole('button', { name: '結束群組為已完成' }));
    const instance = structuredClone(fixtureSnapshot.instances[0]!); instance.revision++;
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'instance.updated', instance } }));
    expect(screen.queryByRole('region', { name: '確認群組操作' })).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '結束群組為已完成' })); confirm('workflow.complete');
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ instanceId: instance.id, expectedRevision: instance.revision });
  });

  it('mounts fixture lock waits in the conversation pane above the messages (T051: was SessionWorkspace)', () => {
    const lock = fixtureSnapshot.locks[0]!; const waiter = lock.waiters[0]!;
    render(<ConversationHarness snapshot={fixtureSnapshot} sessionId={waiter.sessionId} />);
    const waits = within(screen.getByRole('region', { name: '檔案鎖等待' }));
    expect(waits.getByText(lock.path)).toBeTruthy();
    expect(waits.getByText(/持有者：.*s-research/)).toBeTruthy();
    expect(waits.getByText(/已等待/)).toBeTruthy();
  });

  it('mounts fixture lock waits in WorkflowProgress for the selected task session', () => {
    const data = structuredClone(fixtureSnapshot); const lock = data.locks[0]!;
    // The fixture waiter is ordinary; bind this lock wait to a workflow session for the progress view.
    lock.waiters[0]!.sessionId = data.sessions.find(s => s.id === 's-wf-build-a')!.id;
    const onOpen = vi.fn();
    render(<WorkflowProgress snapshot={data} instanceId="inst-login" onOpen={onOpen} onBack={vi.fn()} />);
    const logs = within(screen.getByRole('region', { name: '各 node 的 session 與日誌' }));
    const waits = within(logs.getByRole('region', { name: '檔案鎖等待' }));
    expect(waits.getByText(lock.path)).toBeTruthy();
    expect(waits.getByText(/已等待/)).toBeTruthy();
    expect(waits.getByText(/持有者：.*s-research/)).toBeTruthy();
    fireEvent.click(waits.getByRole('button', { name: '查看鎖持有者' }));
    expect(onOpen).toHaveBeenCalledWith(lock.holderSessionId);
    select('Session 儲存 · task-b');
    expect(within(screen.getByRole('region', { name: '各 node 的 session 與日誌' })).queryByRole('region', { name: '檔案鎖等待' })).toBeNull();
  });

  it('blocks duplicate pending and uncertain actions across task changes, remounts and reloads', async () => {
    const { fake, store, rerender } = await setup();
    const result = deferred<CommandResult>(); fake.bridge.send.mockReturnValue(result.promise);
    select('錯誤訊息文字 · task-d'); fireEvent.click(screen.getByRole('button', { name: '重試清理' }));
    fireEvent.click(screen.getByRole('button', { name: '重試清理' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    await act(async () => { result.resolve({ ok: false, requestId: RequestId.parse(fake.bridge.send.mock.calls[0]![0].requestId), code: 'internal_error', message: 'retry', mayHaveSideEffects: true, retryable: true }); await result.promise; });
    expect(screen.getByText(/不可直接重試/)).toBeTruthy();
    rerender(<Harness key="remounted" store={store} />); select('錯誤訊息文字 · task-d');
    await act(async () => store.reconnect());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重試清理' }).disabled).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('updates lock wait duration without assuming timeout means released and handles missing lock facts', () => {
    vi.useFakeTimers(); const data = structuredClone(fixtureSnapshot); const lock = data.locks[0]!; const waiter = lock.waiters[0]!;
    vi.setSystemTime(new Date(Date.parse(waiter.since) + 65000)); lock.waitingForBackground = true;
    const props = { sessionId: waiter.sessionId };
    data.sessions.find(s => s.id === waiter.sessionId)!.activity = 'waiting-lock';
    const view = render(<LockWaits snapshot={data} {...props} />);
    expect(screen.getByText(/已等待 1 分 5 秒/)).toBeTruthy();
    expect(screen.getByText(/持有者：.*s-research/)).toBeTruthy();
    expect(screen.getByText(/仍有背景指令/)).toBeTruthy();
    void act(() => { vi.advanceTimersByTime(1000); }); expect(screen.getByText(/已等待 1 分 6 秒/)).toBeTruthy();
    view.rerender(<LockWaits snapshot={{ ...data, locks: [] }} {...props} />);
    expect(screen.getByText(/尚無持有者與等待時間資料/)).toBeTruthy();
  });
});
