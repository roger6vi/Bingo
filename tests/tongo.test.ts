import assert from 'node:assert/strict';
import test from 'node:test';
import { createTongoController, createTongoPlayback, tongoPlayable, validPresentation } from '../src/tongo.mjs';

const tongo = (id = 1, durationMs = 3000) => ({ kind: 'tongo', id, durationMs });
type View = { busy: boolean; pending: boolean; progress: number | null; error: string | null };

function operator(respond: () => Promise<unknown>) {
  let now = 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 1, calls = 0;
  const renders: View[] = [];
  const controller = createTongoController({ playTongo: () => { calls++; return respond(); } },
    { render: (state: View) => renders.push(state) }, {
      now: () => now,
      schedule: (done: () => void) => { timers.set(nextTimer, done); return nextTimer++; },
      cancel: (id: number) => { timers.delete(id); },
    });
  const advance = (ms: number) => {
    now += ms;
    const due = [...timers.entries()];
    timers.clear();
    for (const [, done] of due) done();
  };
  return { controller, renders, advance, calls: () => calls, timers, last: () => renders.at(-1)! };
}

test('signals are validated strictly', () => {
  assert.equal(validPresentation(tongo()), true);
  for (const bad of [null, [], 'tongo', { ...tongo(), kind: 'bingo' }, tongo(0), tongo(1.5), tongo(-1),
    tongo(1, 100), tongo(1, 60000), tongo(1, Number.NaN), { kind: 'tongo', id: '1', durationMs: 3000 }]) {
    assert.equal(validPresentation(bad), false, JSON.stringify(bad));
  }
});

test('Tongo is offered only for a fresh, settled, playable snapshot', () => {
  const state = { snapshot: {}, stale: false, pending: false, phase: 'drawing' };
  assert.equal(tongoPlayable(state), true);
  assert.equal(tongoPlayable({ ...state, phase: 'line_declared' }), true);
  for (const blocked of [null, { ...state, snapshot: null }, { ...state, stale: true }, { ...state, pending: true },
    { ...state, phase: 'checking_line' }, { ...state, phase: 'finished' }, { ...state, phase: null }]) {
    assert.equal(tongoPlayable(blocked), false);
  }
});

test('an acknowledged Tongo shows private progress, suppresses repeats, then releases', async () => {
  let resolve!: (value: unknown) => void;
  const f = operator(() => new Promise((done) => { resolve = done; }));
  assert.deepEqual(f.last(), { busy: false, pending: false, progress: null, error: null });
  const first = f.controller.play();
  void f.controller.play();
  assert.deepEqual([f.calls(), f.last()], [1, { busy: true, pending: true, progress: null, error: null }]);
  resolve({ ok: true, presentation: tongo() });
  await first;
  assert.deepEqual(f.last(), { busy: true, pending: false, progress: 0, error: null });
  await f.controller.play();
  assert.equal(f.calls(), 1);
  f.advance(1500);
  assert.equal(f.last().progress, 0.5);
  f.advance(1500);
  assert.deepEqual(f.last(), { busy: false, pending: false, progress: null, error: null });
  assert.equal(f.timers.size, 0);
});

test('failures and malformed acknowledgements never show playback', async () => {
  for (const [response, error] of [
    [{ ok: false, code: 'public_unavailable', message: 'Open the public window, then try Tongo again.' },
      'Open the public window, then try Tongo again.'],
    [{ ok: true, presentation: tongo(1, 1) }, 'Invalid Tongo response.'],
    [undefined, 'Invalid Tongo response.'],
  ] as const) {
    const f = operator(async () => response);
    await f.controller.play();
    assert.deepEqual(f.last(), { busy: false, pending: false, progress: null, error });
  }
  const rejected = operator(() => Promise.reject(new Error('ipc closed')));
  await rejected.controller.play();
  assert.deepEqual(rejected.last(), { busy: false, pending: false, progress: null, error: 'Could not start Tongo. Try again.' });
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

test('Tongo components are themed only by semantic tokens, with no per-theme forks, bridges, or storage', async () => {
  const { readFileSync } = await import('node:fs');
  for (const name of ['tongo', 'tongo-control']) {
    const code = readFileSync(new URL(`../src/components/bingo-${name}.mjs`, import.meta.url), 'utf8');
    assert.equal([...code.matchAll(/customElements\.define\(/g)].length, 1);
    assert.match(code, /var\(--bingo-color-/);
    assert.doesNotMatch(code, /data-theme|pixel-classic|high-contrast|#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(|--bingo-reference-|--bingo-tongo/i);
    assert.doesNotMatch(code, /\bwindow\b|desktop|publicPresentation|ipcRenderer|localStorage|sessionStorage|indexedDB/);
  }
});
