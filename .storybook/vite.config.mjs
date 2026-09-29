import { defineConfig } from 'vite';

// Storybook supplies its own root and output directory; its bundles are large by nature and
// never ship with the app, so the renderer's chunk-size warning would only be noise here.
export default defineConfig({ build: { chunkSizeWarningLimit: 2000 } });
