import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readConfiguration } from './src/data/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = env.VITE_BASE_PATH || '/';
  if (!base.startsWith('/') || !base.endsWith('/')) {
    throw new Error('VITE_BASE_PATH must start and end with /');
  }
  readConfiguration({ ...env, BASE_URL: base });
  return {
    plugins: [react()], base,
    build: { rollupOptions: { output: { manualChunks: { map: ['maplibre-gl'] } } } },
  };
});
