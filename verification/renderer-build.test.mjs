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

// The sandboxed public preload may send exactly one thing: the line-presentation start receipt. No invoke, no
// sendSync, no other channel, and no way to pass anything but a validated string id.
function assertOnlyLineReceiptSend(preload) {
  const sends = [...preload.matchAll(/ipcRenderer\.(send|invoke|sendSync|postMessage|sendToHost)\b[^;]*;/g)].map(([call]) => call);
  assert.equal(sends.length, 1, 'exactly one renderer-to-main call');
  assert.match(sends[0], /^ipcRenderer\.send\(PUBLIC_LINE_RECEIPT_CHANNEL, id\);$/);
  assert.match(preload, /PUBLIC_LINE_RECEIPT_CHANNEL = 'public:line-presentation-started'/);
  assert.match(preload, /exposeInMainWorld\('publicLineReceipt', Object\.freeze\(\{\s*started: \(id\) => \{\s*if \(typeof id === 'string'/);
}

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

test('built audience shell bundles six Lit tags under the existing offline CSP', () => {
  const html = text('dist/renderer/public.html');
  const js = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.js')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  for (const name of ['panel', 'number', 'latest-draw', 'status', 'number-board', 'prize-display']) {
    assert.match(html, new RegExp(`<bingo-${name}\\b`));
    assert.ok(js.includes(`bingo-${name}`), `bundled ${name} registration`);
  }
  assert.match(html, /<bingo-number-board id="called-numbers"><\/bingo-number-board>/);
  assert.match(html, /<bingo-prize-display id="prizes" lang="es"><\/bingo-prize-display>/);
  assert.doesNotMatch(html, /<ol id="called-numbers"|<video\b|Sample media preview/);
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
  // Every operator form control is a shared, form-associated Lit component; the cue mute checkbox,
  // volume slider, and test trigger are the deliberate native controls left in the page.
  assert.doesNotMatch(html, /<select\b/, 'the theme picker is a shared component');
  assert.match(html, /<input type="checkbox" id="cue-mute"[^>]*>/);
  assert.match(html, /<input id="cue-volume" type="range"/);
  assert.match(html, /<input type="button" id="cue-test"/);
  assert.equal((html.match(/<input\b/g) ?? []).length, 3, 'only the cue mute, volume, and test controls remain native inputs');
});

test('the public page bundles no sample media and never autoplays', () => {
  const html = text('dist/renderer/public.html');
  assert.doesNotMatch(html, /<video\b|<source\b|\bautoplay\b/i);
  const assets = readdirSync(path.join(renderer, 'assets'));
  assert.deepEqual(assets.filter((file) => file.endsWith('.mp4')), [], 'the sample clip is not shipped');
  assert.ok(!assets.filter((file) => file.endsWith('.js')).some((file) => text(`dist/renderer/assets/${file}`).includes('sample.mp4')));
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

test('Storybook and stories are never bundled into the renderer', () => {
  const files = readdirSync(renderer, { recursive: true }).map(String);
  assert.deepEqual(files.filter((file) => /stories|storybook/i.test(file)), []);
  for (const file of files.filter((name) => /\.(?:html|js)$/.test(name))) {
    assert.doesNotMatch(text(`dist/renderer/${file}`), /storybook|\.stories\b/i, file);
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
  assert.match(publicPreload, /exposeInMainWorld\('publicEventPrizes'/);
  assertOnlyLineReceiptSend(publicPreload);
  assert.match(text('dist/preload.js'), /invoke\('theme:set', theme\)/);
  assert.match(text('dist/preload.js'), /invoke\('events:update', id, meta\)/);
  assert.match(text('dist/preload.js'), /invoke\('prizes:update', id, prizes\)/);
  assert.match(main, /registerPrizeIpc\)\(electron_1\.ipcMain, store, operatorOnly/);
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

test('operator cue sounds are emitted as local files, referenced by the operator bundle, never inlined', () => {
  const assets = readdirSync(path.join(renderer, 'assets'));
  const bundle = (prefix) => assets.filter((file) => file.startsWith(prefix) && file.endsWith('.js'))
    .map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  const js = bundle('operator-');
  for (const cue of ['line', 'bingo', 'final']) {
    const emitted = assets.filter((file) => new RegExp(`^${cue}-[\\w-]+\\.wav$`).test(file));
    assert.equal(emitted.length, 1, `one bundled ${cue} cue`);
    assert.ok(js.includes(`new URL("${emitted[0]}",import.meta.url)`), `operator bundle resolves ${emitted[0]} locally`);
  }
  assert.doesNotMatch(js, /data:audio\//);
  assert.doesNotMatch(bundle('public-'), /\.wav\b/, 'the public window loads no cue sounds');
});

test('Tongo keeps an operator-only trigger and a receive-only, never-replayed public signal', () => {
  const main = text('dist/main.js');
  assert.match(main, /registerTongoIpc\)\(electron_1\.ipcMain, store, \{ authorize: operatorOnly, publish: publicDelivery\.publishPresentation,\s*lineBusy: presentation\.busy \}\)/);
  assert.match(main, /publicDelivery\.publishCommitted, tongo\.playing, line\.active,\s*presentation\.busy\)/);
  assert.match(text('dist/preload.js'), /playTongo: \(\) => electron_1\.ipcRenderer\.invoke\('tongo:play'\)/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicPresentation'/);
  assert.match(publicPreload, /'public:presentation'/);
  assert.doesNotMatch(publicPreload, /tongo:play/);
  assertOnlyLineReceiptSend(publicPreload);
});

test('committed line awards reach the public page through a main provider and one receive-only bridge', () => {
  const main = text('dist/main.js');
  assert.match(main, /createPublicEventDelivery\)\(store, \(\) => theme\.current\(\), activeMeta, activePrizes,\s*\(\) => store\.loadLineAward\(\),\s*\(\) => store\.loadLineLotResult\(\)\)/);
  assert.match(text('dist/public-event-delivery.js'), /PUBLIC_LINE_AWARD_CHANNEL = 'public:line-award'/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicLineAward'/);
  assert.match(publicPreload, /'public:line-award'/);
  assertOnlyLineReceiptSend(publicPreload);
  // Static committed state only: no award channel on the presentation signal or an attach-time replay.
  assert.doesNotMatch(publicPreload, /public:presentation[^;]*line-award|line-award[^;]*public:presentation/);
});

test('main reconciles line presentations once at startup (interrupt, then fail pending), before any window, delivery or IPC exists', () => {
  const main = text('dist/main.js');
  const calls = main.match(/interruptStartedLinePresentations\(/g) ?? [];
  assert.equal(calls.length, 1, 'one explicit startup reconciliation');
  assert.equal((main.match(/failPendingLinePresentations\(/g) ?? []).length, 1, 'one pending reconciliation');
  const at = main.indexOf('store.interruptStartedLinePresentations()');
  const failAt = main.indexOf('store.failPendingLinePresentations()');
  assert.ok(failAt > at, 'pending is failed only after started is interrupted');
  assert.ok(failAt < main.indexOf('new electron_1.BrowserWindow'), 'before any window');
  assert.ok(at > main.indexOf('initializeCurrentEvent)('), 'after the store opens');
  for (const later of ['new electron_1.BrowserWindow', 'createPublicEventDelivery)(', 'registerLineIpc)(', 'registerEventIpc)(', 'ipcMain.on(']) {
    assert.ok(main.indexOf(later) > at, `${later} comes after the reconciliation`);
  }
  // The only presentation steps main may name are the two startup reconciliations; every other transition stays
  // inside the coordinator, so nothing replays, retries or completes by itself at startup.
  assert.doesNotMatch(main, /completeLinePresentation|startLinePresentation|retryLinePresentation|replayLinePresentation/,
    'no startup replay or completion');
});

test('line presentation wiring: coordinator ports, commit-only start, receipt guard and operator-only manual channels', () => {
  const main = text('dist/main.js');
  assert.match(main, /createLinePresentationCoordinator\)\(store, \{/);
  assert.match(main, /publish: publicDelivery\.publishPresentation/);
  assert.match(main, /operator\.webContents\.send\('line:presentation', award\)/);
  assert.match(main, /committed: presentation\.begin, retry: presentation\.retry,\s*repeat: presentation\.repeat, busy: presentation\.busy, tongoPlaying: tongo\.playing/);
  assert.match(main, /ipcMain\.on\(public_event_delivery_1\.PUBLIC_LINE_RECEIPT_CHANNEL/);
  assert.match(main, /acceptLineReceipt\(event, id, publicUrl\)/);
  // A main-frame (not subframe, not same-document) navigation voids pending receipt authority at its start; the
  // finished load only re-attaches static state.
  assert.match(main, /contents\.on\('did-start-navigation', \(details\) => \{\s*if \(details\.isMainFrame && !details\.isSameDocument\)\s*publicDelivery\.navigationStarted\(contents\);\s*\}\);/);
  assert.match(main, /contents\.on\('did-finish-load', \(\) => publicDelivery\.attachAfterLoad\(contents\)\)/);
  assert.match(main, /publicUrl = \(0, node_url_1\.pathToFileURL\)\(htmlPath\('public\.html'\)\)\.href/);
  const operatorPreload = text('dist/preload.js');
  assert.match(operatorPreload, /invoke\('line:retry-presentation', id\)/);
  assert.match(operatorPreload, /invoke\('line:repeat-presentation', id\)/);
  assert.match(operatorPreload, /ipcRenderer\.on\('line:presentation', listener\)/);
  assert.doesNotMatch(operatorPreload, /public:line-presentation-started/, 'the operator cannot forge the public receipt');
  assert.match(text('dist/line-ipc.js'), /retryPresentation: 'line:retry-presentation'/);
  assert.match(text('dist/line-ipc.js'), /repeatPresentation: 'line:repeat-presentation'/);
});

// The JavaScript the public page actually loads: its entry script, modulepreloads and their static imports. The
// operator bundle is deliberately excluded: it legitimately exposes the manual line actions the public one must never.
function publicBundleFiles() {
  const assets = path.join(renderer, 'assets');
  const html = text('dist/renderer/public.html');
  const pending = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)].map(([, file]) => file);
  assert.ok(pending.length > 0, 'public.html references its script');
  const files = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, imported] of text(`dist/renderer/assets/${file}`).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) pending.push(imported);
  }
  for (const file of files) assert.ok(readdirSync(assets).includes(file), `${file} is emitted`);
  return [...files];
}
const publicBundle = () => publicBundleFiles().map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
const operatorBundle = () => readdirSync(path.join(renderer, 'assets')).filter((file) => /^operator-.*\.js$/.test(file))
  .map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
// Every way to start, retry or repeat a presentation: IPC channels and the operator-only desktop methods.
const mutationTriggers = /line:retry-presentation|line:repeat-presentation|tongo:play|retryLinePresentation|repeatLinePresentation|beginLineSetup|confirmLine/;

test('the public bundle set is exactly the public entry and its imports, never the operator entry', () => {
  const files = publicBundleFiles();
  assert.ok(files.some((file) => file.startsWith('public-')), 'public entry');
  assert.ok(!files.some((file) => file.startsWith('operator-')), 'no operator chunk is reachable from the public page');
});

test('the operator bundle intentionally exposes the manual line actions the public bundle never contains', () => {
  const operator = operatorBundle();
  assert.match(operator, /retryLinePresentation/);
  assert.match(operator, /repeatLinePresentation/);
  assert.match(operator, /onLinePresentation/);
  assert.doesNotMatch(operator, /line:retry-presentation|line:repeat-presentation/, 'channels stay inside the preload');
  assert.match(text('dist/renderer/operator.html'), /<bingo-button id="line-retry" hidden>Reintentar celebración<\/bingo-button>/);
  assert.match(text('dist/renderer/operator.html'), /<bingo-button id="line-repeat" hidden>Repetir celebración completa<\/bingo-button>/);
  assert.doesNotMatch(text('dist/renderer/public.html'), /line-retry|line-repeat|Reintentar celebración|Repetir celebración/);
  assert.doesNotMatch(publicBundle(), mutationTriggers);
});

test('the bundled public page ships the line overlay with the receipt bridge, never a trigger or a second send', () => {
  assert.match(text('dist/renderer/public.html'), /<bingo-line-celebration id="line-celebration" lang="es"><\/bingo-line-celebration>/);
  const bundle = publicBundle();
  assert.match(bundle, /customElements\.define\("bingo-line-celebration"/);
  assert.match(bundle, /publicLineReceipt/);
  assert.doesNotMatch(bundle, mutationTriggers);
});

test('the bundled public page ships the Tongo overlay but never the trigger', () => {
  assert.match(text('dist/renderer/public.html'), /<bingo-tongo id="tongo" lang="es"><\/bingo-tongo>/);
  const bundle = publicBundle();
  assert.match(bundle, /customElements\.define\("bingo-tongo"/);
  assert.match(bundle, /publicPresentation/);
  assert.doesNotMatch(bundle, mutationTriggers);
});

test('the bundled operator page ships the Tongo control in the claims row with its own status', () => {
  const html = text('dist/renderer/operator.html');
  assert.match(html, /<div class="claim-buttons">\s*<bingo-button id="claim-line"[^>]*>Línea<\/bingo-button>\s*<bingo-button id="claim-bingo"[^>]*>Bingo<\/bingo-button>\s*<bingo-tongo-control id="tongo-control"><\/bingo-tongo-control>/);
  assert.match(html, /<bingo-status id="tongo-error" hidden><\/bingo-status>/);
  const bundle = readdirSync(path.join(renderer, 'assets')).filter((file) => file.endsWith('.js'))
    .map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  assert.match(bundle, /customElements\.define\("bingo-tongo-control"/);
  assert.match(bundle, /\.playTongo\(\)/);
});
