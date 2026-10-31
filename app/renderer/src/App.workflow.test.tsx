// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION, Escalation } from '../../../contracts';
import { App } from './App';
import { fakeBridge } from './ipc-test-helpers';
import { rendererStore } from './renderer-store';

let fake: ReturnType<typeof fakeBridge>;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge;
  window.history.replaceState(null, '', '/#/workbench');
  localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.unstubAllGlobals(); });

describe('T025 application integration', () => {
  it('opens start from the workbench and shows pending decisions inside the root session', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: '啟動 Workflow' }));
    expect(screen.getByLabelText('第一則訊息')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Session 清單' }));
    fireEvent.click(sidebar.getByRole('button', { name: /^登入功能（root）/ }));
    fireEvent.click(screen.getByRole('button', { name: '待處理 3 件' }));
    expect(screen.getByRole('region', { name: '升級待處理項目' })).toBeTruthy();
    expect(screen.getByText('由你決定，不是 root 的 AI')).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it.each(['dark', 'light'] as const)('renders damaged reason/location with data reload and the app menu in %s theme', async theme => {
    fake.data.snapshot.app = { status: 'damaged', reason: 'sessions.invalid-json', location: 'E:\\資料\\awg.sqlite' };
    fake.data.snapshot.preferences.theme = theme;
    render(<App />);
    await screen.findByRole('heading', { name: '資料損壞，所有操作已停用' });
    expect(screen.getByText('sessions.invalid-json')).toBeTruthy();
    expect(screen.getByText('E:\\資料\\awg.sqlite')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '在檔案總管開啟' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '應用程式選單' })).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '外觀主題' }).disabled).toBe(true);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fake.data.snapshot.app = { status: 'ready' };
    fireEvent.click(screen.getByRole('button', { name: '重新讀取資料' }));
    await screen.findByText('IPC 已連線');
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('keeps pending counts outside transcript scrolling, updates the tree, and jumps to a collapsible panel', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Session 清單' }));
    fireEvent.click(sidebar.getByRole('button', { name: /^登入功能（root）/ }));
    expect(sidebar.getByRole('button', { name: /^登入功能（root）.*待處理 3 件/ })).toBeTruthy();
    const transcript = screen.getByLabelText('登入功能（root） 對話');
    fireEvent.scroll(transcript, { target: { scrollTop: 900 } });
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fake.data.snapshot.seq + 1, event: { type: 'escalation.updated', escalation: Escalation.parse({ ...fake.data.snapshot.escalations[0], id: 'new-escalation', title: '新的待處理項目' }) } }));
    const indicator = screen.getByRole('button', { name: '待處理 4 件' });
    expect(indicator.closest('.transcript')).toBeNull();
    expect(sidebar.getByRole('button', { name: /^登入功能（root）.*待處理 4 件/ })).toBeTruthy();
    fireEvent.click(indicator);
    expect(transcript.scrollTop).toBe(0);
    const summary = screen.getByText('展開／收合待處理項目');
    expect(document.activeElement).toBe(summary);
    expect(summary.closest('details')!.open).toBe(true);
    expect(screen.getByRole('article', { name: '新的待處理項目' })).toBeTruthy();
    fireEvent.click(summary);
    expect(summary.closest('details')!.open).toBe(false);
    expect(screen.getByRole('button', { name: '待處理 4 件' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('HC-05 submits A escalation after drafting in A and switching the active workspace to B', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Session 清單' })).getByRole('button', { name: /^登入功能（root）/ }));
    fireEvent.click(screen.getByRole('button', { name: '待處理 3 件' }));
    const workspaceA = screen.getByRole('region', { name: '工作區 view-1' });
    const cardA = within(within(workspaceA).getByRole('article', { name: '要求執行 git push' }));
    fireEvent.change(cardA.getByLabelText('回覆說明（選填）'), { target: { value: 'A 的決定' } });
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    const workspaceB = screen.getByRole('region', { name: '工作區 view-2' });
    expect(workspaceB.dataset.active).toBe('true');
    expect(workspaceA.dataset.active).toBe('false');
    expect(within(workspaceB).getByRole('heading', { name: '規劃想法' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(cardA.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'escalation.respond', escalationId: 'esc-1', note: 'A 的決定' });
  });

  it('replaces an active start form with damaged status on invalidation without replaying a command', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: '啟動 Workflow' }));
    fake.data.snapshot.seq++;
    fake.data.snapshot.app = { status: 'damaged', reason: 'workflow.invalid', location: 'E:\\data.sqlite' };
    await act(async () => {
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fake.data.snapshot.seq, event: { type: 'snapshot.invalidated', reason: 'event-write-failed', at: '2026-10-29T12:00:00Z' } });
      await rendererStore(fake.bridge).start();
    });
    expect(screen.getByRole('heading', { name: '資料損壞，所有操作已停用' })).toBeTruthy();
    expect(screen.queryByLabelText('第一則訊息')).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});
