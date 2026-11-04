// @vitest-environment jsdom
// T025 application integration on the v0.4 shell (T051): starting a run, where escalations show (U2_PLAN §3-12),
// the damaged screen, and HC-05 across two panes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION, Escalation } from '../../../contracts';
import { App } from './App';
import { fakeBridge } from './ipc-test-helpers';
import { rendererStore } from './renderer-store';

let fake: ReturnType<typeof fakeBridge>;
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const pane = (id: string) => within(document.querySelector<HTMLElement>(`[data-pane="${id}"]`)!);
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge;
  window.history.replaceState(null, '', '/#/new');
  localStorage.clear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('T025 application integration', () => {
  it('opens the start page from the new chat, and the run row opens its root session with the decisions there', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: '開始 Workflow…' }));
    expect(screen.getByLabelText('第一則訊息')).toBeTruthy();
    fireEvent.click(sidebar().getByRole('button', { name: /^登入功能.*等待核准/ }));
    expect(screen.getByRole('heading', { name: '登入功能（root）' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '升級待處理項目' })).toBeTruthy();
    expect(screen.getByText('由你決定，不是 root 的 AI')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '這次執行的其他待處理項目' })).getByText('要求執行 git push')).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it.each(['dark', 'light'] as const)('renders damaged reason/location with data reload in %s theme', async theme => {
    fake.data.snapshot.app = { status: 'damaged', reason: 'sessions.invalid-json', location: 'E:\\資料\\awg.sqlite' };
    fake.data.snapshot.preferences.theme = theme;
    render(<App />);
    await screen.findByRole('heading', { name: '資料損壞，所有操作已停用' });
    expect(screen.getByText('sessions.invalid-json')).toBeTruthy();
    expect(screen.getByText('E:\\資料\\awg.sqlite')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '在檔案總管開啟' }).disabled).toBe(true);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fake.data.snapshot.app = { status: 'ready' };
    fireEvent.click(screen.getByRole('button', { name: '重新讀取資料' }));
    await screen.findByText('IPC 已連線');
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('marks pending items with a dot that follows events, and the root lists and jumps to them', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-wf-root');
    render(<App />);
    await screen.findByText('IPC 已連線');
    const runs = within(sidebar().getByRole('region', { name: '執行' }));
    expect(runs.getByRole('button', { name: /^文件 review/ }).querySelector('.v4-alert')).toBeNull();
    const others = () => within(screen.getByRole('region', { name: '這次執行的其他待處理項目' }));
    expect(others().getAllByRole('listitem')).toHaveLength(1);
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fake.data.snapshot.seq + 1, event: { type: 'escalation.updated', escalation: Escalation.parse({ ...fake.data.snapshot.escalations[0], id: 'new-escalation', title: '新的待處理項目', fromSessionId: 's-wf-build-a' }) } }));
    expect(others().getAllByRole('listitem')).toHaveLength(2);
    const transcript = screen.getByLabelText('登入功能（root） 對話內容');
    expect(transcript.contains(screen.getByRole('region', { name: '這次執行的其他待處理項目' }))).toBe(true);
    expect(sidebar().getByRole('button', { name: /^實作：表單驗證/ }).querySelector('.v4-alert')).not.toBeNull();
    fireEvent.click(others().getByRole('button', { name: /處理「新的待處理項目」/ }));
    expect(screen.getByRole('heading', { name: '實作：表單驗證' })).toBeTruthy();
    expect(screen.getByRole('article', { name: '新的待處理項目' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('HC-05 submits A escalation after drafting in A and switching the active pane to B', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-wf-build-b');
    render(<App />);
    await screen.findByText('IPC 已連線');
    const cardA = within(pane('pane-1').getByRole('article', { name: '要求執行 git push' }));
    fireEvent.change(cardA.getByLabelText('回覆說明（選填）'), { target: { value: 'A 的決定' } });
    fireEvent.click(sidebar().getByRole('button', { name: /^對話/ }));
    fireEvent.contextMenu(sidebar().getByRole('button', { name: '規劃想法' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(document.querySelector('[data-pane="pane-2"]')!.classList.contains('v4-pane-active')).toBe(true);
    expect(document.querySelector('[data-pane="pane-1"]')!.classList.contains('v4-pane-active')).toBe(false);
    expect(pane('pane-2').getByRole('heading', { name: '規劃想法' })).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(cardA.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'escalation.respond', escalationId: 'esc-1', note: 'A 的決定' });
  });

  it('replaces an active start form with damaged status on invalidation without replaying a command', async () => {
    render(<App />);
    await screen.findByText('IPC 已連線');
    fireEvent.click(screen.getByRole('button', { name: '開始 Workflow…' }));
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
