// Public side of the first-line celebration. State is page-local only: a signal received by this page plays once,
// and a reloaded or reopened window starts idle because main never resends it.
export const LINE_CELEBRATION_MS = 4000;

export const validLineSignal = (value) => value !== null && typeof value === 'object' && value.kind === 'line' &&
  typeof value.id === 'string' && value.id !== '' && value.durationMs === LINE_CELEBRATION_MS;

// `view.show(signal)` may return a promise that settles once the overlay is actually rendered; the start receipt is
// sent only then (best effort), never on mere signal arrival. A failed render sends no receipt and hides at once.
export function createLineCelebrationPlayback(api, view, receipt, schedule = setTimeout, cancel = clearTimeout) {
  const seen = new Set();
  const pending = Symbol('rendering');
  let timer = null;
  let run = 0;
  const unsubscribe = api.subscribe((signal) => {
    if (!validLineSignal(signal) || seen.has(signal.id) || timer !== null) return;
    seen.add(signal.id);
    const mine = ++run;
    const stop = () => {
      if (timer !== null && timer !== pending) cancel(timer);
      timer = null;
      view.hide();
    };
    try {
      const rendered = Promise.resolve(view.show(signal));
      // Marks the page busy until rendering settles, so overlapping signals are still dropped.
      timer = pending;
      rendered.then(() => {
        if (run !== mine || timer !== pending) return;
        // The whole duration is visible time: it starts only once the overlay has actually rendered.
        timer = schedule(() => { timer = null; view.hide(); }, signal.durationMs);
        try { receipt.started(signal.id); } catch { /* the receipt is best effort */ }
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
