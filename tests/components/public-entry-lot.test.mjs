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
  'publicPresentation', 'publicLineReceipt'];
const cleanups = [];
let loads = 0;
afterEach(() => { while (cleanups.length > 0) cleanups.pop()(); });

async function mount({ award: hydrated, event = frame() } = {}) {
  const originals = new Map([...BRIDGES, 'Audio'].map((name) => [name, Object.getOwnPropertyDescriptor(window, name)]));
  const play = HTMLMediaElement.prototype.play;
  const theme = document.documentElement.dataset.theme;
  const audio = { count: 0 };
  const receipts = [];
  const ch = { event: channel(event), theme: channel('light'), meta: channel(), prizes: channel(),
    lineAward: hydrated === undefined ? channel() : channel(hydrated), presentation: channel() };
  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  [['publicEvent', ch.event], ['publicTheme', ch.theme], ['publicEventMeta', ch.meta], ['publicEventPrizes', ch.prizes],
    ['publicLineAward', ch.lineAward], ['publicPresentation', ch.presentation],
    ['publicLineReceipt', { started: (id) => receipts.push(id) }],
    ['Audio', function Audio() { audio.count++; }]].forEach(([name, value]) => define(name, value));
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
  return { ch, receipts, audio, dispose, destroy };
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
  expect(counts()).to.deep.equal([[1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [2, 0, 2]]);
  m.dispose();
  m.dispose();
  expect(counts()).to.deep.equal([[1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [2, 2, 0]]);
  const before = lineAward().textContent;
  m.ch.lineAward.emit(null);
  expect(lineAward().textContent).to.equal(before);
});
