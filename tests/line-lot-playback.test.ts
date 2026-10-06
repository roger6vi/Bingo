import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineLotPlayback } from '../src/line-lot-playback.mjs';
import { playbackFixture } from './fixtures/line-lot-playback-cases.mjs';

type View = { participantNumber: number; colorId: string } | null;
const palette = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const colorOf = (n: number) => palette[(n - 1) % palette.length];
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function award(eventId = 'e1', winnerCount = 10, number: number | null = 3, resolution = 'resolved'): any {
  const totalCents = 1000;
  const base = { eventId, winnerCount, totalCents, shareCents: Math.floor(totalCents / winnerCount),
    remainderCents: totalCents % winnerCount, lot: 'Cesta', lotResolution: resolution };
  if (number === null) return base;
  return { ...base, lotResult: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
    participantNumber: number, colorId: colorOf(number) } };
}
const frame = (extra: object = {}) => ({ loaded: true, calledNumbers: [1], latest: 1, count: 1, remaining: 89,
  phase: 'drawing', stale: false, error: null, ...extra });
const signal = (id = ID(1), participantNumber = 3, colorId = colorOf(3)) => ({ id, participantNumber, colorId });

function fixture(options: { reducedMotion?: boolean; onView?: (view: View) => void; onTimer?: () => void } = {}) {
  return playbackFixture(createLineLotPlayback, options);
}

test('staged award and frame alone never start playback', () => {
  const f = fixture();
  f.playback.observeAward(award());
  assert.equal(f.views.length, 0);
  f.playback.observeFrame(frame(), undefined);
  f.playback.observeFrame(frame(), { eventChanged: true });
  assert.deepEqual([f.views.length, f.timers.size, f.delays.length], [0, 0, 0]);
});

test('confirmed known signal shows once for exactly 4000ms then hides', () => {
  const f = fixture();
  f.confirm();
  f.send(signal());
  assert.deepEqual(f.views, [{ participantNumber: 3, colorId: 'green' }]);
  assert.deepEqual(f.delays, [4000]);
  f.advance(3999);
  assert.equal(f.views.length, 1);
  f.advance(1);
  assert.deepEqual(f.views.at(-1), null);
  assert.equal(f.views.length, 2);
});

test('duplicate id never restarts and stays burned after hide', () => {
  const f = fixture();
  f.confirm();
  f.send(signal());
  f.advance(2000);
  f.send(signal());
  assert.deepEqual([f.views.length, f.delays.length], [1, 1]);
  f.advance(2000);
  f.send(signal());
  assert.deepEqual([f.views.length, f.delays.length], [2, 1]);
});

test('overlapping different valid signal is dropped, burned and never queued', () => {
  const f = fixture();
  f.confirm();
  f.send(signal(ID(1)));
  f.advance(1000);
  f.send(signal(ID(2)));
  f.advance(3000);
  assert.deepEqual(f.views.length, 2);
  f.send(signal(ID(2)));
  f.advance(5000);
  assert.deepEqual([f.views.length, f.delays.length], [2, 1]);
  f.send(signal(ID(3)));
  assert.equal(f.views.length, 3);
});

test('malformed, extra-key, accessor, coerced and unknown-colour signals are rejected', () => {
  const f = fixture();
  f.confirm();
  const getter = { id: ID(4), participantNumber: 3 };
  Object.defineProperty(getter, 'colorId', { enumerable: true, get() { throw new Error('ran getter'); } });
  const bad = [null, 'x', [], signal('', 3), { ...signal(ID(5)), extra: 1 }, { id: ID(6), participantNumber: 3 },
    signal(ID(7), '3' as any), signal(ID(8), 3.5), signal(ID(9), 3, 'magenta'), signal(ID(10), 3, 'blue'),
    signal(ID(11), 4, colorOf(3)), signal(ID(12), 4, colorOf(4)), getter, Object.create(signal(ID(13)))];
  for (const s of bad) f.send(s);
  assert.deepEqual([f.views.length, f.delays.length], [0, 0]);
  // Rejected signals burn nothing: a valid one with a reused id still plays.
  f.send(signal(ID(5)));
  assert.equal(f.views.length, 1);
});

test('legacy, pending, not-required, stale and mismatched contexts drop the signal', () => {
  const legacy = { ...award(null as any, 10, null), lotResult: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' } };
  for (const a of [{ ...legacy, eventId: 'e1' }, { ...award('e1', 10, null, 'pending'),
    lotResult: { origin: 'none', resolution: 'pending' } }, { ...award('e1', 1, null, 'not_required'), lot: '' }]) {
    const f = fixture();
    f.confirm(a);
    f.send(signal());
    assert.equal(f.views.length, 0);
  }
  const unconfirmed = fixture();
  unconfirmed.playback.observeAward(award());
  unconfirmed.send(signal());
  assert.equal(unconfirmed.views.length, 0);
  const none = fixture();
  none.send(signal());
  none.playback.observeFrame(frame(), undefined);
  none.send(signal(ID(2)));
  assert.equal(none.views.length, 0);
});

test('maximum safe participant, repeated colours and root bounds work without enumeration', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const f = fixture();
  f.confirm(award('big', max, max));
  f.send(signal(ID(1), max, colorOf(max)));
  assert.deepEqual(f.views, [{ participantNumber: max, colorId: colorOf(max) }]);
  const repeat = fixture();
  repeat.confirm(award('e1', 20, 13));
  repeat.send(signal(ID(1), 13, 'red'));
  assert.equal(repeat.views.length, 1);
  const over = fixture();
  over.confirm(award('e1', 10, 11));
  over.send(signal(ID(1), 11, colorOf(11)));
  assert.equal(over.views.length, 0);
});

test('invalid award immediately cancels the old winner and clears context', () => {
  const f = fixture();
  f.confirm();
  f.send(signal());
  f.playback.observeAward({ eventId: 'e1' });
  assert.deepEqual(f.views.at(-1), null);
  assert.equal(f.timers.size, 0);
  f.playback.observeFrame(frame(), undefined);
  f.send(signal(ID(2)));
  assert.equal(f.views.length, 2);
});

test('award and signal copies are detached from caller mutation', () => {
  const f = fixture();
  const source = award();
  f.confirm(source);
  source.lotResult.participantNumber = 4;
  source.lotResult.colorId = colorOf(4);
  f.send(signal());
  assert.deepEqual(f.views[0], { participantNumber: 3, colorId: 'green' });
});

test('ordinary same-event award and frame updates neither extend nor cancel', () => {
  const f = fixture();
  f.confirm();
  f.send(signal());
  f.advance(2000);
  f.confirm();
  f.playback.observeFrame(frame({ count: 2 }), { eventChanged: false });
  assert.deepEqual([f.views.length, f.delays.length, f.timers.size], [1, 1, 1]);
  f.advance(2000);
  assert.deepEqual(f.views.at(-1), null);
});

test('error frame cancels before callbacks and the old id stays burned after recovery', () => {
  const f = fixture();
  f.confirm();
  f.send(signal());
  f.playback.observeFrame(frame({ error: 'x', stale: true }), { eventChanged: false });
  assert.deepEqual(f.log, ['view', 'clear', 'hide']);
  f.send(signal(ID(2)));
  assert.equal(f.views.length, 2);
  f.playback.observeFrame(frame(), undefined);
  f.send(signal(ID(1)));
  assert.equal(f.views.length, 2);
  f.send(signal(ID(3)));
  assert.equal(f.views.length, 3);
});

test('event change cancels first, clears without a fresh award and confirms a fresh one', () => {
  const f = fixture();
  f.confirm(award('a'));
  f.send(signal(ID(1)));
  f.playback.observeFrame(frame(), { eventChanged: true });
  assert.deepEqual(f.log, ['view', 'clear', 'hide']);
  f.send(signal(ID(2)));
  assert.equal(f.views.length, 2);
  f.playback.observeAward(award('b', 10, 5));
  f.playback.observeFrame(frame(), { eventChanged: true });
  f.send(signal(ID(3), 3, colorOf(3)));
  assert.equal(f.views.length, 2);
  f.send(signal(ID(3), 5, colorOf(5)));
  assert.deepEqual(f.views.at(-1), { participantNumber: 5, colorId: 'purple' });
  // Away and back to event a: previously accepted ids remain burned.
  f.playback.observeAward(award('a'));
  f.playback.observeFrame(frame(), { eventChanged: true });
  f.send(signal(ID(1)));
  assert.equal(f.views.length, 4);
  f.advance(4000);
});

test('reduced motion consumes the id with no view or timer and never replays', () => {
  const f = fixture({ reducedMotion: true });
  f.confirm();
  f.send(signal(ID(1)));
  assert.deepEqual([f.views.length, f.timers.size, f.delays.length], [0, 0, 0]);
  f.playback.setReducedMotion(false);
  f.send(signal(ID(1)));
  assert.equal(f.views.length, 0);
  f.send(signal(ID(2)));
  assert.equal(f.views.length, 1);
});

test('enabling reduced motion mid-run hides, cancels the timer and blocks replay', () => {
  const f = fixture();
  f.confirm();
  f.send(signal(ID(1)));
  f.playback.setReducedMotion(true);
  assert.deepEqual([f.views.at(-1), f.timers.size], [null, 0]);
  f.playback.setReducedMotion(false);
  f.advance(9000);
  f.send(signal(ID(1)));
  assert.equal(f.views.length, 2);
});

test('dispose unsubscribes once, hides, and later input is a no-op', () => {
  const f = fixture();
  f.confirm();
  f.send(signal(ID(1)));
  f.playback.dispose();
  f.playback.dispose();
  assert.deepEqual([f.unsubscriptions(), f.timers.size, f.views.at(-1)], [1, 0, null]);
  f.playback.observeAward(award());
  f.playback.observeFrame(frame(), undefined);
  f.playback.setReducedMotion(true);
  f.advance(9000);
  assert.deepEqual([f.views.length, f.hasHandler()], [2, false]);
});

test('reentrant duplicate signals from view and timer callbacks are burned first', () => {
  const holder: { send?: (s: unknown) => void } = {};
  const f = fixture({ onView: (view) => { if (view) holder.send?.(signal(ID(1))); },
    onTimer: () => holder.send?.(signal(ID(1))) });
  holder.send = f.send;
  f.confirm();
  f.send(signal(ID(1)));
  assert.deepEqual([f.views.length, f.delays.length], [1, 1]);
});

test('a throwing view handler fails closed without restoring eligibility', () => {
  const f = fixture({ onView: (view) => { if (view) throw new Error('boom'); } });
  f.confirm();
  assert.doesNotThrow(() => f.send(signal(ID(1))));
  f.send(signal(ID(1)));
  assert.equal(f.views.length, 1);
});

test('defaults to the global timers and clears them on dispose', () => {
  const views: View[] = [];
  let handler: ((signal: unknown) => void) | undefined;
  const playback = createLineLotPlayback({ subscribe: (cb: (signal: unknown) => void) => { handler = cb; return () => {}; },
    onChange: (view: View) => { views.push(view); } });
  playback.observeAward(award());
  playback.observeFrame(frame(), undefined);
  handler!(signal());
  assert.equal(views.length, 1);
  playback.dispose();
  assert.deepEqual(views.at(-1), null);
});

// Hostile proxies throw from a different trap each; none may escape the signal handler or burn the id.
for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
  test(`a signal proxy throwing from ${trap} is dropped without a throw, view, timer or burned id`, () => {
    const f = fixture();
    f.confirm();
    const hostile = new Proxy(signal(ID(1)), { [trap]() { throw new Error(`hostile ${trap}`); } });
    assert.doesNotThrow(() => f.send(hostile));
    assert.deepEqual([f.views.length, f.timers.size, f.delays.length], [0, 0, 0]);
    // The same id was never consumed, so the genuine signal still plays.
    f.send(signal(ID(1)));
    assert.deepEqual([f.views, f.delays], [[{ participantNumber: 3, colorId: 'green' }], [4000]]);
  });
}

test('dispose rejects re-entry from the hide callback before unsubscribing', () => {
  const holder: { f?: ReturnType<typeof fixture> } = {};
  let reenter = false;
  const f = fixture({ onView: (view) => {
    if (view !== null || !reenter) return;
    holder.f!.playback.observeAward(award());
    holder.f!.playback.observeFrame(frame(), undefined);
    holder.f!.send(signal(ID(2)));
  } });
  holder.f = f;
  f.confirm();
  f.send(signal(ID(1)));
  reenter = true;
  f.playback.dispose();
  f.playback.dispose();
  f.advance(9000);
  f.send(signal(ID(3)));
  assert.deepEqual([f.views.at(-1), f.views.length, f.timers.size, f.delays.length, f.unsubscriptions()], [null, 2, 0, 1, 1]);
});

test('input re-entering from the event-change hide callback cannot restore the cancelled winner', () => {
  let reenter: (() => void) | undefined;
  const f = fixture({ onView: (view) => { if (view === null) reenter?.(); } });
  f.confirm();
  f.send(signal(ID(1)));
  reenter = () => {
    reenter = undefined;
    f.playback.observeFrame(frame(), undefined);
    f.send(signal(ID(2)));
  };
  f.playback.observeFrame(frame(), { eventChanged: true });
  // Immediately, before any clock advance: the old winner must not be replayed without a new award.
  assert.deepEqual([f.views.at(-1), f.views.length, f.timers.size, f.delays.length], [null, 2, 0, 1]);
  f.send(signal(ID(2)));
  assert.equal(f.views.length, 2);
  f.playback.dispose();
  assert.deepEqual([f.unsubscriptions(), f.timers.size], [1, 0]);
});
