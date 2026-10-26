import { getViewportForBounds } from '@xyflow/react';
import type { Rect, Viewport } from '@xyflow/react';

export const MIN_CANVAS_ZOOM = 0.75;
export function fitWorkflowViewport(bounds: Rect, root: Rect | undefined, width: number, height: number): Viewport {
  const viewport = getViewportForBounds(bounds, width, height, MIN_CANVAS_ZOOM, 1, 0.12);
  if (viewport.zoom > MIN_CANVAS_ZOOM) return viewport;
  // At the readability floor the whole graph may not fit. Keep the escalation
  // target visible (or the graph's left edge if the draft has no root).
  const anchor = root ?? bounds;
  const margin = 16;
  if (anchor.x * viewport.zoom + viewport.x < margin || (anchor.x + anchor.width) * viewport.zoom + viewport.x > width - margin) {
    viewport.x = margin - anchor.x * viewport.zoom;
  }
  if (root && (root.y * viewport.zoom + viewport.y < margin || (root.y + root.height) * viewport.zoom + viewport.y > height - margin)) {
    viewport.y = margin - root.y * viewport.zoom;
  }
  return viewport;
}
