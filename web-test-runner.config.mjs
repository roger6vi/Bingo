import { playwrightLauncher } from '@web/test-runner-playwright';

// public-ui.mjs imports './screen.css' for the bundler, which a browser module import cannot load.
// Only that one import, for the uniquely queried entry loads of public-entry-lot.test.mjs, becomes an empty JS
// module; layout is not exercised, and the plain source other tests fetch keeps its original import.
const emptyScreenCss = '/__public-ui-screen-css__.mjs';
const publicUiScreenCss = {
  name: 'public-ui-screen-css',
  resolveImport: ({ source, context }) =>
    source === './screen.css' && context.url.startsWith('/src/public-ui.mjs?entry=') ? emptyScreenCss : undefined,
  serve: (context) => (context.path === emptyScreenCss ? { body: 'export {};', type: 'js' } : undefined),
};

export default {
  files: 'tests/components/*.test.mjs',
  nodeResolve: true,
  plugins: [publicUiScreenCss],
  browsers: [playwrightLauncher({
    product: 'chromium',
    createBrowserContext: ({ browser }) => browser.newContext({ reducedMotion: 'reduce' }),
  })],
};
