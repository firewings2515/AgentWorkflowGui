import { useEffect } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { FitViewOptions, ReactFlowState } from '@xyflow/react';

export const PROGRESS_MIN_ZOOM = 0.01;
export const progressFitOptions = { minZoom: PROGRESS_MIN_ZOOM, maxZoom: 1, padding: 0.15 };
// Read measured internals: with read-only controlled nodes (no onNodesChange),
// ReactFlow's nodesInitialized flag can remain false after ResizeObserver measures them.
// A primitive signature also catches later measurements without refitting on selection/pan.
function measuredGeometry(state: ReactFlowState): string | null {
  if (!state.width || !state.height) return null;
  const nodes = [...state.nodeLookup.values()].filter(node => !node.hidden);
  if (!nodes.length || nodes.some(node => !node.measured.width || !node.measured.height)) return null;
  return JSON.stringify([state.width, state.height, nodes.map(node => [
    node.id, node.internals.positionAbsolute.x, node.internals.positionAbsolute.y,
    node.measured.width, node.measured.height,
  ])]);
}

/** Fit only complete measurements, then refit when their geometry changes. */
export function ProgressFit({ options = progressFitOptions }: { options?: FitViewOptions }) {
  const geometry = useStore(measuredGeometry);
  const { fitView, viewportInitialized } = useReactFlow();
  useEffect(() => {
    if (!geometry || !viewportInitialized) return;
    // Coalesce layout/ResizeObserver updates and cancel work for an old task or size.
    const frame = requestAnimationFrame(() => { void fitView(options); });
    return () => cancelAnimationFrame(frame);
  }, [geometry, viewportInitialized, fitView, options]);
  return null;
}
