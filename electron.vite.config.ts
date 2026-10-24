import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'app/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'app/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'app/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'app/renderer/index.html') } },
    },
    plugins: [react()],
  },
});
