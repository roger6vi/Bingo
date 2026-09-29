import assert from 'node:assert/strict';
import test from 'node:test';
import { createTongoPlayback, validPresentation } from '../src/tongo.mjs';

const tongo = (id = 1, durationMs = 3000) => ({ kind: 'tongo', id, durationMs });

test('signals are validated strictly', () => {
  assert.equal(validPresentation(tongo()), true);
  for (const bad of [null, [], 'tongo', { ...tongo(), kind: 'bingo' }, tongo(0), tongo(1.5), tongo(-1),
    tongo(1, 100), tongo(1, 60000), tongo(1, Number.NaN), { kind: 'tongo', id: '1', durationMs: 3000 }]) {
    assert.equal(validPresentation(bad), false, JSON.stringify(bad));
  }
});

test('the public page plays each new valid signal once and ignores repeats, overlaps, and junk', () => {
  let listener!: (signal: unknown) => void;
  let unsubscribed = false;
  const events: string[] = [], timers: Array<{ done: () => void; delay: number }> = [];
  const playback = createTongoPlayback({ subscribe: (callback: (signal: unknown) => void) => {
    listener = callback;
    return () => { unsubscribed = true; };
  } }, { show: () => events.push('show'), hide: () => events.push('hide') },
  (done: () => void, delay: number) => { timers.push({ done, delay }); return timers.length; }, () => events.push('cancel'));
  listener({ kind: 'tongo', id: 1 });
  listener(tongo(2));
  listener(tongo(3));
  assert.deepEqual([events, timers.map(({ delay }) => delay)], [['show'], [3000]]);
  timers[0].done();
  listener(tongo(2));
  listener(tongo(4, 2000));
  assert.deepEqual([events, timers.map(({ delay }) => delay)], [['show', 'hide', 'show'], [3000, 2000]]);
  playback.cleanup();
  assert.deepEqual([events.at(-1), unsubscribed], ['cancel', true]);
});

test('the Tongo overlay is themed only by semantic tokens, with no per-theme forks, bridges, or storage', async () => {
  const { readFileSync } = await import('node:fs');
  const { loadContracts, semanticVariable, validateTokenContracts } = await import('../scripts/token-contract.mjs');
  // Every consumed variable must exist in all three themes; an undefined one would silently paint nothing.
  const defined = new Set(validateTokenContracts(loadContracts()).keys.map(semanticVariable));
  for (const name of ['tongo']) {
    const code = readFileSync(new URL(`../src/components/bingo-${name}.mjs`, import.meta.url), 'utf8');
    for (const [variable] of code.matchAll(/--bingo-[\w-]+/g)) assert.ok(defined.has(variable), `undefined token ${variable}`);
    assert.equal([...code.matchAll(/customElements\.define\(/g)].length, 1);
    assert.match(code, /var\(--bingo-color-/);
    assert.doesNotMatch(code, /data-theme|pixel-classic|high-contrast|#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(|--bingo-reference-|--bingo-tongo/i);
    assert.doesNotMatch(code, /\bwindow\b|desktop|publicPresentation|ipcRenderer|localStorage|sessionStorage|indexedDB/);
  }
});
