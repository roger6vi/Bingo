// Shared, side-effect free factories for line-lot playback tests. Every call returns fresh data.
const palette = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
export const colorOf = (n) => palette[(n - 1) % palette.length];
export const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function award(eventId = 'e1', winnerCount = 10, number = 3, resolution = 'resolved') {
  const totalCents = 1000;
  const base = { eventId, winnerCount, totalCents, shareCents: Math.floor(totalCents / winnerCount),
    remainderCents: totalCents % winnerCount, lot: 'Cesta', lotResolution: resolution };
  if (number === null) return base;
  return { ...base, lotResult: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
    participantNumber: number, colorId: colorOf(number) } };
}
export const frame = (extra = {}) => ({ loaded: true, calledNumbers: [1], latest: 1, count: 1, remaining: 89,
  phase: 'drawing', stale: false, error: null, ...extra });
export const signal = (id = ID(1), participantNumber = 3, colorId = colorOf(3)) => ({ id, participantNumber, colorId });

// The original malformed/adversarial signal payloads, in their original order.
export function adversarialSignals() {
  const getter = { id: ID(4), participantNumber: 3 };
  Object.defineProperty(getter, 'colorId', { enumerable: true, get() { throw new Error('ran getter'); } });
  return [null, 'x', [], signal('', 3), { ...signal(ID(5)), extra: 1 }, { id: ID(6), participantNumber: 3 },
    signal(ID(7), '3'), signal(ID(8), 3.5), signal(ID(9), 3, 'magenta'), signal(ID(10), 3, 'blue'),
    signal(ID(11), 4, colorOf(3)), signal(ID(12), 4, colorOf(4)), getter, Object.create(signal(ID(13)))];
}

// Legacy (via an intermediate null eventId, then e1), pending and not-required awards.
export function nonPlayableAwards() {
  const legacy = { ...award(null, 10, null), lotResult: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' } };
  return [{ ...legacy, eventId: 'e1' }, { ...award('e1', 10, null, 'pending'),
    lotResult: { origin: 'none', resolution: 'pending' } }, { ...award('e1', 1, null, 'not_required'), lot: '' }];
}

// Deterministic fake clock plus a shared log that proves callback ordering.
export function playbackFixture(createPlayback, options = {}) {
  const views = [];
  const log = [];
  const timers = new Map();
  const delays = [];
  let now = 0;
  let nextId = 1;
  let handler;
  let unsubscriptions = 0;
  const playback = createPlayback({ reducedMotion: options.reducedMotion,
    subscribe: (cb) => { handler = cb; return () => { unsubscriptions++; handler = undefined; }; },
    onChange: (view) => { views.push(view && { ...view }); log.push(view ? 'view' : 'hide'); options.onView?.(view); },
    setTimer: (fn, ms) => { delays.push(ms); options.onTimer?.();
      timers.set(nextId, { fn, due: now + ms }); return nextId++; },
    clearTimer: (id) => { log.push('clear'); timers.delete(id); } });
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
  };
  const confirm = (a = award()) => { playback.observeAward(a); playback.observeFrame(frame(), undefined); };
  return { playback, views, log, timers, delays, advance, confirm, unsubscriptions: () => unsubscriptions,
    send: (s) => handler?.(s), hasHandler: () => handler !== undefined };
}
