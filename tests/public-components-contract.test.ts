import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const names = ['panel', 'number', 'latest-draw', 'status', 'number-board'];

test('component browser script provisions Playwright Chromium before tokens and WTR', () => {
  const scripts = JSON.parse(source('package.json')).scripts;
  assert.equal(scripts['test:components:install'], 'playwright install chromium');
  assert.equal(
    scripts['test:components'],
    'npm run test:components:install && npm run build:tokens && ./node_modules/.bin/web-test-runner --config web-test-runner.config.mjs',
  );
});

test('five Lit elements register exactly once and consume only semantic styling', () => {
  for (const name of names) {
    const code = source(`src/components/bingo-${name}.mjs`);
    assert.match(code, /import\s*\{[^}]*LitElement[^}]*html[^}]*\}\s*from ['"]lit['"]/);
    assert.match(code, new RegExp(`customElements\\.define\\(['"]bingo-${name}['"]`));
    assert.equal([...code.matchAll(/customElements\.define\(/g)].length, 1);
    assert.doesNotMatch(code, /\bwindow\b|\b(?:ipcRenderer|publicEvent|localStorage|sessionStorage)\b|(?:get-current-event|draw-manual|draw-digital|public-snapshot)|#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(|--bingo-reference-|--bingo-(?:component|panel|number|status|latest-draw)-/i);
  }
});

test('panel, number, latest draw and status expose semantic accessible contracts', () => {
  const panel = source('src/components/bingo-panel.mjs');
  assert.match(panel, /<section\b[^>]*aria-labelledby=/);
  assert.match(panel, /<h2\b/);
  assert.match(panel, /<slot\s*\/?\s*>/);
  const number = source('src/components/bingo-number.mjs');
  assert.match(number, /Waiting for draw/);
  assert.match(number, /this\.value === null \? this\.emptyLabel : this\.value/);
  assert.match(number, /html`<span\b[^>]*>\$\{this\.value/);
  assert.doesNotMatch(number, /<output\b|role\s*=\s*["']?status\b|aria-live\s*=/i);
  const latest = source('src/components/bingo-latest-draw.mjs');
  assert.equal([...latest.matchAll(/aria-live="polite"/g)].length, 1);
  assert.match(latest, /changed\.has\('latest'\) && this\.latest !== null && this\.latest !== changed\.get\('latest'\)/);
  assert.match(latest, /this\.announcement = `Latest draw: \$\{this\.latest\}`/);
  assert.equal([...latest.matchAll(/this\.announcement\s*=/g)].length, 2, 'initial empty value and distinct latest update only');
  assert.match(latest, /<slot>/);
  assert.doesNotMatch(latest, /calledNumbers|history|<ol\b/);
  const status = source('src/components/bingo-status.mjs');
  assert.match(status, /role=\$\{.*(?:alert|status)/);
  assert.match(status, /warning|error/);
  assert.match(status, /\$\{this\.message\}/);
});

test('number board owns ordered list and remains display-only', () => {
  const board = source('src/components/bingo-number-board.mjs');
  assert.match(board, /calledNumbers: \{ attribute: false \}/);
  assert.match(board, /<ol aria-label="Called numbers in draw order">/);
  assert.match(board, /<li aria-current=/);
  assert.match(board, /li\[aria-current\]\s*\{[^}]*outline:[^}]*var\(--bingo-color-accent\)/);
  assert.match(board, /<bingo-number \.value=\$\{number\} \.compact=\$\{true\}/);
  assert.doesNotMatch(board, /aria-live|addEventListener|localStorage|replaceChildren|\.sort\(|\.slice\(/);
});

test('draw numbers keep display type while empty labels fit their host', () => {
  const number = source('src/components/bingo-number.mjs');
  assert.match(number, /this\.value === null \? ['"]empty['"] : this\.compact \? ['"]drawn compact['"] : ['"]drawn['"]/);
  assert.match(number, /<span\b[^>]*class=\$\{[^}]+\}/);
  assert.match(number, /:host\s*\{[^}]*max-width:\s*100%/);
  assert.match(number, /span\s*\{[^}]*max-width:\s*100%[^}]*box-sizing:\s*border-box/);
  assert.match(number, /compact: \{ type: Boolean \}/);
  assert.match(number, /span\.drawn\s*\{[^}]*font:[^}]*var\(--bingo-font-display\)/);
  assert.match(number, /span\.drawn\.compact\s*\{[^}]*var\(--bingo-font-size\)/);
  assert.match(number, /span\.empty\s*\{[^}]*font:[^}]*var\(--bingo-font-size\)[^}]*overflow-wrap:\s*anywhere/);
});

test('public markup composes the shell with one main and h1, draw order and separate opt-in media', () => {
  const page = source('src/public.html');
  for (const name of names) assert.match(page, new RegExp(`<bingo-${name}\\b`));
  assert.equal([...page.matchAll(/<main\b/g)].length, 1);
  assert.equal([...page.matchAll(/<h1\b/g)].length, 1);
  assert.match(page, /<h1 id="event-name">Current event<\/h1>/);
  assert.match(page, /<p id="event-details" class="event-details" hidden><\/p>/);
  for (const id of ['called-numbers', 'called-count', 'remaining-count']) assert.ok(page.includes(`id="${id}"`));
  assert.match(page, /Called: <output id="called-count" aria-live="off">0<\/output>/);
  assert.match(page, /Remaining: <output id="remaining-count" aria-live="off">90<\/output>/);
  assert.doesNotMatch(page, /aria-live="polite"/);
  assert.match(page, /<bingo-number-board id="called-numbers"><\/bingo-number-board>/);
  assert.doesNotMatch(page, /<ol id="called-numbers"/);
  assert.match(page, /Sample media preview \(not event state\)/);
  assert.match(page, /<video\b[^>]*controls[^>]*preload="none"/);
  assert.doesNotMatch(page, /\bautoplay\b|<style\b/);
});

test('public adapter maps controller fields to all display states without mutating authority', () => {
  const ui = source('src/public-ui.mjs');
  for (const name of names) assert.ok(ui.includes(`./components/bingo-${name}.mjs`));
  for (const field of ['loaded', 'calledNumbers', 'latest', 'count', 'remaining', 'stale', 'error']) {
    assert.ok(ui.includes(`state.${field}`), field);
  }
  assert.match(ui, /const bridges = publicBridges\(window\)/);
  assert.match(ui, /createPublicController\(bridges\.event/);
  assert.match(ui, /state\.stale\s*\? 'warning' : 'info'/);
  assert.match(ui, /state\.error/);
  assert.match(ui, /eventError\.tone = 'error'/);
  assert.match(ui, /status\.hidden = Boolean\(state\.error && !state\.loaded\)/);
  assert.match(ui, /eventError\.hidden = !state\.error/);
  assert.match(ui, /state\.loaded\s*\?/);
  assert.match(ui, /latestNumber\.emptyLabel = state\.loaded \? 'No draws yet' : 'Waiting for draw'/);
  assert.match(ui, /history\.calledNumbers = state\.calledNumbers/);
  assert.match(ui, /history\.loaded = state\.loaded/);
  assert.doesNotMatch(ui, /replaceChildren|HTMLOListElement/);
});

test('both windows display six committed phase labels through a separate accessible status', () => {
  const labels = {
    public: ['Drawing', 'Checking line', 'Line declared', 'Checking bingo', 'Bingo declared', 'Finished'],
    // The operator is Spanish; its labels live in the operator copy module.
    operator: ['Cantando números', 'Comprobando línea', 'Línea cantada', 'Comprobando bingo', 'Bingo cantado', 'Partida terminada'],
  };
  for (const windowName of ['operator', 'public'] as const) {
    const page = source(`src/${windowName}.html`);
    const ui = source(`src/${windowName}-ui.mjs`);
    const copy = windowName === 'operator' ? source('src/operator-copy.mjs') : ui;
    assert.match(page, /<bingo-status id="phase-status"><\/bingo-status>/);
    assert.match(ui, /phaseStatus\.message\s*=/);
    assert.match(ui, /state\.phase/);
    for (const label of labels[windowName]) assert.ok(copy.includes(`'${label}'`), `${windowName}: ${label}`);
    assert.match(ui, /eventError\.message = (?:operatorMessage\()?state\.error/);
    assert.match(ui, /eventStatus\.message|status\.message/);
  }
});

test('public layout is responsive and uses semantic colors only', () => {
  const css = source('src/screen.css');
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /@media\s*\(prefers-reduced-motion: reduce\)/);
  assert.match(css, /--bingo-color-surface/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(|--bingo-reference-|--bingo-(?:component|panel|number|status|latest-draw)-/i);
});
