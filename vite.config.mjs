import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const source = fileURLToPath(new URL('./src/', import.meta.url));

export default defineConfig({
  root: source,
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        operator: fileURLToPath(new URL('./src/operator.html', import.meta.url)),
        public: fileURLToPath(new URL('./src/public.html', import.meta.url)),
      },
    },
  },
});
