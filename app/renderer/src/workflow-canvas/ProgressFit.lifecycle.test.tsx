// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { getViewportForBounds, ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react';
import type { Node, ReactFlowInstance, ReactFlowState, Viewport } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressFit, progressFitOptions } from './ProgressFit';

const nodes: Node[] = [
  { id: 'root', position: { x: 0, y: 100 }, data: {} },
  { id: 'merge', position: { x: 1060, y: 100 }, data: {} },
];
let store: ReturnType<typeof useStoreApi>;
let flow: ReactFlowInstance;
const setViewport = vi.fn((viewport: Viewport) => Promise.resolve(viewport));

function Capture() {
  const api = useStoreApi();
  const instance = useReactFlow();
  useLayoutEffect(() => { store = api; flow = instance; });
  return <ProgressFit />;
}
function Harness({ task = 'a' }: { task?: string }) {
  return <ReactFlowProvider key={task} initialNodes={nodes}><Capture /></ReactFlowProvider>;
}
function container(width: number, height = 448) {
  act(() => store.setState({ width, height,
    panZoom: { setViewport } as unknown as ReactFlowState['panZoom'],
  }));
}
// Model ResizeObserver's internal measurement update without feeding dimensions
// back through onNodesChange, exactly as the read-only controlled graphs do.
function measure(id: string, width = 220, height = 180) {
  act(() => {
    const lookup = store.getState().nodeLookup;
    const node = lookup.get(id)!;
    lookup.set(id, { ...node, measured: { width, height }, internals: {
      ...node.internals, handleBounds: { source: [], target: [] },
    } });
    store.setState({});
  });
}
async function frames() {
  // ProgressFit schedules one frame; ReactFlow's controlled fit queue schedules another.
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}
function expected(width = 937, nodeHeight = 180) {
  return getViewportForBounds({ x: 0, y: 100, width: 1280, height: nodeHeight }, width, 448,
    progressFitOptions.minZoom, progressFitOptions.maxZoom, progressFitOptions.padding);
}
beforeEach(() => { vi.useFakeTimers(); setViewport.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ProgressFit measurement lifecycle', () => {
  it('fits measured controlled nodes even when nodesInitialized is stale, and matches the manual fit', async () => {
    render(<Harness />);
    container(400);
    measure('root');
    await frames();
    expect(setViewport).not.toHaveBeenCalled();
    measure('merge');
    expect(store.getState().nodesInitialized).toBe(false);
    // Container settles AFTER the nodes are measured, before the scheduled fit.
    container(937);
    await frames();
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(setViewport.mock.calls[0]![0]).toEqual(expected());
    act(() => { void flow.fitView(progressFitOptions); });
    await frames();
    expect(setViewport).toHaveBeenCalledTimes(2);
    expect(setViewport.mock.calls[1]![0]).toEqual(expected());
  });

  it('refits when the container changes after initialization and when measured node sizes settle later', async () => {
    render(<Harness />);
    container(400); measure('root'); measure('merge');
    await frames();
    expect(setViewport.mock.lastCall![0]).toEqual(expected(400));
    expect(store.getState().nodesInitialized).toBe(true);
    for (const width of [937, 1300, 937]) {
      container(width); await frames();
      expect(setViewport.mock.lastCall![0]).toEqual(expected(width));
    }
    measure('merge', 220, 300); await frames();
    expect(setViewport).toHaveBeenCalledTimes(5);
    expect(setViewport.mock.lastCall![0]).toEqual(expected(937, 300));
    // User pan/zoom and status/selection updates must not reset the viewport.
    act(() => store.setState({ transform: [50, 60, 1.5] }));
    await frames();
    expect(setViewport).toHaveBeenCalledTimes(5);
  });

  it('cancels an old task fit and fits the newly selected task only after its measurements arrive', async () => {
    const view = render(<Harness />);
    container(400); measure('root'); measure('merge');
    view.rerender(<Harness task="b" />);
    container(937); measure('root');
    await frames();
    expect(setViewport).not.toHaveBeenCalled();
    measure('merge'); await frames();
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(setViewport.mock.lastCall![0]).toEqual(expected());
    container(1300);
    view.unmount(); await frames();
    expect(setViewport).toHaveBeenCalledTimes(1);
  });
});
