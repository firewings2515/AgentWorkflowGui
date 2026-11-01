// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Handoff, NodeId, Snapshot, TaskStatus } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { nodeSessions, WorkflowProgress } from './WorkflowProgress';

function singleTask() {
  const data = structuredClone(fixtureSnapshot);
  const instance = data.instances[0]!;
  instance.tasks = [instance.tasks[0]!];
  instance.mergeQueue = [];
  instance.taskPlans = [];
  instance.tasks[0]!.reworkCount = 2;
  instance.template.reworkLimit = 3;
  // The current template can change or disappear without changing the running instance.
  data.workflows = [];
  instance.template.nodes.push({ ...instance.template.nodes[1]!, id: NodeId.parse('unvisited'), label: '尚未執行的節點', outputRules: [], position: { x: 700, y: 300 } });
  return Snapshot.parse(data);
}
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T026 單 task 進度', () => {
  it.each(TaskStatus.options)('renders the contract task state %s in Chinese on the current graph node', status => {
    const data = singleTask(); const instance = data.instances[0]!;
    instance.tasks[0]!.status = status;
    render(<WorkflowProgress snapshot={data} instanceId={instance.id} onOpen={vi.fn()} onBack={vi.fn()} />);
    const graph = screen.getByRole('region', { name: '唯讀流程圖' });
    const label = graph.querySelector(`.current-node [data-state="${status}"]`);
    expect(label).not.toBeNull();
    expect(label!.textContent).toMatch(/[\u4e00-\u9fff]/);
    expect(label!.textContent).not.toContain(status);
  });

  it('uses pinned nodes, task counters and observed session state, and scopes node sessions to the task', () => {
    const data = singleTask(); const instance = data.instances[0]!; const open = vi.fn();
    const before = JSON.stringify(data);
    render(<WorkflowProgress snapshot={data} instanceId={instance.id} onOpen={open} onBack={vi.fn()} />);
    expect(screen.getByText(/返工 2 次／上限 3 次/)).toBeTruthy();
    const logs = within(screen.getByRole('region', { name: '各 node 的 session 與日誌' }));
    const current = logs.getByRole('heading', { name: /目前節點/ });
    expect(current.textContent).toContain(instance.template.nodes.find(n => n.id === instance.tasks[0]!.currentNodeId)!.label);
    expect(within(current.closest('article')!).getByText(/執行中/)).toBeTruthy();
    expect(logs.queryByRole('button', { name: '開啟 實作：Session 儲存' })).toBeNull();
    expect(logs.getAllByText('尚未進入（未建立 session）').length).toBeGreaterThan(0);
    fireEvent.click(logs.getByRole('button', { name: '開啟 Review：表單驗證' }));
    expect(open).toHaveBeenCalledWith('s-wf-review-a');
    expect(logs.queryByRole('button', { name: '開啟對話' })).toBeNull();
    const graph = screen.getByRole('region', { name: '唯讀流程圖' });
    expect(graph.querySelector('.react-flow')).toBeTruthy();
    expect(graph.querySelector('.react-flow__node.draggable')).toBeNull();
    expect(JSON.stringify(data)).toBe(before);
  });

  it('separates pending/sent/unknown delivery from cancelled/rejected/failed outcomes and uses Handoff.rework', () => {
    const data = singleTask(); const first = data.handoffs[0]!;
    data.handoffs = [
      Handoff.parse({ ...first, id: 'pending', delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled', detail: '取消原因', at: first.acceptedAt }, rework: true }),
      Handoff.parse({ ...first, id: 'sent', outcome: { kind: 'rejected', detail: '拒絕原因', at: first.acceptedAt }, rework: false }),
      Handoff.parse({ ...first, id: 'unknown', delivery: fixtureSnapshot.peerMessages[1]!.delivery, outcome: { kind: 'failed', detail: '失敗原因', at: first.acceptedAt }, rework: false }),
      // Must not include records from another task, even in the same instance.
      fixtureSnapshot.handoffs[2]!,
    ];
    render(<WorkflowProgress snapshot={Snapshot.parse(data)} instanceId={data.instances[0]!.id} onOpen={vi.fn()} onBack={vi.fn()} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    for (const [index, delivery, outcome] of [[0, '等待中', '已取消'], [1, '已送達（不代表已讀）', '已拒絕'], [2, '送達結果未知', '失敗']] as const) {
      const cells = within(rows[index]!).getAllByRole('cell');
      expect(cells[2]!.textContent).toMatch(/第 \d+ 輪/);
      expect(cells[4]!.textContent).toContain(delivery);
      expect(cells[5]!.textContent).toContain(outcome);
    }
    expect(within(rows[0]!).getByText('返工交接')).toBeTruthy();
    expect(within(rows[1]!).getByText('一般交接')).toBeTruthy();
    expect(screen.getByText(/返工 2 次／上限 3 次/)).toBeTruthy();
    expect(screen.getAllByText(first.ruleId)).toHaveLength(3);
  });

  it('updates current node and session activity without interpreting idle as completed', () => {
    const data = singleTask(); const instance = data.instances[0]!;
    const props = { instanceId: instance.id, onOpen: vi.fn(), onBack: vi.fn() };
    const view = render(<WorkflowProgress {...props} snapshot={data} />);
    const changed = structuredClone(data);
    changed.instances[0]!.tasks[0]!.currentNodeId = NodeId.parse('n-build');
    changed.instances[0]!.tasks[0]!.status = 'blocked';
    view.rerender(<WorkflowProgress {...props} snapshot={changed} />);
    const logs = within(screen.getByRole('region', { name: '各 node 的 session 與日誌' }));
    const current = logs.getByRole('heading', { name: /目前節點/ }).closest('article')!;
    expect(within(current).getByText(/閒置/)).toBeTruthy();
    expect(current.querySelector(':scope > div > .status')?.getAttribute('data-state')).toBe('idle');
    expect(screen.getByText(/目前節點：實作/)).toBeTruthy();
  });

  it('does not substitute another instance and exposes task selection for multiple tasks', () => {
    const props = { snapshot: fixtureSnapshot, onOpen: vi.fn(), onBack: vi.fn() };
    const view = render(<WorkflowProgress {...props} instanceId="missing" />);
    expect(screen.getByRole('heading', { name: '找不到指定的 Workflow 執行群組' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '唯讀流程圖' })).toBeNull();
    view.rerender(<WorkflowProgress {...props} instanceId={fixtureSnapshot.instances[0]!.id} />);
    expect(screen.getByRole('region', { name: '群組 task 清單' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '表單驗證 · task-a' }).getAttribute('aria-pressed')).toBe('true');
    view.rerender(<WorkflowProgress {...props} snapshot={{ ...fixtureSnapshot, instances: [{ ...fixtureSnapshot.instances[0]!, tasks: [] }] }} instanceId={fixtureSnapshot.instances[0]!.id} />);
    expect(screen.getByText(/尚無 task 資料/)).toBeTruthy();
  });

  it('keeps missing session data distinct from unvisited nodes when a handoff already exists', () => {
    const data = singleTask();
    data.sessions = data.sessions.filter(s => s.id !== 's-wf-build-a');
    render(<WorkflowProgress snapshot={data} instanceId={data.instances[0]!.id} onOpen={vi.fn()} onBack={vi.fn()} />);
    const logs = within(screen.getByRole('region', { name: '各 node 的 session 與日誌' }));
    expect(logs.getByText('已有交接紀錄，尚無 session 資料')).toBeTruthy();
    expect(logs.queryByRole('button', { name: '開啟 實作：表單驗證' })).toBeNull();
  });

  it('shows a first task arriving after an empty instance without requiring an unavailable selector', () => {
    const data = singleTask(); const instance = data.instances[0]!;
    const props = { instanceId: instance.id, onOpen: vi.fn(), onBack: vi.fn() };
    const view = render(<WorkflowProgress {...props} snapshot={{ ...data, instances: [{ ...instance, tasks: [] }] }} />);
    expect(screen.getByText(/尚無 task 資料/)).toBeTruthy();
    view.rerender(<WorkflowProgress {...props} snapshot={data} />);
    expect(screen.getByRole('region', { name: '唯讀流程圖' })).toBeTruthy();
  });

  it('allows only the instance root without a task binding; never uses ordinary or other-task sessions', () => {
    const data = singleTask(); const instance = data.instances[0]!; const task = instance.tasks[0]!;
    const root = instance.template.nodes.find(n => n.kind === 'agent' && n.isRoot)!;
    expect(nodeSessions(data, instance, task, root).map(s => s.id)).toEqual([instance.rootSessionId]);
    const builder = instance.template.nodes.find(n => n.id === 'n-build')!;
    expect(nodeSessions(data, instance, task, builder).map(s => s.id)).toEqual(['s-wf-build-a']);
  });
});
