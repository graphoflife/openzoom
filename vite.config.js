import { defineConfig } from 'vite';

// Relative base so the build works on any GitHub Pages sub path.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['web-ifc'] },
});
