// Storybook is a development tool only: it has its own Vite config, builds to storybook-static/
// (never dist/), and nothing under src/ imports it, so the Electron bundle and its CSP are untouched.
import { sourcePaths } from '../scripts/token-contract.mjs';

/** @type {import('@storybook/web-components-vite').StorybookConfig} */
export default {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.mjs'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', 'storybook-addon-pseudo-states'],
  framework: {
    name: '@storybook/web-components-vite',
    // Do not inherit the renderer config (root: src/, outDir: dist/renderer/).
    options: { builder: { viteConfigPath: '.storybook/vite.config.mjs' } },
  },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true, enableCrashReports: false },
  docs: { defaultName: 'Overview' },
  // A focused workbench: no onboarding checklists, no git "new/changed" badges on every sidebar row,
  // and no background switcher (the theme owns the canvas).
  features: { sidebarOnboardingChecklist: false, menuOnboardingChecklist: false, changeDetection: false, backgrounds: false },
  async viteFinal(config) {
    // The theme toolbar lists every theme the token pipeline builds, so new themes appear automatically.
    config.define = { ...config.define, __BINGO_THEMES__: JSON.stringify(sourcePaths.themes) };
    // Storybook's bundles are large by nature and never ship with the app, so the chunk-size warning is
    // noise. It is set here because Storybook ignores `build` in the file named by viteConfigPath.
    config.build = { ...config.build, chunkSizeWarningLimit: 2000 };
    return config;
  },
};
