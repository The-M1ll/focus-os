import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Builds the extension into extension/dist (load that folder as an unpacked extension).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: { background: resolve(import.meta.dirname, 'src/background.ts'), options: resolve(import.meta.dirname, 'src/options.html'), blocked: resolve(import.meta.dirname, 'src/blocked.html') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js', assetFileNames: 'assets/[name][extname]' },
    },
  },
});
