import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const renderer = path.join(dist, 'renderer');
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
// Only the operator page may frame, and only the isolated local simulator protocol.
const pageCsp = { public: csp, operator: csp.replace("object-src 'none';", "object-src 'none'; frame-src bingo-public:;") };
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
    assert.ok(html.includes(`content="${pageCsp[page]}"`), 'exact offline CSP');
    assert.match(html, page === 'operator' ? /<bingo-app-shell\b/ : /<bingo-shell\b/);
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

test('built audience shell bundles five Lit tags under the existing offline CSP', () => {
  const html = text('dist/renderer/public.html');
  const js = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.js')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  for (const name of ['panel', 'number', 'latest-draw', 'status', 'number-board']) {
    assert.match(html, new RegExp(`<bingo-${name}\\b`));
    assert.ok(js.includes(`bingo-${name}`), `bundled ${name} registration`);
  }
  assert.match(html, /<bingo-number-board id="called-numbers"><\/bingo-number-board>/);
  assert.doesNotMatch(html, /<ol id="called-numbers"/);
  assert.match(html, /Sample media preview \(not event state\)/);
  assert.doesNotMatch(html, /\b(?:autoplay|unsafe-inline|unsafe-eval)\b/i);
});

test('built operator shell bundles shared presentation under the offline CSP', () => {
  const html = text('dist/renderer/operator.html');
  const js = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.js')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  for (const name of ['app-shell', 'tabs', 'tab-panel', 'side-rail', 'operator-board', 'panel', 'status', 'number',
    'operator-summary', 'call-history', 'text-field', 'date-field', 'select-field', 'form-actions']) {
    assert.ok(js.includes(`bingo-${name}`), `bundled ${name} registration`);
  }
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<bingo-app-shell class="operator-app">[\s\S]*<h1>Consola del operador<\/h1>[\s\S]*<main class="app-main">/);
  assert.match(html, /<bingo-operator-summary id="event-summary"/);
  assert.match(html, /<bingo-operator-board id="operator-board"><\/bingo-operator-board>/);
  assert.match(html, /<bingo-call-history id="called-numbers"/);
  assert.doesNotMatch(html, /<ol id="called-numbers"|id="stale-warning"/);
  // Every operator form control is a shared, form-associated Lit component; the volume slider is the
  // one deliberate native control left in the page.
  assert.doesNotMatch(html, /<select\b/, 'the theme picker is a shared component');
  assert.match(html, /<input id="public-volume" type="range"/);
  assert.equal((html.match(/<input\b/g) ?? []).length, 1, 'only the volume range remains a native input');
});

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

test('both pages bundle the three generated themes and semantic contracts', () => {
  const css = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.css')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  assert.match(css, /:root,\s*\[data-theme=["']?jules["']?\]/);
  for (const theme of ['light', 'high-contrast']) assert.match(css, new RegExp(`\\[data-theme=["']?${theme}["']?\\]`));
  assert.doesNotMatch(css, /pixel-classic/);
  for (const key of ['color-canvas', 'color-surface', 'color-text', 'color-muted',
    'color-accent', 'color-error', 'color-focus', 'color-border', 'space-layout',
    'font-body', 'radius-surface', 'motion-normal', 'motion-easing', 'color-tie-1']) {
    assert.ok(css.includes(`--bingo-${key}:`), key);
  }
  assert.match(css, /--bingo-reference-motion-ease-standard:\s*cubic-bezier\(0?\.2,\s*0,\s*0,\s*1\)/, 'DTCG cubicBezier arrays become CSS');
  for (const page of ['operator', 'public']) {
    const html = text(`dist/renderer/${page}.html`);
    const styles = [...html.matchAll(/href="(\.\/[^\"]+\.css)"/g)]
      .map((match) => text(`dist/renderer/${match[1].slice(2)}`)).join('\n');
    for (const theme of ['jules', 'light', 'high-contrast']) {
      assert.match(styles, new RegExp(`\\[data-theme=["']?${theme}["']?\\]`), `${page} includes ${theme} CSS`);
    }
    assert.match(styles, /--bingo-color-canvas:/, `${page} includes semantic CSS`);
  }
});

test('Roboto Mono is bundled as local font files, never fetched or inlined', () => {
  const assets = readdirSync(path.join(renderer, 'assets'));
  const css = assets.filter((file) => file.endsWith('.css')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(faces.some((face) => /font-family:\s*["']?Roboto Mono Variable/.test(face)), 'Roboto Mono @font-face');
  for (const face of faces) {
    for (const [, url] of face.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      assert.match(url, /^\.\/[\w.-]+\.woff2$/, `relative local font: ${url}`);
      assert.ok(statSync(path.join(renderer, 'assets', url.slice(2))).size > 0, `emitted font: ${url}`);
    }
  }
  assert.ok(assets.some((file) => /^roboto-mono-latin-wght-normal-[\w-]+\.woff2$/.test(file)), 'latin subset emitted');
});

test('the development-only gallery is never packaged', () => {
  const files = readdirSync(renderer, { recursive: true }).map(String);
  assert.deepEqual(files.filter((file) => /gallery/i.test(file)), []);
  for (const file of files.filter((name) => /\.(?:html|js)$/.test(name))) {
    assert.doesNotMatch(text(`dist/renderer/${file}`), /gallery/i, file);
  }
});

test('generated token outputs remain ignored and untracked', () => {
  for (const file of ['src/generated/jules.css', 'src/generated/light.css', 'src/generated/high-contrast.css']) {
    assert.ok(statSync(path.join(root, file)).size > 0);
    assert.equal(execFileSync('git', ['check-ignore', file], { cwd: root, encoding: 'utf8' }).trim(), file);
    assert.equal(execFileSync('git', ['ls-files', file], { cwd: root, encoding: 'utf8' }).trim(), '');
  }
});

test('renderer output stays confined to its directory', () => {
  assert.ok(existsSync(renderer));
  assert.deepEqual(readdirSync(dist).filter((name) => name.endsWith('.html')), []);
  assert.deepEqual(readdirSync(dist).filter((name) => name === 'assets'), []);
});

test('theme selection keeps an operator-only setter, a receive-only sandboxed public channel, and no-flash CSS', () => {
  const main = text('dist/main.js');
  assert.match(main, /sandbox: true/);
  assert.match(main, /registerThemeIpc\)\(electron_1\.ipcMain/);
  assert.match(main, /createOperatorGuard\)\(operator\.webContents/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicTheme'/);
  assert.match(publicPreload, /exposeInMainWorld\('publicEventMeta'/);
  assert.doesNotMatch(publicPreload, /ipcRenderer\.(?:send|invoke|sendSync)\b/);
  assert.match(text('dist/preload.js'), /invoke\('theme:set', theme\)/);
  assert.match(text('dist/preload.js'), /invoke\('events:update', id, meta\)/);
  const css = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.css')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  assert.match(css, /html:not\(\[data-theme\]\) body\s*\{\s*visibility:\s*hidden/);
});

test('the Configuración simulator frames the bundled public page without any privileged bridge', () => {
  const html = text('dist/renderer/operator.html');
  const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(frames.length, 1);
  assert.match(frames[0], /src="bingo-public:\/\/simulator\/public\.html"/);
  assert.match(frames[0], /sandbox="allow-scripts"/);
  assert.doesNotMatch(frames[0], /allow-same-origin/);
  assert.match(frames[0], /\binert\b/);
  assert.match(frames[0], /title="Simulador de la pantalla pública"/);
  assert.ok(statSync(path.join(renderer, 'public.html')).size > 0);
  // A standard, secure local protocol lets sandboxed modules load without sharing the file:// operator origin.
  const main = text('dist/main.js');
  assert.match(main, /scheme: ['"]bingo-public['"]/);
  assert.match(main, /protocol\.handle\(['"]bingo-public['"]/);
  assert.doesNotMatch(main, /nodeIntegrationInSubFrames/);
  assert.doesNotMatch(text('dist/renderer/public.html'), /<iframe\b/);
});

test('Tongo keeps an operator-only trigger and a receive-only, never-replayed public signal', () => {
  const main = text('dist/main.js');
  assert.match(main, /registerTongoIpc\)\(electron_1\.ipcMain, store, \{ authorize: operatorOnly, publish: publicDelivery\.publishPresentation \}\)/);
  assert.match(main, /publicDelivery\.publishCommitted, tongo\.playing\)/);
  assert.match(text('dist/preload.js'), /playTongo: \(\) => electron_1\.ipcRenderer\.invoke\('tongo:play'\)/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicPresentation'/);
  assert.match(publicPreload, /'public:presentation'/);
  assert.doesNotMatch(publicPreload, /tongo:play|ipcRenderer\.(?:send|invoke|sendSync)\b/);
});
