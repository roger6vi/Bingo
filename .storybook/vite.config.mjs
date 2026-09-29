import { defineConfig } from 'vite';

// Storybook's own (empty) Vite config, so it never inherits the renderer's vite.config.mjs (root: src/,
// outDir: dist/renderer/). Storybook supplies root and output; build options live in main.mjs viteFinal.
export default defineConfig({});
