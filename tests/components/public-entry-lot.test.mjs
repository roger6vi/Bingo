import { expect } from '@open-wc/testing';

// Drives the real public entry: the shipped public.html body plus a fresh evaluation of public-ui.mjs, fed by
// mocked preload bridges. Only the entry script and the CSS module (see the runner config) are not loaded as-is.
const IDS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const ES = ['Rojo', 'Azul', 'Verde', 'Amarillo', 'Morado', 'Naranja'];
const colorIndex = (n) => (Number.isInteger(n) ? Number((BigInt(n) - 1n) % 6n) : 0);
const snapshot = { calledNumbers: [], phase: 'drawing', lastTransitionAt: null };
const frame = (changed = false) => ({ ok: true, snapshot, ...(changed ? { eventChanged: true } : {}) });
const award = (extra = {}, winnerCount = 3) => ({ eventId: 'e1', winnerCount, totalCents: 1000,
  shareCents: Math.floor(1000 / winnerCount), remainderCents: 1000 % winnerCount, lot: 'Cesta',
  lotResolution: 'resolved', ...extra });
const numbered = (n, extra = {}) => ({ origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
  participantNumber: n, colorId: IDS[colorIndex(n)], ...extra });
const legacy = { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' };
const withResult = (result, winnerCount = 7) => award({ lotResult: result }, winnerCount);
const signal = (id) => ({ kind: 'line', id, durationMs: 4000 });

function channel(...initial) {
  const ch = { listeners: new Set(), subs: 0, unsubs: 0,
    subscribe(callback) {
      ch.subs++;
      ch.listeners.add(callback);
      if (initial.length > 0) callback(initial[0]);
      return () => { ch.unsubs++; ch.listeners.delete(callback); };
    },
    emit(value) { for (const callback of [...ch.listeners]) callback(value); } };
  return ch;
}

const BRIDGES = ['publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes', 'publicLineAward',
  'publicPresentation', 'publicLineReceipt', 'publicLineLot'];
// Injected before every entry import and restored on teardown: the page's media query and, when `timed`, its 4000 ms timers.
const GLOBALS = ['Audio', 'matchMedia', 'setTimeout', 'clearTimeout'];
const realSetTimeout = window.setTimeout;
const realClearTimeout = window.clearTimeout;
const cleanups = [];
let loads = 0;
afterEach(() => { while (cleanups.length > 0) cleanups.pop()(); });

async function mount({ award: hydrated, event = frame(), reduced = false, timed = false } = {}) {
  const originals = new Map([...BRIDGES, ...GLOBALS].map((name) => [name, Object.getOwnPropertyDescriptor(window, name)]));
  const play = HTMLMediaElement.prototype.play;
  const theme = document.documentElement.dataset.theme;
  const audio = { count: 0 };
  const receipts = [];
  const ch = { event: channel(event), theme: channel('light'), meta: channel(), prizes: channel(),
    lineAward: hydrated === undefined ? channel() : channel(hydrated), presentation: channel(), lot: channel() };
  const mq = { matches: reduced, adds: 0, removes: 0, saved: [],
    addEventListener: (type, callback) => { mq.adds++; mq.saved.push(callback); },
    removeEventListener: () => { mq.removes++; },
    change: (matches) => { mq.matches = matches; mq.saved.forEach((callback) => callback({ matches })); } };
  // Only 4000 ms timers are virtual (the lot playback); every other delay stays real so settle() and the page still run.
  const clock = { now: 0, count: 0, timers: new Map(),
    tick(ms) {
      clock.now += ms;
      for (const [id, timer] of [...clock.timers]) if (timer.due <= clock.now) { clock.timers.delete(id); timer.fn(); }
    } };
  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  [['publicEvent', ch.event], ['publicTheme', ch.theme], ['publicEventMeta', ch.meta], ['publicEventPrizes', ch.prizes],
    ['publicLineAward', ch.lineAward], ['publicPresentation', ch.presentation],
    ['publicLineReceipt', { started: (id) => receipts.push(id) }], ['publicLineLot', ch.lot],
    ['matchMedia', () => mq], ['Audio', function Audio() { audio.count++; }]].forEach(([name, value]) => define(name, value));
  if (timed) {
    define('setTimeout', (fn, delay, ...args) => {
      if (delay !== 4000) return realSetTimeout(fn, delay, ...args);
      clock.timers.set(-(++clock.count), { fn, due: clock.now + delay });
      return -clock.count;
    });
    define('clearTimeout', (id) => { if (!clock.timers.delete(id)) realClearTimeout(id); });
  }
  HTMLMediaElement.prototype.play = () => { audio.count++; return Promise.resolve(); };

  const parsed = new DOMParser().parseFromString(await (await fetch('/src/public.html')).text(), 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  const nodes = [...parsed.body.childNodes].map((node) => document.importNode(node, true));
  document.body.append(...nodes);
  const dispose = () => window.dispatchEvent(new Event('pagehide'));
  let restored = false;
  const destroy = () => {
    if (restored) return;
    restored = true;
    dispose();
    nodes.forEach((node) => node.remove());
    originals.forEach((descriptor, name) => { delete window[name]; if (descriptor) Object.defineProperty(window, name, descriptor); });
    HTMLMediaElement.prototype.play = play;
    if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  };
  cleanups.push(destroy);
  await import(`/src/public-ui.mjs?entry=${++loads}`);
  await settle();
  return { ch, receipts, audio, dispose, destroy, mq, clock };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lineAward = () => document.getElementById('line-award');
const celebration = () => document.getElementById('line-celebration');
const expectHidden = () => { expect(lineAward().textContent).to.equal(''); expect(lineAward().hidden).to.equal(true); };

async function play(m, id) {
  m.ch.presentation.emit(signal(id));
  await celebration().updateComplete;
  await settle();
}

it('shows a persisted numbered winner with its translated stored colour and no presentation, then reconnects statically', async () => {
  const stored = withResult(numbered(7));
  const first = await mount({ award: stored });
  expect(lineAward().hidden).to.equal(false);
  expect(lineAward().textContent).to.include('Ganador del lote: nº 7 · Rojo');
  expect(first.receipts).to.deep.equal([]);
  expect(first.audio.count).to.equal(0);
  expect(celebration().active).to.equal(false);
  expect(lineAward().matches('a,button,input,[tabindex],[aria-live]') || lineAward().children.length > 0).to.equal(false);
  const facts = lineAward().textContent;
  first.destroy();
  const second = await mount({ award: stored });
  expect(lineAward().textContent).to.equal(facts);
  expect([second.receipts, second.audio.count, celebration().active]).to.deep.equal([[], 0, false]);
  await play(second, 'explicit-1');
  expect(celebration().facts).to.equal(facts);
  expect(second.receipts).to.deep.equal(['explicit-1']);
});

it('repeats colours by participant number in constant work, even for the largest safe integers', async () => {
  const m = await mount();
  const cases = [[1, 6], [6, 6], [7, 7], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]];
  for (const [n, winnerCount] of cases) {
    m.ch.lineAward.emit(withResult(numbered(n), winnerCount));
    m.ch.event.emit(frame());
    expect(lineAward().textContent, `participant ${n}`).to.include(`nº ${n} · ${ES[colorIndex(n)]}`);
  }
  expect(lineAward().textContent).to.not.include('sin repartir · nº');
  expect([m.receipts, m.audio.count]).to.deep.equal([[], 0]);
});

it('says explicitly that a legacy winner is unknown, and invents no winner for an old ordinary award', async () => {
  const m = await mount({ award: withResult(legacy) });
  expect(lineAward().textContent).to.include('Ganador del lote desconocido (registro anterior)');
  expect(lineAward().textContent).to.not.match(/nº|Rojo|Azul/);
  m.ch.lineAward.emit(award({ lotResolution: 'pending' }, 3));
  m.ch.event.emit(frame());
  expect(lineAward().textContent).to.include('Línea declarada');
  expect(lineAward().textContent).to.not.match(/Ganador del lote|nº/);
  m.ch.lineAward.emit(award({ lotResolution: 'resolved' }, 3));
  m.ch.event.emit(frame());
  expect(lineAward().textContent).to.include('Lote: Cesta');
  expect(lineAward().textContent).to.not.match(/Ganador del lote|nº|desconocido/);
});

const malformed = {
  'unknown palette version': withResult(numbered(7, { paletteVersion: 2 })),
  'unknown colour': withResult(numbered(7, { colorId: 'pink' })),
  'colour not matching the number': withResult(numbered(7, { colorId: 'blue' })),
  'number above winner count': withResult(numbered(8)),
  'zero number': withResult(numbered(0, { colorId: 'orange' })),
  'fractional number': withResult(numbered(1.5, { colorId: 'red' })),
  'unsafe number': withResult(numbered(2 ** 53, { colorId: 'green' }), Number.MAX_SAFE_INTEGER),
  'result resolution not resolved': withResult(numbered(7, { resolution: 'pending' })),
  'unknown origin': withResult(numbered(7, { origin: 'other' })),
  'null result': withResult(null),
  'winner with a pending root resolution': award({ lotResolution: 'pending', lotResult: numbered(3) }),
  'none origin under a resolved root': withResult({ origin: 'none', resolution: 'pending' }),
  'legacy winner named': withResult({ ...legacy, winner: 'Ana' }),
};
for (const [name, bad] of Object.entries(malformed)) {
  it(`clears visible text and cached celebration facts for ${name}`, async () => {
    const m = await mount({ award: withResult(numbered(7)) });
    expect(lineAward().textContent).to.include('nº 7');
    m.ch.lineAward.emit(bad);
    m.ch.event.emit(frame());
    expectHidden();
    await play(m, 'after-bad');
    expect(celebration().facts).to.equal('');
  });
}

it('clears unreadable or null awards from the text and from the cache that explicit celebrations copy', async () => {
  for (const bad of [null, undefined, 'x', [], { ...award(), eventId: '' }]) {
    const m = await mount({ award: withResult(legacy) });
    m.ch.lineAward.emit(bad);
    m.ch.event.emit(frame());
    expectHidden();
    await play(m, 'after-null');
    expect(celebration().facts).to.equal('');
    m.destroy();
  }
});

it('keeps an award delivered before an event frame, but clears stale facts on a change or an unusable frame', async () => {
  const stored = withResult(numbered(2));
  const m = await mount({ award: stored });
  expect(lineAward().hidden).to.equal(false);
  m.ch.event.emit(frame(true));
  expectHidden();
  m.ch.lineAward.emit(stored);
  m.ch.event.emit(frame(true));
  expect(lineAward().hidden).to.equal(false);
  m.ch.event.emit(frame());
  m.ch.event.emit(frame());
  expect(lineAward().hidden).to.equal(false);
  m.ch.event.emit(frame(true));
  expectHidden();
  m.destroy();
  for (const unusable of [{ ok: false, code: 'event_unavailable', message: 'x' }, null,
    { ok: true, snapshot: { ...snapshot, phase: 'bogus' } }]) {
    const fresh = await mount({ award: stored });
    fresh.ch.lineAward.emit(stored);
    fresh.ch.event.emit(unusable);
    expectHidden();
    await play(fresh, 'unusable');
    expect(celebration().facts).to.equal('');
    fresh.destroy();
  }
});

it('does not show hydrated facts when the first event frame is unusable', async () => {
  await mount({ award: withResult(numbered(2)), event: { ok: false, code: 'storage_failure', message: 'x' } });
  expectHidden();
});

it('keeps ordinary declaration, draw, history and explicit celebration behaviour', async () => {
  const event = { ok: true, snapshot: { calledNumbers: [5, 12], phase: 'line_declared', lastTransitionAt: '2025-01-01T00:00:00.000Z' } };
  const m = await mount({ award: award(), event });
  const text = lineAward().textContent;
  expect(text).to.include('Línea declarada · 3 ganadores');
  expect(document.getElementById('called-count').value).to.equal('2');
  expect(document.getElementById('remaining-count').value).to.equal('88');
  expect(document.getElementById('latest-number').value).to.equal(12);
  expect(document.getElementById('called-numbers').calledNumbers).to.deep.equal([5, 12]);
  expect(document.getElementById('phase-status').message).to.equal('Current phase: Line declared');
  expect(m.receipts).to.deep.equal([]);
  await play(m, 'ordinary');
  expect(celebration().facts).to.equal(text);
  expect(celebration().active).to.equal(true);
  expect(m.receipts).to.deep.equal(['ordinary']);
});

it('unsubscribes every bridge once on pagehide and ignores later deliveries', async () => {
  const m = await mount({ award: withResult(numbered(3)) });
  const counts = () => Object.values(m.ch).map((ch) => [ch.subs, ch.unsubs, ch.listeners.size]);
  expect(counts()).to.deep.equal([[1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [2, 0, 2], [1, 0, 1]]);
  m.dispose();
  m.dispose();
  expect(counts()).to.deep.equal([[1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [2, 2, 0], [1, 1, 0]]);
  const before = lineAward().textContent;
  m.ch.lineAward.emit(null);
  expect(lineAward().textContent).to.equal(before);
});

// Transient lot playback: a hidden Spanish line beside the static award, started only by a matching live signal.
const lot = () => document.getElementById('line-lot-playback');
const WINNER = 'Ganador del lote: nº 7 · Rojo';
const expectLot = (text) => { expect(lot().hidden).to.equal(text === null); expect(lot().textContent).to.equal(text ?? ''); };
const lotSignal = (id, n = 7) => ({ id, participantNumber: n, colorId: IDS[colorIndex(n)] });
const stored = withResult(numbered(7));
const unavailable = { ok: false, code: 'storage_failure', message: 'x' };

it('never animates for a stored winner at startup, reconnect, recovery or an award and frame alone', async () => {
  const first = await mount({ award: stored, timed: true });
  expectLot(null);
  first.ch.lineAward.emit(stored);
  first.ch.event.emit(frame());
  first.ch.event.emit(unavailable);
  first.ch.event.emit(frame());
  expectLot(null);
  expect(first.clock.timers.size).to.equal(0);
  first.destroy();
  const second = await mount({ award: stored, timed: true });
  expectLot(null);
  expect([second.clock.timers.size, second.audio.count, second.receipts, celebration().active]).to.deep.equal([0, 0, [], false]);
});

it('ignores early, mismatched and malformed signals', async () => {
  const m = await mount({ timed: true });
  m.ch.lot.emit(lotSignal('no-award'));
  m.ch.lineAward.emit(stored);
  m.ch.lot.emit(lotSignal('before-frame'));
  m.ch.event.emit(frame());
  const bad = [lotSignal('other-number', 3), { ...lotSignal('other-colour'), colorId: 'blue' }, { ...lotSignal('extra'), extra: 1 },
    lotSignal(''), lotSignal('zero', 0), { id: 'partial' }, null, 'signal'];
  bad.forEach((value) => m.ch.lot.emit(value));
  expectLot(null);
  expect(m.clock.timers.size).to.equal(0);
  m.ch.lot.emit(lotSignal('valid'));
  expectLot(WINNER);
});

it('shows the known winner for exactly four seconds with no audio, receipt or history change', async () => {
  const m = await mount({ award: stored, timed: true });
  const before = lineAward().textContent;
  m.ch.lot.emit(lotSignal('live'));
  expectLot(WINNER);
  expect(lot().lang).to.equal('es');
  m.clock.tick(3999);
  expectLot(WINNER);
  m.clock.tick(1);
  expectLot(null);
  expect([lineAward().textContent, m.audio.count, m.receipts, celebration().active]).to.deep.equal([before, 0, [], false]);
  expect(document.getElementById('called-count').value).to.equal('0');
});

it('neither extends nor queues a duplicate or overlapping signal', async () => {
  const m = await mount({ award: stored, timed: true });
  m.ch.lot.emit(lotSignal('first'));
  m.clock.tick(1000);
  m.ch.lot.emit(lotSignal('first'));
  m.ch.lot.emit(lotSignal('second'));
  m.clock.tick(2999);
  expectLot(WINNER);
  m.clock.tick(1);
  expectLot(null);
  m.clock.tick(4000);
  m.ch.lot.emit(lotSignal('first'));
  expectLot(null);
  expect(m.clock.timers.size).to.equal(0);
  m.ch.lot.emit(lotSignal('third'));
  expectLot(WINNER);
});

const cancels = {
  'an invalid award': (m) => m.ch.lineAward.emit(withResult(numbered(7, { paletteVersion: 2 }))),
  'a null award': (m) => m.ch.lineAward.emit(null),
  'an error frame': (m) => m.ch.event.emit(unavailable),
  'an event change without a fresh award': (m) => m.ch.event.emit(frame(true)),
  'a new fresh award for a new event': (m) => { m.ch.lineAward.emit({ ...stored, eventId: 'e2' }); m.ch.event.emit(frame(true)); },
};
for (const [name, change] of Object.entries(cancels)) {
  it(`cancels a running lot and never replays it on ${name}`, async () => {
    const m = await mount({ award: stored, timed: true });
    m.ch.lot.emit(lotSignal('running'));
    expectLot(WINNER);
    change(m);
    expectLot(null);
    expect(m.clock.timers.size).to.equal(0);
    m.ch.lot.emit(lotSignal('running'));
    expectLot(null);
  });
}

it('keeps the original deadline across an ordinary healthy frame', async () => {
  const m = await mount({ award: stored, timed: true });
  m.ch.lot.emit(lotSignal('deadline'));
  m.clock.tick(2000);
  m.ch.event.emit(frame());
  m.clock.tick(1999);
  expectLot(WINNER);
  m.clock.tick(1);
  expectLot(null);
});

it('consumes a signal under reduced motion, cancels when it turns on, and never replays', async () => {
  const m = await mount({ award: stored, reduced: true, timed: true });
  m.ch.lot.emit(lotSignal('burned'));
  expectLot(null);
  m.mq.change(false);
  m.ch.lot.emit(lotSignal('burned'));
  expectLot(null);
  m.ch.lot.emit(lotSignal('running'));
  expectLot(WINNER);
  m.mq.change(true);
  expectLot(null);
  expect(m.clock.timers.size).to.equal(0);
  m.ch.lot.emit(lotSignal('while-reduced'));
  m.mq.change(false);
  m.ch.lot.emit(lotSignal('running'));
  m.ch.lot.emit(lotSignal('while-reduced'));
  expectLot(null);
});

it('cleans up once on pagehide: one unsubscribe, one media removal, no timer, and late callbacks are inert', async () => {
  const m = await mount({ award: stored, timed: true });
  const [lateSignal] = m.ch.lot.listeners;
  m.ch.lot.emit(lotSignal('running'));
  expect([m.ch.lot.subs, m.ch.lot.unsubs, m.ch.lot.listeners.size, m.mq.adds, m.mq.removes, m.clock.timers.size]).to.deep.equal([1, 0, 1, 1, 0, 1]);
  m.dispose();
  m.dispose();
  expect([m.ch.lot.subs, m.ch.lot.unsubs, m.ch.lot.listeners.size, m.mq.adds, m.mq.removes, m.clock.timers.size]).to.deep.equal([1, 1, 0, 1, 1, 0]);
  expectLot(null);
  lateSignal(lotSignal('late'));
  m.mq.change(false);
  m.mq.change(true);
  m.clock.tick(5000);
  expectLot(null);
  expect(m.clock.timers.size).to.equal(0);
});
