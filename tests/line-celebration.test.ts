import assert from 'node:assert/strict';
import test from 'node:test';
import { createCelebrationPlayback, createLineCelebrationPlayback, validLineSignal } from '../src/line-celebration.mjs';
import { validPresentation } from '../src/tongo.mjs';

const line = (id: unknown = 'p1', durationMs: unknown = 4000) => ({ kind: 'line', id, durationMs });

function page(options: { renderGate?: Promise<void>; showThrows?: boolean } = {}) {
  let listener: (value: unknown) => void = () => {};
  let unsubscribed = 0;
  const timers = new Map<number, { done: () => void; delay: number }>();
  let next = 1;
  const events: string[] = [];
  const playback = createLineCelebrationPlayback(
    { subscribe: (callback: (value: unknown) => void) => { listener = callback; return () => { unsubscribed++; }; } },
    { show: (signal: { id: string }) => {
      events.push(`show:${signal.id}`);
      if (options.showThrows) throw new Error('render failed');
      return options.renderGate;
    }, hide: () => { events.push('hide'); } },
    { started: (id: string) => { events.push(`receipt:${id}`); } },
    (done: () => void, delay: number) => { timers.set(next, { done, delay }); return next++; },
    (id: number) => { timers.delete(id); });
  return { receive: (value: unknown) => listener(value), events, timers, playback, unsubscribed: () => unsubscribed };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('only the fixed line signal shape is valid', () => {
  assert.equal(validLineSignal(line()), true);
  for (const bad of [null, 'line', line(''), line(7), line('p', 3999), line('p', 4001), line('p', '4000'),
    { kind: 'tongo', id: 'p1', durationMs: 4000 }, { id: 'p1', durationMs: 4000 }]) {
    assert.equal(validLineSignal(bad), false);
  }
});

test('Tongo ignores line signals and the line playback ignores Tongo signals', () => {
  assert.equal(validPresentation(line()), false);
  const p = page();
  p.receive({ kind: 'tongo', id: 1, durationMs: 3000 });
  assert.deepEqual(p.events, []);
});

test('a valid signal shows once, reports the receipt after rendering, and hides after its duration', async () => {
  let release: () => void = () => {};
  const p = page({ renderGate: new Promise<void>((resolve) => { release = resolve; }) });
  p.receive(line());
  assert.deepEqual(p.events, ['show:p1']);
  await tick();
  assert.deepEqual(p.events, ['show:p1'], 'no receipt until the overlay has actually rendered');
  release();
  await tick();
  assert.deepEqual([...p.timers.values()].map((timer) => timer.delay), [4000]);
  assert.deepEqual(p.events, ['show:p1', 'receipt:p1']);
  [...p.timers.values()][0].done();
  assert.deepEqual(p.events, ['show:p1', 'receipt:p1', 'hide']);
});

test('repeated ids, overlapping signals and junk never replay or reset the overlay', async () => {
  const p = page();
  p.receive(line('p1'));
  p.receive(line('p1'));
  p.receive(line('p2'));
  p.receive('junk');
  await tick();
  assert.deepEqual(p.events, ['show:p1', 'receipt:p1']);
  [...p.timers.values()][0].done();
  p.receive(line('p1'));
  assert.deepEqual(p.events, ['show:p1', 'receipt:p1', 'hide']);
  p.receive(line('p2'));
  assert.equal(p.events.at(-1), 'show:p2');
});

test('a failed render sends no receipt, and a cleanup before rendering finishes suppresses it', async () => {
  const failing = page({ showThrows: true });
  failing.receive(line());
  await tick();
  assert.deepEqual(failing.events, ['show:p1', 'hide']);
  assert.equal(failing.timers.size, 0);

  let release: () => void = () => {};
  const gated = page({ renderGate: new Promise<void>((resolve) => { release = resolve; }) });
  gated.receive(line());
  gated.playback.cleanup();
  release();
  await tick();
  assert.deepEqual(gated.events, ['show:p1']);
  assert.equal(gated.timers.size, 0);
  assert.equal(gated.unsubscribed(), 1);
});

test('a new page starts idle: nothing plays until a signal arrives on that page', () => {
  const p = page();
  assert.deepEqual(p.events, []);
  assert.equal(p.timers.size, 0);
});

test('the full duration starts only after a successful render, together with the receipt', async () => {
  let release: () => void = () => {};
  const p = page({ renderGate: new Promise<void>((resolve) => { release = resolve; }) });
  p.receive(line());
  await tick();
  assert.equal(p.timers.size, 0, 'no hide timer while rendering is pending');
  assert.deepEqual(p.events, ['show:p1']);
  release();
  await tick();
  assert.deepEqual([...p.timers.values()].map((timer) => timer.delay), [4000], 'the complete 4000 ms starts after rendering');
  assert.deepEqual(p.events, ['show:p1', 'receipt:p1']);
  [...p.timers.values()][0].done();
  assert.equal(p.events.at(-1), 'hide');
});

test('a rejected render hides without a receipt or timer; a duplicate during rendering is ignored', async () => {
  let fail: (reason: unknown) => void = () => {};
  const p = page({ renderGate: new Promise<void>((_resolve, reject) => { fail = reject; }) });
  p.receive(line());
  p.receive(line());
  p.receive(line('p2'));
  fail(new Error('render failed'));
  await tick();
  assert.deepEqual(p.events, ['show:p1', 'hide']);
  assert.equal(p.timers.size, 0);
});

// Bingo (BG04C): one shared overlay run for both kinds; each receipt goes only to its own kind's sender.
function sharedPage(renderGate?: Promise<void>) {
  let listener: (value: unknown) => void = () => {};
  const timers = new Map<number, () => void>();
  let next = 1;
  const events: string[] = [];
  createCelebrationPlayback(
    { subscribe: (callback: (value: unknown) => void) => { listener = callback; return () => {}; } },
    { show: (signal: { kind: string; id: string }) => { events.push(`show:${signal.kind}:${signal.id}`); return renderGate; },
      hide: () => { events.push('hide'); } },
    { line: { started: (id: string) => { events.push(`line:${id}`); } },
      bingo: { started: (id: string) => { events.push(`bingo:${id}`); } } },
    (done: () => void) => { timers.set(next, done); return next++; }, (id: number) => { timers.delete(id); });
  return { receive: (value: unknown) => listener(value), events, timers };
}
const bingo = (id = 'b1', durationMs: unknown = 4000) => ({ kind: 'bingo', id, durationMs });

test('a Bingo signal plays the shared overlay once and receipts only on the Bingo sender after rendering', async () => {
  const p = sharedPage();
  p.receive(bingo());
  p.receive(bingo());
  p.receive(line('l1'));
  p.receive(bingo('b2'));
  await tick();
  assert.deepEqual(p.events, ['show:bingo:b1', 'bingo:b1'], 'duplicate and busy signals are ignored');
  [...p.timers.values()][0]();
  p.receive(bingo('b1'));
  p.receive(bingo('b3', 3999));
  p.receive(line('l1'));
  await tick();
  assert.deepEqual(p.events.slice(2), ['hide', 'show:line:l1', 'line:l1']);
});

test('a failed Bingo render sends no receipt, and the line-only playback ignores Bingo signals', async () => {
  const p = sharedPage(Promise.reject(new Error('render failed')));
  p.receive(bingo());
  await tick();
  assert.deepEqual([p.events, p.timers.size], [['show:bingo:b1', 'hide'], 0]);
  const lineOnly = page();
  lineOnly.receive(bingo());
  assert.deepEqual(lineOnly.events, []);
});
