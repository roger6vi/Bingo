import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const renderer = path.join(dist, 'renderer');
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
// Only the operator page may frame, and only the isolated local simulator protocol.
const pageCsp = { public: csp, operator: csp.replace("object-src 'none';", "object-src 'none'; frame-src bingo-public:;") };
const text = (file) => readFileSync(path.join(root, file), 'utf8');

// The sandboxed public preload's exercised renderer-to-main surface: the built preload is evaluated in an isolated
// in-memory context with a stub Electron, so every send and listen that actually executes is recorded. This is not
// a full Electron: the stub never invokes message callbacks, so listener bodies are not exercised paths, and the
// own-listener identity is channel-only. Static call-site counting below covers unexercised capability call sites.
function publicPreloadSurface(preload) {
  const exposes = {};
  const subscribed = [];
  const removed = [];
  const sent = [];
  const forbidden = [];
  const ipcRenderer = {
    on: (channel) => subscribed.push([channel]),
    removeListener: (channel) => removed.push([channel]),
    send: (channel, ...args) => { subscribed.push([channel]); sent.push([channel, ...args]); },
    invoke: (channel) => forbidden.push(channel),
    sendSync: (channel) => forbidden.push(channel),
    postMessage: (channel) => forbidden.push(channel),
    sendToHost: (channel) => forbidden.push(channel),
  };
  vm.runInNewContext(preload, {
    require: (name) => {
      assert.equal(name, 'electron', 'the public preload requires only Electron');
      return { contextBridge: { exposeInMainWorld: (key, api) => { exposes[key] = api; } }, ipcRenderer };
    },
    module: { exports: {} }, exports: {}, __filename: 'public-preload.js', __dirname: dist,
  });
  return { exposes, subscribed, removed, sent, forbidden };
}

// Receive-only bridges, in source order, each bound to exactly one listen channel.
const receiveOnlyPublicApis = ['publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes',
  'publicLineAward', 'publicBingoAward', 'publicPresentation', 'publicLineLot', 'publicBingoLot'];
const receiveOnlyPublicChannels = ['public:event-state', 'public:theme', 'public:event-meta', 'public:event-prizes',
  'public:line-award', 'public:bingo-award', 'public:presentation', 'public:line-lot', 'public:bingo-lot'];
// The window's only two sends: one fixed channel per receipt kind, never interchangeable.
const publicReceiptApis = { publicLineReceipt: 'public:line-presentation-started',
  publicBingoReceipt: 'public:bingo-presentation-started' };

// The closed two-kind receipt contract: exactly the nine receive-only subscriptions plus two fixed-kind sends, each
// from a frozen bridge whose only argument is one validated primitive id. No invoke, sendSync, postMessage or
// sendToHost, and no channel outside the whitelist. The single-line receipt behavior of the old contract stays
// pinned: the line send is still exactly its own channel with exactly one id argument.
function assertTwoKindPublicReceipts(preload) {
  const surface = publicPreloadSurface(preload);
  assert.deepEqual(Object.keys(surface.exposes).sort(),
    [...receiveOnlyPublicApis, ...Object.keys(publicReceiptApis)].sort(), 'the exposed bridge set is closed');
  receiveOnlyPublicApis.forEach((name, index) => {
    const channel = receiveOnlyPublicChannels[index];
    const api = surface.exposes[name];
    assert.ok(Object.isFrozen(api), `${name} is frozen`);
    assert.deepEqual(Object.keys(api), ['subscribe'], `${name} exposes only receive-only subscribe`);
    api.subscribe(() => {});
    assert.deepEqual(surface.subscribed.at(-1), [channel], `${name} listens only on ${channel}`);
    surface.exposes[name].subscribe(() => {})();
    assert.deepEqual(surface.removed.at(-1), [channel], `${name} unsubscribes its own listener`);
  });
  assert.deepEqual([...new Set(surface.subscribed.map(([channel]) => channel))].sort(),
    [...receiveOnlyPublicChannels].sort(), 'no listen channel outside the whitelist');
  for (const [name] of Object.entries(publicReceiptApis)) {
    const api = surface.exposes[name];
    assert.ok(Object.isFrozen(api), `${name} is frozen`);
    assert.deepEqual(Object.keys(api), ['started'], `${name} exposes only started`);
    // The guard is a strict primitive check: string, non-empty, at most 128 characters.
    assert.match(preload, new RegExp(`${name}', Object\\.freeze\\(\\{\\s*started: \\(id\\) => \\{\\s*` +
      `if \\(typeof id === 'string' && id\\.length > 0 && id\\.length <= 128\\)`));
    for (const bad of [undefined, null, 42, {}, ['id'], '', 'x'.repeat(129)]) api.started(bad);
  }
  assert.deepEqual(surface.sent, [], 'an invalid receipt id never sends');
  assert.deepEqual(surface.forbidden, [], 'no invoke, sendSync, postMessage or sendToHost exists');
  // Baseline static capability count, independent of exercised paths: exactly two renderer-to-main call sites exist
  // (the two receipt sends). A third send hidden in a listener or dead branch that the stub never runs is caught here.
  const capabilityCalls = [...preload.matchAll(/ipcRenderer\.(?:send|invoke|sendSync|postMessage|sendToHost)\b\s*\(/g)];
  assert.equal(capabilityCalls.length, 2, 'exactly two renderer-to-main capability call sites');
  assert.doesNotMatch(preload, /ipcRenderer\.(?:invoke|sendSync|postMessage|sendToHost)\b/);
  // The only valid sends: exactly one per kind, on that kind's own channel, with nothing but the string id.
  const id = 'x'.repeat(128);
  surface.exposes.publicLineReceipt.started(id);
  surface.exposes.publicBingoReceipt.started(id);
  assert.deepEqual(surface.sent, [
    ['public:line-presentation-started', id],
    ['public:bingo-presentation-started', id],
  ]);
  assert.match(preload, /PUBLIC_LINE_RECEIPT_CHANNEL = 'public:line-presentation-started'/);
  assert.match(preload, /PUBLIC_BINGO_RECEIPT_CHANNEL = 'public:bingo-presentation-started'/);
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
  assertTwoKindPublicReceipts(publicPreload);
  assert.match(text('dist/preload.js'), /invoke\('theme:set', theme\)/);
  assert.match(text('dist/preload.js'), /invoke\('events:update', id, meta\)/);
  assert.match(text('dist/preload.js'), /invoke\('prizes:update', id, prizes\)/);
  assert.match(main, /registerPrizeIpc\)\(electron_1\.ipcMain, store, operatorOnly/);
  const css = readdirSync(path.join(renderer, 'assets'))
    .filter((file) => file.endsWith('.css')).map((file) => text(`dist/renderer/assets/${file}`)).join('\n');
  assert.match(css, /html:not\(\[data-theme\]\) body\s*\{\s*visibility:\s*hidden/);
});

test('the two-kind receipt whitelist catches a mutated send channel in the built preload', () => {
  const preload = text('dist/public-preload.js');
  const mutated = preload.replace("'public:bingo-presentation-started'", "'public:line-presentation-started'");
  assert.notEqual(mutated, preload);
  assert.throws(() => assertTwoKindPublicReceipts(mutated), assert.AssertionError);
});

test('the receipt contract catches a third send hidden inside a listener the stub never exercises', () => {
  const preload = text('dist/public-preload.js');
  // The behavioral stub records only exercised paths and does not invoke message callbacks, so a send capability
  // buried in an actual listener body stays invisible to it. This mutation adds exactly such a hidden third call.
  const mutated = preload.replace('const listener = (_event, result) => callback(result);',
    "const listener = (_event, result) => { electron_1.ipcRenderer.send('public:evil', result); callback(result); }");
  assert.notEqual(mutated, preload);
  assert.throws(() => assertTwoKindPublicReceipts(mutated), assert.AssertionError);
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
  assert.match(main, /registerTongoIpc\)\(electron_1\.ipcMain, store, \{ authorize: operatorOnly, publish: publicDelivery\.publishPresentation,\s*lineBusy: presentations\.busy \}\)/);
  // Both celebration kinds share one busy guard: the Bingo wiring uses it for Tongo, draws and event changes too.
  assert.match(main, /otherSetupActive: line\.active, tongoPlaying: tongo\.playing, presentationBusy: presentations\.busy,/);
  // The manual draw wiring keeps its full shared-guard tail: committed publish, Tongo gate, shared setup guard, busy.
  assert.match(main, /publicDelivery\.publishCommitted, tongo\.playing, setupActive,\s*presentations\.busy\)/);
  assert.match(main, /publicDelivery\.publishMeta, setupActive, presentations\.busy\)/);
  assert.match(text('dist/preload.js'), /playTongo: \(\) => electron_1\.ipcRenderer\.invoke\('tongo:play'\)/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicPresentation'/);
  assert.match(publicPreload, /'public:presentation'/);
  assert.doesNotMatch(publicPreload, /tongo:play/);
  assertTwoKindPublicReceipts(publicPreload);
});

test('committed line awards reach the public page through a main provider and one receive-only bridge', () => {
  const main = text('dist/main.js');
  assert.match(main, /createPublicEventDelivery\)\(store, \(\) => theme\.current\(\), activeMeta, activePrizes,\s*\(\) => store\.loadLineAward\(\),\s*\(\) => store\.loadLineLotResult\(\),\s*\(\) => store\.loadBingoAward\(\),\s*\(\) => store\.loadBingoLotResult\(\)\)/);
  const delivery = text('dist/public-event-delivery.js');
  assert.match(delivery, /PUBLIC_LINE_AWARD_CHANNEL = 'public:line-award'/);
  assert.match(delivery, /PUBLIC_BINGO_AWARD_CHANNEL = 'public:bingo-award'/);
  const publicPreload = text('dist/public-preload.js');
  assert.match(publicPreload, /exposeInMainWorld\('publicLineAward'/);
  assert.match(publicPreload, /'public:line-award'/);
  assert.match(publicPreload, /exposeInMainWorld\('publicBingoAward'/);
  assert.match(publicPreload, /'public:bingo-award'/);
  assertTwoKindPublicReceipts(publicPreload);
  // Static committed state only: no award channel on the presentation signal or an attach-time replay.
  assert.doesNotMatch(publicPreload, /public:presentation[^;]*line-award|line-award[^;]*public:presentation/);
  assert.doesNotMatch(publicPreload, /public:presentation[^;]*bingo-award|bingo-award[^;]*public:presentation/);
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
  for (const later of ['new electron_1.BrowserWindow', 'createPublicEventDelivery)(', 'registerLineMainWiring)(', 'registerEventIpc)(', 'ipcMain.on(']) {
    assert.ok(main.indexOf(later) > at, `${later} comes after the reconciliation`);
  }
  // The only presentation steps main may name are the two startup reconciliations; every other transition stays
  // inside the coordinator, so nothing replays, retries or completes by itself at startup.
  assert.doesNotMatch(main, /completeLinePresentation|startLinePresentation|retryLinePresentation|replayLinePresentation/,
    'no startup replay or completion');
});

test('line presentation wiring: coordinator ports, commit-only start, receipt guard and operator-only manual channels', () => {
  const main = text('dist/main.js');
  // Main only supplies the clock, timers, the public signal, the operator notifications and the receipt
  // authorization; both coordinators are constructed inside the emitted presentation wiring factory.
  assert.match(main, /createPresentationWiring\)\(store, \{/);
  assert.match(main, /now: Date\.now,\s*schedule: \(fn, ms\) => setTimeout\(fn, ms\),\s*cancel: \(handle\) => clearTimeout\(handle\),\s*publish: publicDelivery\.publishPresentation,/);
  assert.match(main, /notifyLine: \(award\) => \{ if \(!operator\.isDestroyed\(\)\)\s*operator\.webContents\.send\('line:presentation', award\); \},/);
  assert.match(main, /notifyBingo/);
  assert.match(main, /acceptLineReceipt: \(event, id\) => publicDelivery\.acceptLineReceipt\(event, id, publicUrl\),\s*acceptBingoReceipt: \(event, id\) => publicDelivery\.acceptBingoReceipt\(event, id, publicUrl\),/);
  // Main routes each receipt kind into the wiring's own kind; the delivery authorizes each by the exact public URL.
  assert.match(main, /ipcMain\.on\(public_event_delivery_1\.PUBLIC_LINE_RECEIPT_CHANNEL, \(event, id\) => \{ presentations\.lineReceipt\(event, id\); \}\);/);
  assert.match(main, /ipcMain\.on\(public_event_delivery_1\.PUBLIC_BINGO_RECEIPT_CHANNEL, \(event, id\) => \{ presentations\.bingoReceipt\(event, id\); \}\);/);
  const wiring = text('dist/presentation-wiring.js');
  assert.match(wiring, /createLinePresentationCoordinator\)\(store, \{/);
  assert.match(wiring, /createBingoPresentationCoordinator\)\(store, \{/);
  // The two kinds are mutually exclusive: neither publishes while the other is active.
  assert.match(wiring, /publish: \(signal\) => !bingo\.busy\(\) && ports\.publish\(signal\)/);
  assert.match(wiring, /publish: \(signal\) => !line\.busy\(\) && ports\.publish\(signal\)/);
  // Each kind's manual paths refuse while the other is active, before touching the store.
  assert.match(wiring, /if \(other\.busy\(\)\)\s*throw new Error\(`\$\{label\} presentation is busy`\);/);
  assert.match(wiring, /manual\(bingo, 'Bingo', line\.retry\), repeat: manual\(bingo, 'Bingo', line\.repeat\)/);
  assert.match(wiring, /manual\(line, 'Line', bingo\.retry\), repeat: manual\(line, 'Line', bingo\.repeat\)/);
  // Only a string id the delivery authorizes reaches the coordinator of that receipt's own kind.
  assert.match(wiring, /lineReceipt: \(event, id\) => typeof id === 'string' && ports\.acceptLineReceipt\(event, id\) && line\.receiptStarted\(id\)/);
  assert.match(wiring, /bingoReceipt: \(event, id\) => typeof id === 'string' && ports\.acceptBingoReceipt\(event, id\) && bingo\.receiptStarted\(id\)/);
  assert.match(wiring, /busy: \(\) => line\.busy\(\) \|\| bingo\.busy\(\)/);
  // Line's committed begin/retry/repeat stay exact, now guarded by the shared busy; the registration runs
  // through the line main wiring whose corrected port refreshes the public window without celebration (#29).
  assert.match(main, /registerLineMainWiring\)\(/);
  assert.match(main, /begin: presentation\.begin, retry: presentation\.retry,\s*repeat: presentation\.repeat, busy: presentations\.busy, tongoPlaying: tongo\.playing/);
  // A main-frame (not subframe, not same-document) navigation voids pending receipt authority at its start; the
  // finished load only re-attaches static state.
  assert.match(main, /contents\.on\('did-start-navigation', \(details\) => \{\s*if \(details\.isMainFrame && !details\.isSameDocument\)\s*publicDelivery\.navigationStarted\(contents\);\s*\}\);/);
  assert.match(main, /contents\.on\('did-finish-load', \(\) => publicDelivery\.attachAfterLoad\(contents\)\)/);
  assert.match(main, /publicUrl = \(0, node_url_1\.pathToFileURL\)\(htmlPath\('public\.html'\)\)\.href/);
  const operatorPreload = text('dist/preload.js');
  assert.match(operatorPreload, /invoke\('line:retry-presentation', id\)/);
  assert.match(operatorPreload, /invoke\('line:repeat-presentation', id\)/);
  assert.match(operatorPreload, /ipcRenderer\.on\('line:presentation', listener\)/);
  assert.doesNotMatch(operatorPreload, /public:line-presentation-started/, 'the operator cannot forge the line receipt');
  assert.doesNotMatch(operatorPreload, /public:bingo-presentation-started/, 'the operator cannot forge the Bingo receipt');
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
