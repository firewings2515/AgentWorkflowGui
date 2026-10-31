import { getViewportForBounds } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { progressFitOptions } from './ProgressFit';

describe('progress viewport fitting', () => {
  it.each([500, 740, 1024])('fits all five stages within %ipx instead of anchoring at the editor readability floor', width => {
    const bounds = { x: 0, y: 100, width: 1280, height: 230 };
    const viewport = getViewportForBounds(bounds, width, 450, progressFitOptions.minZoom, progressFitOptions.maxZoom, progressFitOptions.padding);
    expect(viewport.x + bounds.x * viewport.zoom).toBeGreaterThanOrEqual(0);
    expect(viewport.x + (bounds.x + bounds.width) * viewport.zoom).toBeLessThanOrEqual(width);
    expect(viewport.y + (bounds.y + bounds.height) * viewport.zoom).toBeLessThanOrEqual(450);
  });
});
