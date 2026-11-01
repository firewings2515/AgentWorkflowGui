// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionId, TransferProposal } from '../../../contracts';
import { fixtureReadOnlySnapshot as snapshot } from '../../../contracts/fixtures/snapshot';
import { AgentCatalog } from './AgentCatalog';
import { WorkflowEditor } from './WorkflowEditor';
import { SessionCreate } from './SessionCreate';
import { WorkflowStart } from './WorkflowStart';
import { TransferDialog } from './TransferDialog';
import { EscalationPanel } from './EscalationPanel';
import { PipelineActions } from './PipelineActions';
import { DetailPanel } from './DetailPanel';
import { createIpcAgentRepository } from './agent-repository';
import { createIpcWorkflowRepository } from './workflow-repository';
import { createRendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { fakeBridge } from './ipc-test-helpers';

const stores: RendererStore[] = [];
afterEach(() => { cleanup(); stores.forEach(s => s.dispose()); stores.length = 0; vi.unstubAllGlobals(); });
async function setup() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const fake = fakeBridge(snapshot); const store = createRendererStore(fake.bridge); stores.push(store); await store.start();
  return { fake, store, ipcState: store.getSnapshot() };
}
function blocked(name: string) {
  const button = screen.getByRole<HTMLButtonElement>('button', { name });
  expect(button.matches(':disabled')).toBe(true);
  expect(button.getAttribute('aria-describedby')).toBe('read-only-reason');
  expect(button.title).toContain('唯讀');
  fireEvent.click(button);
}
it('disables Agent deletion and saving while allowing draft editing', async () => {
  const { store, fake } = await setup();
  render(<AgentCatalog readOnly repository={createIpcAgentRepository(store)} selectedId={snapshot.agents[0]!.id} visible onSelect={() => {}} />);
  blocked('刪除');
  fireEvent.click(screen.getByRole('button', { name: '編輯' }));
  blocked('儲存');
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
it('disables Workflow saving', async () => {
  const { store, fake } = await setup();
  render(<WorkflowEditor readOnly repository={createIpcWorkflowRepository(store)} selectedId={snapshot.workflows[0]!.id} visible agents={snapshot.agents} models={snapshot.modelOptions} onSelect={() => {}} />);
  blocked('儲存 Workflow');
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
it('disables session creation and Workflow start including valid forms', async () => {
  const { store, ipcState, fake } = await setup();
  const model = snapshot.modelOptions[0]!;
  const view = render(<SessionCreate snapshot={snapshot} store={store} ipcState={ipcState} draft={{ agentId: snapshot.agents[0]!.id, modelKey: `${model.runtime}:${model.model}`, cwd: 'E:\\work', parentId: '' }} onDraft={() => {}} onOpen={() => {}} />);
  blocked('建立 session');
  view.unmount();
  render(<WorkflowStart snapshot={snapshot} store={store} ipcState={ipcState} onOpen={() => {}} />);
  fireEvent.change(screen.getByLabelText('標題'), { target: { value: '工作' } });
  fireEvent.change(screen.getByLabelText('工作資料夾'), { target: { value: 'E:\\work' } });
  fireEvent.change(screen.getByLabelText('第一則訊息'), { target: { value: '執行' } });
  screen.queryAllByRole('checkbox').forEach(element => fireEvent.click(element));
  blocked('啟動 Workflow');
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
it('disables transfer preparation, confirmation and cancellation', async () => {
  const { store, ipcState, fake } = await setup();
  const source = snapshot.sessions[0]!;
  const model = snapshot.modelOptions.find(m => m.runtime !== source.requestedModel.runtime && !m.hidden)!;
  const props = { store, ipcState, preview: { sessionId: source.id, model, viewId: 'test' }, onClose: () => {}, onOpen: () => {} };
  const view = render(<TransferDialog {...props} snapshot={{ ...snapshot, transfers: [] }} />);
  blocked('產生轉交預覽');
  const proposal = TransferProposal.parse({ ...snapshot.transfers[1]!, sourceSessionId: source.id });
  view.unmount();
  render(<TransferDialog {...props} snapshot={{ ...snapshot, transfers: [proposal] }} />);
  blocked('確認轉交');
  blocked('取消提案');
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
it('disables approval and uncertain delivery decisions', async () => {
  const { store, ipcState, fake } = await setup();
  render(<EscalationPanel snapshot={snapshot} store={store} ipcState={ipcState} sessionId={SessionId.parse('s-wf-root')} />);
  const buttons = screen.getAllByRole<HTMLButtonElement>('button').filter(b => ['核准', '拒絕', '繼續等待', '取消送達', '重試送達'].includes(b.textContent));
  expect(buttons.length).toBeGreaterThanOrEqual(5);
  for (const button of buttons) {
    expect(button.matches(':disabled')).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('read-only-reason');
    expect(button.title).toContain('唯讀');
    fireEvent.click(button);
  }
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
it('disables group operations, cleanup retry and native task stop', async () => {
  const { store, ipcState, fake } = await setup();
  const instance = snapshot.instances[0]!;
  const view = render(<PipelineActions instance={instance} store={store} ipcState={ipcState} />);
  blocked('結束群組為已完成'); blocked('取消執行群組');
  view.rerender(<PipelineActions instance={instance} task={instance.tasks[0]!} store={store} ipcState={ipcState} />);
  blocked('重試清理');
  view.unmount();
  const task = snapshot.nativeTasks.find(t => t.state === 'running')!;
  render(<DetailPanel snapshot={snapshot} store={store} session={snapshot.sessions.find(s => s.id === task.sessionId)!} viewId="read-only-test" tab="tasks" onTab={() => {}} onOpen={() => {}} onNotice={() => {}} />);
  blocked('停止這個子 agent');
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
