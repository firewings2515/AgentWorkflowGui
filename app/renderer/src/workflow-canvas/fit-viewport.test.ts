import { getViewportForBounds } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { fitWorkflowViewport, MIN_CANVAS_ZOOM } from './fit-viewport';

describe('workflow viewport fitting', () => {
  const bounds = { x: 80, y: 80, width: 1020, height: 360 };
  const root = { x: 80, y: 80, width: 220, height: 180 };

  it('keeps the entire root inside a narrow canvas at the readable zoom floor', () => {
    const viewport = fitWorkflowViewport(bounds, root, 380, 400);
    expect(viewport.zoom).toBe(MIN_CANVAS_ZOOM);
    expect(root.x * viewport.zoom + viewport.x).toBe(16);
    expect((root.x + root.width) * viewport.zoom + viewport.x).toBeLessThan(380);
    expect(root.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(16);
    expect((root.y + root.height) * viewport.zoom + viewport.y).toBeLessThan(400);
  });

  it('centers a fitting graph normally after widening the canvas', () => {
    const viewport = fitWorkflowViewport(bounds, root, 1500, 800);
    expect(viewport.zoom).toBeGreaterThan(MIN_CANVAS_ZOOM);
    expect(viewport).toEqual(getViewportForBounds(bounds, 1500, 800, MIN_CANVAS_ZOOM, 1, 0.12));
  });

  it('finds a root moved to the far right, and falls back to the left edge without a root', () => {
    const movedRoot = { ...root, x: 880, y: 1000 };
    const viewport = fitWorkflowViewport({ ...bounds, height: 1100 }, movedRoot, 380, 400);
    expect(movedRoot.x * viewport.zoom + viewport.x).toBe(16);
    expect(movedRoot.y * viewport.zoom + viewport.y).toBe(16);
    const noRoot = fitWorkflowViewport(bounds, undefined, 380, 400);
    expect(bounds.x * noRoot.zoom + noRoot.x).toBe(16);
  });
});
