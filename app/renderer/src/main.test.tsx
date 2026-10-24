// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { THEME_KEY } from './theme';

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
vi.mock('./App', () => ({ App: () => null }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => { vi.restoreAllMocks(); render.mockReset(); document.body.innerHTML = ''; });

it.each(['light', 'dark'] as const)('applies stored %s before React render', async theme => {
  localStorage.setItem(THEME_KEY, theme);
  render.mockImplementation(() => expect(document.documentElement.dataset.theme).toBe(theme));
  await import('./main');
  expect(render).toHaveBeenCalledOnce();
});

it('uses dark before render when storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  render.mockImplementation(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  await import('./main');
  expect(render).toHaveBeenCalledOnce();
});
