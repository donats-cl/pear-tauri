import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/entry.ts'),
      name: 'PearInject',
      formats: ['iife'],
      fileName: 'inject',
    },
    outDir: 'dist',
    minify: true,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
