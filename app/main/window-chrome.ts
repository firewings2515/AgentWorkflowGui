// The native window chrome follows the app (R-15): no File/Edit/View bar in Windows' own light style, and
// the title bar and the window's first paint take the app's theme. The menu stays installed but hidden, so
// its keyboard shortcuts (copy/paste, zoom, and reload/devtools in development) keep working.
import type { MenuItemConstructorOptions } from 'electron';
import type { EventEnvelope, Theme } from '../../contracts';

/** The renderer's `--bg` for each theme, so the window does not flash another colour before it paints. */
export const WINDOW_BACKGROUND: Record<Theme, string> = { dark: '#10151c', light: '#edf1f5' };

/** Shortcuts only; the bar itself is hidden (`setMenuBarVisibility(false)`), and Alt does not bring it back. */
export function hiddenMenuTemplate(dev: boolean): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // Ctrl+= as well as Ctrl+Shift+=, as Chromium does.
        { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false },
        { role: 'zoomOut' },
        ...(dev ? ([{ role: 'reload' }, { role: 'toggleDevTools' }] as const) : []),
      ],
    },
  ];
}

/** The theme a saved-preferences event switches to; undefined for every other event. */
export const themeOf = (envelope: EventEnvelope): Theme | undefined =>
  envelope.event.type === 'preferences.updated' ? envelope.event.preferences.theme : undefined;
