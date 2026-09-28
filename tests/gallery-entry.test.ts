import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the gallery is a development-only Vite entry excluded from packaged pages', () => {
  const config = source('vite.config.mjs');
  const inputs = /input:\s*\{([\s\S]*?)\}/.exec(config)?.[1] ?? '';
  assert.deepEqual([...inputs.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]), ['operator', 'public']);
  assert.doesNotMatch(config, /gallery/);
  assert.equal(JSON.parse(source('package.json')).scripts.gallery, 'npm run build:tokens && vite --open /gallery.html');
  for (const page of ['operator.html', 'public.html', 'main.ts']) assert.doesNotMatch(source(`src/${page}`), /gallery/i);
});

test('the gallery page keeps the offline CSP and renders from its entry module only', () => {
  const page = source('src/gallery.html');
  // Same offline CSP as the packaged pages; only the local dev server's HMR socket may connect.
  const csp = /content="([^"]+)"/.exec(source('src/public.html'))?.[1];
  assert.ok(csp && page.includes(`content="${csp.replace("connect-src 'none'", 'connect-src ws://localhost:*')}"`));
  assert.match(page, /<link rel="stylesheet" href="\.\/screen\.css">/);
  assert.match(page, /<html lang="en" data-theme="jules">/);
  assert.match(page, /<script type="module" src="\.\/gallery\.mjs"><\/script>/);
  assert.doesNotMatch(page, /<(?:style|script)\b[^>]*>\s*[^<\s]/i);
  const entry = source('src/gallery.mjs');
  assert.match(entry, /renderGallery\(document\.getElementById\('gallery'\)\)/);
  assert.doesNotMatch(source('src/gallery-view.mjs'), /\b(?:desktop|publicEvent|publicTheme|ipcRenderer|localStorage)\b/);
});
