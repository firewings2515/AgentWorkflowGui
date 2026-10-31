import { useEffect } from 'react';
import { useNodesInitialized, useReactFlow, useStore } from '@xyflow/react';

export const PROGRESS_MIN_ZOOM = 0.01;
export const progressFitOptions = { minZoom: PROGRESS_MIN_ZOOM, maxZoom: 1, padding: 0.15 };
/** Refit after measured node sizes and container changes, including a narrow details layout. */
export function ProgressFit() {
  const initialized = useNodesInitialized();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (initialized && width && height) void fitView(progressFitOptions);
  }, [initialized, width, height, fitView]);
  return null;
}
