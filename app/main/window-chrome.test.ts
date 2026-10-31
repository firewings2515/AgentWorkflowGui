import { describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, type EventEnvelope } from '../../contracts';
import { hiddenMenuTemplate, themeOf, WINDOW_BACKGROUND } from './window-chrome';

const roles = (dev: boolean) =>
  hiddenMenuTemplate(dev).flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu.map((item) => item.role) : []));

describe('window chrome (R-15)', () => {
  it('keeps the editing and zoom shortcuts without a File menu', () => {
    const template = hiddenMenuTemplate(false);
    expect(template.map((menu) => menu.label)).toEqual(['Edit', 'View']);
    expect(roles(false)).toEqual(expect.arrayContaining(['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo', 'zoomIn', 'zoomOut', 'resetZoom']));
  });

  it('offers reload and devtools only in development', () => {
    expect(roles(false)).not.toContain('reload');
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']));
  });

  it('paints the window in the renderer background of each theme', () => {
    expect(WINDOW_BACKGROUND).toEqual({ dark: '#10151c', light: '#edf1f5' });
  });

  it('follows only a saved-preferences event', () => {
    const at = '2026-10-31T10:00:00+08:00';
    const saved: EventEnvelope = { schemaVersion: CONTRACTS_VERSION, seq: 1, event: { type: 'preferences.updated', preferences: { theme: 'light' }, at } };
    const other: EventEnvelope = { schemaVersion: CONTRACTS_VERSION, seq: 2, event: { type: 'snapshot.invalidated', reason: 'recovered', at } };
    expect(themeOf(saved)).toBe('light');
    expect(themeOf(other)).toBeUndefined();
  });
});
