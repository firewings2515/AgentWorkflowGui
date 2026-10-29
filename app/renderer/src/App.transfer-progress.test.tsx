// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, LogicalSession, TransferProposal } from '../../../contracts';
import { App } from './App';
import { fakeBridge } from './ipc-test-helpers';
import { rendererStore } from './renderer-store';
import * as graphAdapter from './workflow-canvas/graph-adapter';

let fake: ReturnType<typeof fakeBridge>;
async function flush(action: () => void) { await act(async () => { action(); await Promise.resolve(); }); }
const pane = (id: string) => within(screen.getByRole('region', { name: `工作區 ${id}` }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  fake = fakeBridge(); window.awg = fake.bridge;
  window.history.replaceState(null, '', '/#/workbench');
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('captures the transfer source pane through preparation and opens the derived session in that pane', async () => {
  const source = fake.data.snapshot.sessions[0]!;
  const draft = TransferProposal.parse({ ...fake.data.snapshot.transfers[1]!, sourceSessionId: source.id });
  const target = LogicalSession.parse({ ...fake.data.snapshot.sessions.find(s => s.derivedFromSessionId)!, id: 'new-derived', title: '新的接續工作', derivedFromSessionId: source.id });
  const approved = TransferProposal.parse({ ...fake.data.snapshot.transfers[0]!, sourceSessionId: source.id, createdSessionId: target.id });
  fake.data.snapshot.transfers = [];
  let seq = fake.data.snapshot.seq;
  fake.bridge.send.mockImplementation(input => {
    const c = Command.parse(input);
    if (c.type === 'transfer.prepare') fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'transfer.updated', proposal: { ...draft, id: c.transferId } } });
    if (c.type === 'transfer.confirm') {
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: target } });
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'transfer.updated', proposal: { ...approved, id: c.transferId } } });
    }
    return Promise.resolve({ ok: true, requestId: c.requestId, created: [] });
  });
  render(<App />); await screen.findByText('IPC 已連線');
  fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
  fireEvent.click(pane('view-1').getByRole('button', { name: '換到另一個工具' }));
  const dialog = within(screen.getByRole('dialog'));
  // Programmatic pane change while a request is prepared must not retarget it (HC-05).
  fireEvent.pointerDown(screen.getByRole('region', { name: '工作區 view-2' }));
  await flush(() => fireEvent.click(dialog.getByRole('button', { name: '產生轉交預覽' })));
  expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'transfer.prepare', sourceSessionId: source.id });
  fireEvent.click(dialog.getByRole('checkbox'));
  await flush(() => fireEvent.click(dialog.getByRole('button', { name: '確認轉交' })));
  fireEvent.click(dialog.getByRole('button', { name: '開啟接續 session' }));
  expect(pane('view-1').getByRole('heading', { name: target.title })).toBeTruthy();
  expect(pane('view-2').getByRole('heading', { name: '參考資料整理' })).toBeTruthy();
  const tree = screen.getByRole('complementary', { name: 'Session 清單' });
  expect(tree.querySelector('[data-session-id="new-derived"] .tree-derived')?.textContent).toContain(source.title);
  fireEvent.click(pane('view-1').getByRole('tab', { name: 'Session 資訊' }));
  expect(pane('view-1').getByText('轉交來源')).toBeTruthy();
  expect(pane('view-1').getByText(source.title)).toBeTruthy();
  expect(fake.bridge.send).toHaveBeenCalledTimes(2);
});

it('opens a node session from the progress page in the original pane without runtime mutations', async () => {
  const buildGraph = vi.spyOn(graphAdapter, 'toCanvas');
  const instance = fake.data.snapshot.instances[0]!;
  instance.tasks = [instance.tasks[0]!];
  render(<App />); await screen.findByText('IPC 已連線');
  fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
  fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Session 清單' })).getByRole('button', { name: '實作：表單驗證 閒置' }));
  fireEvent.click(pane('view-2').getByRole('button', { name: '所屬 Workflow 選單' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '查看流程進度' }));
  const builds = buildGraph.mock.calls.length;
  expect(builds).toBeGreaterThan(0);
  // A message stream updates the snapshot without changing the graph inputs.
  await flush(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fake.data.snapshot.seq + 1, event: {
    type: 'message.delta', sessionId: fake.data.snapshot.sessions[0]!.id, messageId: fake.data.snapshot.messages[0]!.id, delta: '串流更新',
  } }));
  expect(buildGraph).toHaveBeenCalledTimes(builds);
  const graph = screen.getByRole('region', { name: '唯讀流程圖' });
  const node = graph.querySelector('.react-flow__node[data-id="n-review"]');
  expect(node).not.toBeNull();
  fireEvent.click(node!);
  expect(pane('view-2').getByRole('heading', { name: 'Review：表單驗證' })).toBeTruthy();
  expect(pane('view-1').getByRole('heading', { name: '規劃想法' })).toBeTruthy();
  expect(fake.bridge.send).not.toHaveBeenCalled();
});

it('disables cross-tool models for workflow sessions while allowing same-tool changes', async () => {
  const session = fake.data.snapshot.sessions.find(s => s.kind === 'workflow' && s.id === 's-wf-build-a')!;
  fake.data.snapshot.sessions = [session];
  render(<App />); await screen.findByText('IPC 已連線');
  const workspace = pane('view-1');
  expect(workspace.queryByRole('button', { name: '換到另一個工具' })).toBeNull();
  const select = workspace.getByRole<HTMLSelectElement>('combobox', { name: 'Model' });
  const crossTool = fake.data.snapshot.modelOptions.find(m => !m.hidden && m.runtime !== session.requestedModel.runtime)!;
  const option = within(select).getByRole<HTMLOptionElement>('option', { name: `${crossTool.displayName} · ${crossTool.runtime}（workflow 的 node 不能換工具）` });
  expect(option.disabled).toBe(true);
  expect(workspace.getByText('workflow 的 node 不能換工具；僅能選擇同一工具的 Model。')).toBeTruthy();
  // Guard the handler too: a synthetic event cannot bypass the option restriction.
  fireEvent.change(select, { target: { value: option.value } });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fake.bridge.send).not.toHaveBeenCalled();
  const sameTool = fake.data.snapshot.modelOptions.find(m => !m.hidden && m.runtime === session.requestedModel.runtime && m.model !== session.requestedModel.model)!;
  const sameOption = within(select).getByRole<HTMLOptionElement>('option', { name: `${sameTool.displayName} · ${sameTool.runtime}` });
  expect(sameOption.disabled).toBe(false);
  await flush(() => fireEvent.change(select, { target: { value: sameOption.value } }));
  expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'session.setModel', sessionId: session.id, model: { runtime: sameTool.runtime, model: sameTool.model } });
});

it('offers neither transfer entry nor model selection when the snapshot is damaged', async () => {
  fake.data.snapshot.app = { status: 'damaged', reason: 'test-damage', location: 'test.db' };
  render(<App />);
  await screen.findByRole('heading', { name: '資料損壞，所有操作已停用' });
  expect(screen.queryByRole('button', { name: '換到另一個工具' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fake.bridge.send).not.toHaveBeenCalled();
});

it('discards an open transfer on damaged data and keeps it closed after recovery', async () => {
  render(<App />); await screen.findByText('IPC 已連線');
  fireEvent.click(pane('view-1').getByRole('button', { name: '換到另一個工具' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fake.data.snapshot.app = { status: 'damaged', reason: 'test-damage', location: 'test.db' };
  fake.data.snapshot.seq++;
  await act(async () => { await rendererStore(fake.bridge).reconnect(); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '換到另一個工具' })).toBeNull();
  fake.data.snapshot.app = { status: 'ready' };
  fake.data.snapshot.seq++;
  await flush(() => fireEvent.click(screen.getByRole('button', { name: '重新讀取資料' })));
  expect(pane('view-1').getByRole('button', { name: '換到另一個工具' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fake.bridge.send).not.toHaveBeenCalled();
  fireEvent.click(pane('view-1').getByRole('button', { name: '換到另一個工具' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});
