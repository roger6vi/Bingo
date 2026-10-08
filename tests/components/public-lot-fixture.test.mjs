import { expect } from '@open-wc/testing';

// The screen fixture (.storybook/lib/screens.mjs) with the real page adapter. The runner serves no ?raw import, so the
// fixture loads through absolute URLs with its two HTML sources as module blobs. Only 4000 ms timers are virtual.
const blob = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
const page = async (name) => blob(`export default ${JSON.stringify(await (await fetch(`/src/${name}.html`)).text())}`);
const screens = await (async () => {
  const code = (await (await fetch('/.storybook/lib/screens.mjs')).text())
    .replace(/'[./]*src\/operator\.html\?raw'/, JSON.stringify(await page('operator')))
    .replace(/'[./]*src\/public\.html\?raw'/, JSON.stringify(await page('public')))
    .replaceAll(/'(?:\.\/)?(?:\.\.\/){2}src\//g, `'${location.origin}/src/`).replace(/'(?:\.\/)+fixtures\.mjs'/, `'${location.origin}/.storybook/lib/fixtures.mjs'`);
  return import(blob(code));
})();

const WINNER = { participantNumber: Number.MAX_SAFE_INTEGER, colorId: 'red' };
const TEXT = `Ganador del lote: nº ${Number.MAX_SAFE_INTEGER} · Rojo`;
const GLOBALS = ['matchMedia', 'setTimeout', 'clearTimeout'];
const cleanups = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()(); });
const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
const line = (root) => root.querySelector('#line-lot-playback');

const clock = { timers: new Map(), n: 0 };
function mount(options = {}, { attach = true } = {}) {
  const originals = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(window, name)]));
  const realSet = window.setTimeout;
  const realClear = window.clearTimeout;
  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  clock.timers.clear();
  const media = { calls: 0 };
  define('matchMedia', () => { media.calls++; return { matches: false, addEventListener() {}, removeEventListener() {} }; });
  define('setTimeout', (fn, delay, ...args) => (delay === 4000 ? (clock.timers.set(++clock.n, fn), clock.n) : realSet(fn, delay, ...args)));
  define('clearTimeout', (id) => { if (!clock.timers.delete(id)) realClear(id); });
  const port = {};
  const root = screens.publicScreen({ lotWinner: WINNER, lotPlayback: 'live', onLotHydrated: (emit) => { port.emit = emit; }, ...options });
  if (attach) document.body.append(root);
  cleanups.push(() => {
    root.disposeLotFixture?.();
    root.remove();
    originals.forEach((descriptor, name) => { delete window[name]; if (descriptor) Object.defineProperty(window, name, descriptor); });
  });
  return { root, port, media };
}
const expire = () => { for (const [id, fn] of [...clock.timers]) { clock.timers.delete(id); fn(); } };

it('shows the durable award statically and creates no adapter, query or timer before it is connected or after disposal', async () => {
  const m = mount({}, { attach: false });
  await raf();
  expect(m.root.querySelector('#line-award').textContent).to.include(TEXT);
  expect([line(m.root), m.media.calls, clock.timers.size]).to.deep.equal([null, 0, 0]);
  m.root.disposeLotFixture();
  document.body.append(m.root);
  await raf();
  expect([line(m.root), m.media.calls, clock.timers.size]).to.deep.equal([null, 0, 0]);
});

it('hydrates without a signal, plays one explicit signal for 4000 ms and never repeats a burned id', async () => {
  const m = mount();
  await raf();
  expect([line(m.root).hidden, line(m.root).textContent, clock.timers.size]).to.deep.equal([true, '', 0]);
  m.port.emit('a');
  expect([line(m.root).hidden, line(m.root).textContent, clock.timers.size]).to.deep.equal([false, TEXT, 1]);
  expect(line(m.root).textContent).to.equal(TEXT);
  expire();
  expect([line(m.root).hidden, clock.timers.size]).to.deep.equal([true, 0]);
  m.port.emit('a');
  expect(line(m.root).hidden).to.equal(true);
  m.port.emit('b');
  expect(line(m.root).hidden).to.equal(false);
});

it('is inert when removed before the deferred frame', async () => {
  const m = mount();
  m.root.remove();
  await raf();
  expect([line(m.root), m.media.calls, clock.timers.size, m.port.emit]).to.deep.equal([null, 0, 0, undefined]);
});

it('cancels the running timer on removal and on explicit disposal, and ignores later signals', async () => {
  for (const stop of [(m) => m.root.remove(), (m) => m.root.disposeLotFixture()]) {
    const m = mount();
    await raf();
    m.port.emit('a');
    expect(clock.timers.size).to.equal(1);
    stop(m);
    await Promise.resolve();
    expect([line(m.root).hidden, clock.timers.size]).to.deep.equal([true, 0]);
    m.port.emit('z');
    expect([line(m.root).hidden, clock.timers.size]).to.deep.equal([true, 0]);
  }
});

it('does not let a replaced canvas revive its signal callback in the new one', async () => {
  const first = mount();
  await raf();
  const old = first.port.emit;
  first.root.remove();
  const second = mount();
  await raf();
  old('old');
  expect([line(second.root).hidden, clock.timers.size]).to.deep.equal([true, 0]);
  second.port.emit('new');
  expect(line(second.root).hidden).to.equal(false);
});

it('keeps the forced reduced-motion fixture static: no transient line and no timer', async () => {
  const m = mount({ lotPlayback: 'reduced' });
  await raf();
  m.port.emit('a');
  expect([line(m.root).hidden, clock.timers.size]).to.deep.equal([true, 0]);
  expect(m.root.querySelector('#line-award').textContent).to.include(TEXT);
});
