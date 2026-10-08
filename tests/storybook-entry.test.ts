import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(source('package.json'));
const STORYBOOK_PACKAGES = ['storybook', '@storybook/web-components-vite', '@storybook/addon-docs', '@storybook/addon-a11y',
  'storybook-addon-pseudo-states', 'axe-core'];

test('Storybook is a development-only tool with its own Vite config and output directory', () => {
  for (const name of STORYBOOK_PACKAGES) {
    assert.ok(pkg.devDependencies[name], `${name} is a devDependency`);
    assert.equal(pkg.dependencies[name], undefined, `${name} is not a runtime dependency`);
  }
  assert.match(pkg.scripts['storybook:build'], /--output-dir storybook-static$/);
  assert.match(source('.gitignore'), /^\/storybook-static\/$/m);
  assert.match(source('.storybook/main.mjs'), /viteConfigPath: '\.storybook\/vite\.config\.mjs'/);
  // The renderer build knows nothing about Storybook: only the two packaged pages are inputs.
  assert.doesNotMatch(source('vite.config.mjs'), /storybook|stories/i);
  for (const script of ['build', 'build:renderer', 'package:dir', 'package:mac', 'package:win']) {
    assert.doesNotMatch(pkg.scripts[script], /storybook/i, script);
  }
});

test('packaged builds ship only dist/, never stories or Storybook config', () => {
  assert.deepEqual(JSON.parse(source('electron-builder.json')).files, ['package.json', 'dist/**/*', '!dist/**/*.map', '!node_modules/**/*']);
  const windows = source('electron-builder.win.yml');
  assert.deepEqual([...windows.matchAll(/^\s+- "?([^"\n]+)"?$/gm)].map((match) => match[1]).filter((entry) => /dist|package|node_modules/.test(entry)),
    ['dist/**/*', 'package.json', '!node_modules/**/*']);
  assert.doesNotMatch(windows, /storybook|stories|src\//i);
});

test('no app module imports Storybook or a story', () => {
  const files = readdirSync(path.join(root, 'src'), { recursive: true }).map(String)
    .filter((file) => /\.(?:m?js|ts|html)$/.test(file) && !/\.stories\.mjs$/.test(file) && !file.startsWith('stories'));
  assert.ok(files.includes('operator-ui.mjs') && files.includes('main.ts'));
  for (const file of files) {
    const text = source(`src/${file}`);
    assert.doesNotMatch(text, /from ['"](?:@?storybook|[^'"]*\.storybook\/|[^'"]*\.stories\.mjs)/, file);
    assert.doesNotMatch(text, /import ['"](?:@?storybook|[^'"]*\.storybook\/|[^'"]*\.stories\.mjs)/, file);
  }
});

test('the public lot fixture reuses the production adapter, owns its lifecycle and ships two bounded stories', () => {
  const screens = source('.storybook/lib/screens.mjs');
  const stories = source('src/stories/screens/public-display.stories.mjs');
  assert.match(screens, /import \{ createLineLotAdapter \} from '\.\.\/\.\.\/src\/public-line-lot-playback\.mjs'/);
  assert.match(screens, /import \{ describeLineAward, validLineAward \} from '\.\.\/\.\.\/src\/public-controller\.mjs'/);
  for (const part of [/MutationObserver/, /observer\?\.disconnect\(\)/, /cancelAnimationFrame/, /isConnected/, /crypto\.randomUUID\(\)/]) {
    assert.match(screens, part);
  }
  assert.doesNotMatch(screens, /window\.public|ipcRenderer|CHANNELS|setTimeout|customElements\.define/);
  for (const name of ['LotWinnerLive', 'LotWinnerReduced']) {
    const block = stories.slice(stories.indexOf(`export const ${name}`)).split(/^export const /m)[1];
    assert.match(block, /\$\{FIXTURE_NOTE\}/, name);
  }
  assert.match(stories, /'Presentation fixture using production adapter; not production-entry coverage\.'/);
  assert.equal(stories.match(/lotPlayback: 'live'/g)?.length, 1);
  assert.equal(stories.match(/lotPlayback: 'reduced'/g)?.length, 1);
});

test('the line lot playback guide is English, task-first and free of private identifiers', () => {
  const guide = source('docs/public-line-lot-playback.md');
  for (const heading of [/^# /m, /^## Public contract/m, /^## Lifecycle/m, /^## Privacy/m, /^## Fixture limits/m, /^## Checks/m]) {
    assert.match(guide, heading);
  }
  assert.match(guide, /never replays/i);
  assert.doesNotMatch(guide, /journal|ipcRenderer|CHANNELS/i);
});
