import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const renderer = path.join(dist, 'renderer');
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const text = (file) => readFileSync(path.join(root, file), 'utf8');

for (const name of ['main', 'preload', 'public-preload']) {
  test(`tsc emits ${name}.js beside renderer`, () => {
    assert.ok(statSync(path.join(dist, `${name}.js`)).size > 0);
  });
}

test('built main loads both exact renderer pages and authorizes the operator path', () => {
  const main = text('dist/main.js');
  assert.match(main, /htmlPath = \(name\) => .*\.join\(__dirname, ['"]renderer['"], name\)/);
  assert.match(main, /operatorPath = htmlPath\(['"]operator\.html['"]\)/);
  assert.match(main, /window\.loadFile\(htmlPath\(['"]public\.html['"]\)\)/);
  assert.match(main, /pathToFileURL\)\(operatorPath\)\.href/);
  assert.match(main, /operator\.loadFile\(operatorPath\)/);
  assert.doesNotMatch(main, /['"]src['"],\s*name/);
});

for (const page of ['operator', 'public']) {
  test(`${page} page has CSP and only local, external renderer resources`, () => {
    const html = text(`dist/renderer/${page}.html`);
    assert.ok(html.includes(`content="${csp}"`), 'exact offline CSP');
    assert.match(html, /<bingo-shell\b/);
    assert.doesNotMatch(html, /<(?:script|style)\b[^>]*>\s*[^<\s]/i);
    assert.doesNotMatch(html, /\bhttps?:\/\/|(?:src|href)="(?:\/\/|data:|javascript:)/i);
    assert.doesNotMatch(html, /\b(?:autoplay|unsafe-inline|unsafe-eval)\b/i);
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
      const url = match[1];
      assert.match(url, /^\.\//, `relative asset: ${url}`);
      assert.ok(statSync(path.resolve(renderer, url)).size > 0, `emitted asset: ${url}`);
    }
    assert.match(html, /<script\b[^>]*src="\.\//i);
    assert.match(html, /<link\b[^>]*href="\.\/[^"]+\.css"/i);
  });
}

test('public sample is bundled under renderer and remains opt-in', () => {
  const html = text('dist/renderer/public.html');
  assert.match(html, /<video\b[^>]*\bcontrols\b[^>]*preload="none"/i);
  assert.match(html, /<source\b[^>]*id="sample-video-source"[^>]*type="video\/mp4"/i);
  const js = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.js')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  const media = readdirSync(path.join(renderer, 'assets')).filter((file) => file.endsWith('.mp4'));
  assert.equal(media.length, 1, 'one bundled MP4');
  assert.ok(statSync(path.join(renderer, 'assets', media[0])).size > 0);
  assert.ok(js.includes(media[0]), 'public entry references bundled MP4');
  assert.doesNotMatch(html, /\bautoplay\b/i);
});

test('renderer output stays confined to its directory', () => {
  assert.ok(existsSync(renderer));
  assert.deepEqual(readdirSync(dist).filter((name) => name.endsWith('.html')), []);
  assert.deepEqual(readdirSync(dist).filter((name) => name === 'assets'), []);
});
