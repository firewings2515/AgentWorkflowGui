// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlow } from '@xyflow/react';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowProgress } from './WorkflowProgress';
import { ProgressFit, progressFitOptions, PROGRESS_MIN_ZOOM } from './workflow-canvas/ProgressFit';

// Observe the actual component boundary while keeping the real graph and fit component mounted.
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, ReactFlow: vi.fn((props: Parameters<typeof ReactFlow>[0]) => <actual.ReactFlow {...props} />) };
});
vi.mock('./workflow-canvas/ProgressFit', async importOriginal => {
  const actual = await importOriginal<typeof import('./workflow-canvas/ProgressFit')>();
  return { ...actual, ProgressFit: vi.fn(actual.ProgressFit) };
});
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('WorkflowProgress graph wiring', () => {
  it('passes directed dependency edges and switches tasks by clicking a real graph node', () => {
    render(<WorkflowProgress snapshot={fixtureSnapshot} instanceId="inst-login" onOpen={vi.fn()} onBack={vi.fn()} />);
    const dependencyProps = vi.mocked(ReactFlow).mock.calls.map(([props]) => props).find(props => props.nodes?.some(node => node.id === 'task-a'))!;
    expect(dependencyProps.edges).toHaveLength(1);
    expect(dependencyProps.edges).toMatchObject([{ id: '["task-a","task-c"]', source: 'task-a', target: 'task-c' }]);
    const graph = screen.getByRole('region', { name: 'Task 依賴關係圖' });
    fireEvent.click(graph.querySelector('.react-flow__node[data-id="task-c"]')!);
    const list = within(screen.getByRole('region', { name: '群組 task 清單' }));
    expect(list.getByRole('button', { name: '登入頁 UI · task-c' }).getAttribute('aria-pressed')).toBe('true');
    expect(list.getByRole('button', { name: '表單驗證 · task-a' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('heading', { name: '登入頁 UI' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '各 node 的 session 與日誌' })).queryByRole('button', { name: '開啟 實作：表單驗證' })).toBeNull();
  });

  it('wires progressFitOptions and renders ProgressFit inside the workflow ReactFlow', () => {
    const data = structuredClone(fixtureSnapshot);
    data.instances[0]!.tasks = [data.instances[0]!.tasks[0]!];
    render(<WorkflowProgress snapshot={data} instanceId="inst-login" onOpen={vi.fn()} onBack={vi.fn()} />);
    const calls = vi.mocked(ReactFlow).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [props] of calls) {
      expect(props.nodes?.some(node => node.type === 'progress')).toBe(true);
      expect(props.fitView).toBe(true);
      expect(props.fitViewOptions).toBe(progressFitOptions);
      expect(props.minZoom).toBe(PROGRESS_MIN_ZOOM);
    }
    expect(ProgressFit).toHaveBeenCalled();
  });
});
