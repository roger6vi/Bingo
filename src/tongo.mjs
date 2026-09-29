// Tongo is a transient celebration of a claim rejected outside the app. Neither side keeps it past the
// page: a reloaded window starts idle, and nothing here can change the committed game.
const TICK_MS = 100;
const playablePhases = new Set(['drawing', 'line_declared']);

export const validPresentation = (value) => value !== null && typeof value === 'object' && value.kind === 'tongo' &&
  Number.isSafeInteger(value.id) && value.id > 0 &&
  Number.isInteger(value.durationMs) && value.durationMs >= 500 && value.durationMs <= 10000;

// The operator's acknowledged state allows Tongo only while the game is in play and fully known.
export const tongoPlayable = (state) => state !== null && state.snapshot !== null && !state.stale && !state.pending &&
  playablePhases.has(state.phase);

// Browser timers must not be called as methods of another object, so the default clock wraps them.
const browserClock = { now: () => performance.now(), schedule: (done, delay) => setTimeout(done, delay),
  cancel: (id) => clearTimeout(id) };

// Operator side: one request at a time, then private progress for the acknowledged duration.
export function createTongoController(api, view, clock = browserClock) {
  let pending = false;
  let startedAt = null;
  let durationMs = 0;
  let error = null;
  let timer = null;
  const busy = () => pending || startedAt !== null;
  const render = () => view.render({ busy: busy(), pending, error,
    progress: startedAt === null ? null : Math.min(1, (clock.now() - startedAt) / durationMs) });

  function tick() {
    timer = null;
    if (startedAt !== null && clock.now() - startedAt >= durationMs) startedAt = null;
    render();
    if (startedAt !== null) timer = clock.schedule(tick, TICK_MS);
  }

  async function play() {
    if (busy()) return;
    pending = true;
    error = null;
    render();
    try {
      const result = await api.playTongo();
      if (result?.ok === true && validPresentation(result.presentation)) {
        startedAt = clock.now();
        durationMs = result.presentation.durationMs;
      } else {
        error = result?.ok === false && typeof result.message === 'string' ? result.message : 'Invalid Tongo response.';
      }
    } catch {
      error = 'Could not start Tongo. Try again.';
    } finally {
      pending = false;
      tick();
    }
  }

  render();
  return { play, busy, cleanup() { if (timer !== null) clock.cancel(timer); timer = null; } };
}

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
