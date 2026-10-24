import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{app,core,contracts,adapters,tests}/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Keep the renderer stylesheet's text for the layout declaration test (jsdom has no layout).
    css: { include: [/styles\.css\?raw$/] },
  },
});
