// "Bring the window to the front" for a clicked notification (U3 Q-15, T055). The renderer can only ask; it says nothing
// about which window or how: the main process always acts on its own main window.

/** The part of `BrowserWindow` this uses. */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Restores a minimized window, shows it and gives it focus. Returns false when there is no window to bring forward. */
export function focusWindow(win: FocusableWindow | null): boolean {
  if (win === null || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}
