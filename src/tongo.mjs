// Tongo is a transient celebration of a claim rejected outside the app. Neither side keeps it past the
// page: a reloaded window starts idle, and nothing here can change the committed game.

export const validPresentation = (value) => value !== null && typeof value === 'object' && value.kind === 'tongo' &&
  Number.isSafeInteger(value.id) && value.id > 0 &&
  Number.isInteger(value.durationMs) && value.durationMs >= 500 && value.durationMs <= 10000;

// Public side: shows each new valid signal once for its duration; repeats and malformed input are ignored.
export function createTongoPlayback(api, view, schedule = setTimeout, cancel = clearTimeout) {
  let lastId = 0;
  let timer = null;
  const unsubscribe = api.subscribe((signal) => {
    if (!validPresentation(signal) || signal.id <= lastId || timer !== null) return;
    lastId = signal.id;
    view.show();
    timer = schedule(() => {
      timer = null;
      view.hide();
    }, signal.durationMs);
  });
  return { cleanup() {
    unsubscribe();
    if (timer !== null) cancel(timer);
    timer = null;
  } };
}
