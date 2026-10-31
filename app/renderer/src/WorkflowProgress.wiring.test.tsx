// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controls, MarkerType, Position, ReactFlow, getViewportForBounds } from '@xyflow/react';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowProgress } from './WorkflowProgress';
import { ProgressFit, progressFitOptions, PROGRESS_MIN_ZOOM } from './workflow-canvas/ProgressFit';
import { dependencyFitOptions } from './TaskDependencies';

// Observe the actual component boundary while keeping the real graph and fit component mounted.
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual,
    ReactFlow: vi.fn((props: Parameters<typeof ReactFlow>[0]) => <actual.ReactFlow {...props} />),
    Controls: vi.fn((props: Parameters<typeof Controls>[0]) => <actual.Controls {...props} />),
  };
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

  it('packs independent tasks into readable depth columns with forward arrows at 1024px', () => {
    render(<WorkflowProgress snapshot={fixtureSnapshot} instanceId="inst-login" onOpen={vi.fn()} onBack={vi.fn()} />);
    const props = vi.mocked(ReactFlow).mock.calls.map(([props]) => props).find(props => props.nodes?.some(node => node.id === 'task-a'))!;
    const nodes = props.nodes!;
    const roots = nodes.filter(node => node.id !== 'task-c');
    const dependent = nodes.find(node => node.id === 'task-c')!;
    expect(new Set(roots.map(node => node.position.x)).size).toBe(2);
    expect(new Set(roots.map(node => node.position.y)).size).toBe(3);
    expect(roots.every(node => node.position.x < dependent.position.x)).toBe(true);
    expect(nodes.every(node => node.sourcePosition === Position.Right && node.targetPosition === Position.Left)).toBe(true);
    expect(props.edges).toMatchObject([{ source: 'task-a', target: 'task-c', markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: '表單驗證 → 登入頁 UI' }]);
    // Fixture labels fit in 220 × 64 cards; all six fit at a readable scale in the 1024px page.
    const bounds = { x: 0, y: 0, width: Math.max(...nodes.map(n => n.position.x)) + 220, height: Math.max(...nodes.map(n => n.position.y)) + 64 };
    const viewport = getViewportForBounds(bounds, 937, 360, dependencyFitOptions.minZoom, dependencyFitOptions.maxZoom, dependencyFitOptions.padding);
    expect(viewport.zoom * 16).toBeGreaterThanOrEqual(12.8);
    expect(viewport.x).toBeGreaterThanOrEqual(0);
    expect(viewport.y).toBeGreaterThanOrEqual(0);
    expect(viewport.x + bounds.width * viewport.zoom).toBeLessThanOrEqual(937);
    expect(viewport.y + bounds.height * viewport.zoom).toBeLessThanOrEqual(360);
    expect(props.minZoom).toBe(dependencyFitOptions.minZoom);
    expect(vi.mocked(Controls).mock.calls.some(([props]) => props.fitViewOptions === dependencyFitOptions)).toBe(true);
    expect(vi.mocked(ProgressFit).mock.calls.some(([props]) => props.options === dependencyFitOptions)).toBe(true);
  });

  it('wires progressFitOptions and renders ProgressFit inside the workflow ReactFlow', () => {
    const data = structuredClone(fixtureSnapshot);
    data.instances[0]!.tasks = [data.instances[0]!.tasks[0]!];
    render(<WorkflowProgress snapshot={data} instanceId="inst-login" onOpen={vi.fn()} onBack={vi.fn()} />);
    const calls = vi.mocked(ReactFlow).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [props] of calls) {
      expect(props.nodes?.some(node => node.type === 'progress')).toBe(true);
      // The measured-geometry fitter owns initial fitting; no competing partial initial fit.
      expect(props.fitView).toBeUndefined();
      expect(props.minZoom).toBe(PROGRESS_MIN_ZOOM);
    }
    expect(ProgressFit).toHaveBeenCalled();
    expect(vi.mocked(Controls).mock.calls.every(([props]) => props.fitViewOptions === progressFitOptions)).toBe(true);
  });
});
