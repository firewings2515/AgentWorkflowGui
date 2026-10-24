import { describe, expect, it } from 'vitest';
import { createWebPreferences } from './window-options';

describe('createWebPreferences', () => {
  it('enables the Electron security boundary', () => {
    const prefs = createWebPreferences('/path/to/preload.js');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.preload).toBe('/path/to/preload.js');
  });
});
