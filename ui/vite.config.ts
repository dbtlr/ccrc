import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the console to `ui/dist`, which the daemon serves. Assets are hashed and
 * served immutably, so the base has to stay root-relative: the console is mounted
 * at the root of whatever origin fronts the daemon.
 *
 * `vp check` and `bun test` never read this output — the dev proxy below is the
 * only place the two processes meet during development.
 */
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    sourcemap: false,
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/healthz': 'http://127.0.0.1:7433',
      '/repos': 'http://127.0.0.1:7433',
      '/sessions': 'http://127.0.0.1:7433',
    },
  },
});
