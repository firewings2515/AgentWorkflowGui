import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{app,core,contracts,adapters}/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
