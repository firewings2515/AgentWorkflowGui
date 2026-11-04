// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderRequest, FolderTarget, RequestId } from '../../../contracts';
import type { FolderResult } from '../../../contracts';
import { FolderButton } from './FolderButton';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { App } from './App';
import { WorkflowStart } from './WorkflowStart';
import { createRendererStore } from './renderer-store';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';

afterEach(() => { cleanup(); delete window.awg; vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
const click = () => fireEvent.click(screen.getByRole('button', { name: /選擇資料夾|在檔案總管開啟/ }));
function bridge(result?: (request: FolderRequest) => Promise<FolderResult>) {
  const request = vi.fn(result ?? (request => Promise.resolve({ ok: true, requestId: request.requestId })));
  window.awg = { ...fakeBridge().bridge, folders: { request } }; return request;
}
describe('C-24 optional folder bridge', () => {
  it('disables with an explanation when the bridge is absent', () => {
    render(<FolderButton onPick={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '選擇資料夾' }).disabled).toBe(true);
    expect(screen.getByText('資料夾服務尚未接入。')).toBeTruthy();
  });
  it.each([
    { kind: 'session-cwd', sessionId: 's-plan-notes' }, { kind: 'task-worktree', instanceId: 'inst-login', taskId: 'task-a' },
    { kind: 'project', projectId: 'proj-demo' }, { kind: 'app-data' },
  ])('opens $kind by ID, without a renderer path, and creates a new request ID each time', async value => {
    const target = FolderTarget.parse(value); const request = bridge(); render(<FolderButton target={target} />);
    click(); await screen.findByText('已請求在檔案總管開啟。');
    expect(FolderRequest.parse(request.mock.calls[0]![0])).toEqual({ type: 'folder.open', target, requestId: request.mock.calls[0]![0].requestId });
    click(); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![0].requestId).not.toBe(request.mock.calls[0]![0].requestId);
  });
  it('preserves the draft on cancellation, rejects mismatched replies and ignores unmounted pick results', async () => {
    const pick = vi.fn(); const request = bridge(req => Promise.resolve({ ok: true, requestId: req.requestId, path: null }));
    const view = render(<FolderButton onPick={pick} />); click(); await screen.findByText('已取消選擇。'); expect(pick).not.toHaveBeenCalled();
    request.mockImplementation(() => Promise.resolve({ ok: true, requestId: RequestId.parse('wrong'), path: 'E:/wrong' }));
    click(); await screen.findByText(/無法核對/); expect(pick).not.toHaveBeenCalled();
    const result = deferred<FolderResult>(); request.mockReturnValue(result.promise); click(); view.unmount();
    await act(async () => { result.resolve({ ok: true, requestId: request.mock.calls[2]![0].requestId, path: 'E:/late' }); await result.promise; });
    expect(pick).not.toHaveBeenCalled();
  });
  it('uses error codes and does not show untrusted error prose', async () => {
    bridge(req => Promise.resolve({ ok: false, requestId: req.requestId, code: 'not_found', message: 'success' }));
    render(<FolderButton target={{ kind: 'app-data' }} />); click(); await screen.findByText('找不到資料夾。'); expect(screen.queryByText('success')).toBeNull();
  });
  it('fills the workflow cwd only with a successful selected folder', async () => {
    bridge(req => Promise.resolve({ ok: true, requestId: req.requestId, path: 'E:/picked' }));
    const fake = fakeBridge(); const store = createRendererStore(fake.bridge); await store.start();
    try {
      render(<WorkflowStart snapshot={fixtureSnapshot} store={store} ipcState={store.getSnapshot()} onOpen={vi.fn()} />);
      fireEvent.click(screen.getAllByRole('button', { name: '選擇…' })[0]!);
      await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: '工作資料夾' }).value).toBe('E:/picked'));
      expect(screen.getByRole<HTMLInputElement>('combobox', { name: '專案資料夾' }).value).toBe('');
      expect(fake.bridge.send).not.toHaveBeenCalled();
    } finally { store.dispose(); }
  });
  it('keeps other new-chat choices made while the picker was open (T051: the folder chip of the new chat)', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const pending = deferred<FolderResult>(); const request = bridge(() => pending.promise);
    window.history.replaceState(null, '', '/#/new');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '工作資料夾：自動建立' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '選擇資料夾…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent：無' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: fixtureSnapshot.agents[0]!.name }));
    await act(async () => { pending.resolve({ ok: true, requestId: request.mock.calls[0]![0].requestId, path: 'E:/picked' }); await pending.promise; });
    expect(screen.getByRole('button', { name: 'Agent：' + fixtureSnapshot.agents[0]!.name })).toBeTruthy();
    expect(screen.getByRole('button', { name: '工作資料夾：E:/picked' })).toBeTruthy();
    expect((window.awg as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
  it('a cancelled or failed pick leaves the folder chip as it was', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const request = bridge(req => Promise.resolve({ ok: true, requestId: req.requestId, path: null }));
    window.history.replaceState(null, '', '/#/new');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '工作資料夾：自動建立' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '選擇資料夾…' })); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: '工作資料夾：自動建立' })).toBeTruthy();
    request.mockImplementation(req => Promise.resolve({ ok: false, requestId: req.requestId, code: 'internal_error', message: 'picked E:/x' }));
    fireEvent.click(screen.getByRole('button', { name: '工作資料夾：自動建立' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '選擇資料夾…' }));
    await screen.findByText('無法開啟資料夾視窗。');
    expect(screen.queryByText(/picked E:/)).toBeNull();
    expect(screen.getByRole('button', { name: '工作資料夾：自動建立' })).toBeTruthy();
  });
});
