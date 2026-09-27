import { playwrightLauncher } from '@web/test-runner-playwright';

export default {
  files: 'tests/components/*.test.mjs',
  nodeResolve: true,
  browsers: [playwrightLauncher({
    product: 'chromium',
    createBrowserContext: ({ browser }) => browser.newContext({ reducedMotion: 'reduce' }),
  })],
};
