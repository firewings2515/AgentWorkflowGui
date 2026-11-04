// T055: a clicked notification brings the window forward; the AppUserModelID matches the installer's appId.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_USER_MODEL_ID } from './app-id';
import { type FocusableWindow, focusWindow } from './focus-window';

const fakeWindow = (state: { minimized?: boolean; destroyed?: boolean } = {}) => {
  const calls: string[] = [];
  const win: FocusableWindow = {
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: vi.fn(() => calls.push('restore')),
    show: vi.fn(() => calls.push('show')),
    focus: vi.fn(() => calls.push('focus')),
  };
  return { win, calls };
};

describe('T055 focusWindow', () => {
  it('a minimized window is restored, then shown, then focused', () => {
    const { win, calls } = fakeWindow({ minimized: true });
    expect(focusWindow(win)).toBe(true);
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });

  it('a window that is not minimized is shown and focused without restore()', () => {
    const { win, calls } = fakeWindow();
    expect(focusWindow(win)).toBe(true);
    expect(calls).toEqual(['show', 'focus']);
  });

  it('no window, or one that is gone, is left alone', () => {
    expect(focusWindow(null)).toBe(false);
    const { win, calls } = fakeWindow({ destroyed: true, minimized: true });
    expect(focusWindow(win)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('T055 AppUserModelID', () => {
  it('equals the appId of electron-builder.yml', () => {
    const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8');
    const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1];
    expect(appId).toBeDefined();
    expect(APP_USER_MODEL_ID).toBe(appId);
  });
});
