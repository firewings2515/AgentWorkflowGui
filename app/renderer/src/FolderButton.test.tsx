// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderRequest, FolderTarget, RequestId } from '../../../contracts';
import type { FolderResult } from '../../../contracts';
import { FolderButton } from './FolderButton';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { SessionCreate } from './SessionCreate';
import { WorkflowStart } from './WorkflowStart';
import { createRendererStore } from './renderer-store';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';

afterEach(() => { cleanup(); delete window.awg; });
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
      click(); await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: '工作資料夾' }).value).toBe('E:/picked'));
      expect(fake.bridge.send).not.toHaveBeenCalled();
    } finally { store.dispose(); }
  });
  it('preserves other session draft edits made while the picker was open', async () => {
    const pending = deferred<FolderResult>(); const request = bridge(() => pending.promise);
    const fake = fakeBridge(); const store = createRendererStore(fake.bridge); await store.start();
    const onDraft = vi.fn(); const draft = { cwd: '', agentId: '', modelKey: '', parentId: '' };
    const props = { snapshot: fixtureSnapshot, store, ipcState: store.getSnapshot(), onOpen: vi.fn(), onDraft };
    try {
      const view = render(<SessionCreate {...props} draft={draft} />); click();
      view.rerender(<SessionCreate {...props} draft={{ ...draft, agentId: 'new-selection' }} />);
      await act(async () => { pending.resolve({ ok: true, requestId: request.mock.calls[0]![0].requestId, path: 'E:/picked' }); await pending.promise; });
      expect(onDraft).toHaveBeenCalledWith({ ...draft, agentId: 'new-selection', cwd: 'E:/picked' });
    } finally { store.dispose(); }
  });
});
