import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { readReleaseId } from './build-metadata.ts';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_RELEASE_ID': JSON.stringify(
      readReleaseId(process.env, fileURLToPath(new URL('../../.env', import.meta.url))),
    ),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  build: { sourcemap: 'hidden', target: 'es2022' },
});
