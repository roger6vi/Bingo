// Public side of the first-line celebration. State is page-local only: a signal received by this page plays once,
// and a reloaded or reopened window starts idle because main never resends it.
export const LINE_CELEBRATION_MS = 4000;

const validSignal = (value, kind) => value !== null && typeof value === 'object' && value.kind === kind &&
  typeof value.id === 'string' && value.id !== '' && value.durationMs === LINE_CELEBRATION_MS;
export const validLineSignal = (value) => validSignal(value, 'line');

// `view.show(signal)` may return a promise that settles once the overlay is actually rendered; the start receipt is
// sent only then (best effort), never on mere signal arrival. A failed render sends no receipt and hides at once.
export function createLineCelebrationPlayback(api, view, receipt, schedule = setTimeout, cancel = clearTimeout) {
  return createCelebrationPlayback(api, view, { line: receipt }, schedule, cancel);
}

// One overlay run for the line and Bingo kinds: `receipts` maps each accepted kind to its own sender, so a Bingo
// signal is receipted only through the Bingo sender (and ignored when none is given). While any run is shown or
// rendering, every other signal is dropped; ids are one-shot per kind.
export function createCelebrationPlayback(api, view, receipts, schedule = setTimeout, cancel = clearTimeout) {
  const seen = new Set();
  const pending = Symbol('rendering');
  let timer = null;
  let run = 0;
  const unsubscribe = api.subscribe((signal) => {
    const kind = ['line', 'bingo'].find((name) => receipts[name] !== undefined && validSignal(signal, name));
    if (kind === undefined || seen.has(`${kind}:${signal.id}`) || timer !== null) return;
    seen.add(`${kind}:${signal.id}`);
    const mine = ++run;
    const stop = () => {
      if (timer !== null && timer !== pending) cancel(timer);
      timer = null;
      view.hide();
    };
    // Marks the page busy before the view is touched and until rendering settles, so an overlapping signal (even
    // one delivered from inside show) is dropped before it can change the overlay.
    timer = pending;
    try {
      const rendered = Promise.resolve(view.show(signal));
      rendered.then(() => {
        if (run !== mine || timer !== pending) return;
        // The whole duration is visible time: it starts only once the overlay has actually rendered.
        timer = schedule(() => { timer = null; view.hide(); }, signal.durationMs);
        try { receipts[kind].started(signal.id); } catch { /* the receipt is best effort */ }
      }, () => { if (run === mine) stop(); });
    } catch { stop(); }
  });
  return { cleanup() {
    run++;
    unsubscribe();
    if (timer !== null && timer !== pending) cancel(timer);
    timer = null;
  } };
}
