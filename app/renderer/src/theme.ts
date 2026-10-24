import type { UiPreferences } from '../../../contracts';

export type Theme = UiPreferences['theme'];
export const THEME_KEY = 'awg.renderer.theme';

export function readTheme(fallback: Theme = 'dark'): Theme {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return theme === 'light' || theme === 'dark' ? theme : fallback;
  } catch {
    return fallback;
  }
}
