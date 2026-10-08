import { dataCopy, knownWinner, validSignal, sameWinner } from './line-lot-playback-contract.mjs';

// Pure transient playback of the known lot winner. No DOM, media, IPC or persistence: callers feed it
// observeAward(award) then observeFrame(state, frame) (server order AWARD -> FRAME -> LIVE signal) and render
// the copied { participantNumber, colorId } | null it reports through onChange(view).
//
// Options: { subscribe(onSignal) => unsubscribe, onChange(view), setTimer = setTimeout, clearTimer = clearTimeout,
//   reducedMotion = false }.  Returns { observeAward, observeFrame, setReducedMotion, dispose }.
export const LINE_LOT_PLAYBACK_MS = 4000;

export function createLineLotPlayback({ subscribe, onChange, setTimer = setTimeout, clearTimer = clearTimeout,
  reducedMotion = false } = {}) {
  const seen = new Set();
  let current = null; // { eventId, winner } copied from the latest valid award
  let fresh = false; // an award arrived since the last frame
  let confirmed = false; // a frame has confirmed `current`
  let healthy = false; // the latest frame was loaded, fresh and error-free
  let reduced = reducedMotion === true;
  let epoch = 0;
  let timer = null;
  let visible = false;
  let disposed = false;
  let cancelling = false; // fence: input re-entering from cancel's clearTimer/onChange callouts is dropped
  let unsubscribe = () => {};

  function emit(view) {
    try { onChange?.(view); } catch { /* a faulty view must never restore eligibility */ }
  }

  // Invalidate the epoch and timer first so no late callback can hide a newer run, then report the hide.
  function cancel() {
    const outer = cancelling; // dispose() may nest a cancel and must not reopen the fence early
    cancelling = true;
    try {
      epoch++;
      if (timer !== null) {
        const stale = timer;
        timer = null;
        try { clearTimer(stale); } catch { /* nothing left to cancel */ }
      }
      if (visible) {
        visible = false;
        emit(null);
      }
    } finally {
      cancelling = outer;
    }
  }

  function forget() {
    cancel();
    current = null;
    confirmed = false;
    fresh = false;
  }

  function start(winner) {
    const mine = ++epoch;
    visible = true;
    emit({ ...winner });
    if (epoch !== mine) return;
    try {
      timer = setTimer(() => {
        if (epoch !== mine) return;
        timer = null;
        visible = false;
        emit(null);
      }, LINE_LOT_PLAYBACK_MS);
    } catch {
      cancel();
    }
  }

  function onSignal(value) {
    if (disposed || cancelling || !confirmed || !healthy || current === null || current.winner === null) return;
    const signal = validSignal(value);
    if (signal === null || seen.has(signal.id)) return;
    if (!sameWinner(current.winner, { participantNumber: signal.participantNumber, colorId: signal.colorId })) return;
    seen.add(signal.id); // burned before any view or timer callback can re-enter
    if (reduced || visible) return;
    start(current.winner);
  }

  function observeAward(award) {
    if (disposed || cancelling) return;
    const next = knownWinner(award);
    if (next === undefined) {
      forget();
      return;
    }
    fresh = true;
    if (current !== null && current.eventId === next.eventId && sameWinner(current.winner, next.winner)) return;
    cancel();
    if (disposed) return; // a cancel callback may have disposed
    current = next;
    confirmed = false;
  }

  function observeFrame(state, frame) {
    if (disposed || cancelling) return;
    const s = dataCopy(state, null);
    const f = frame === undefined || frame === null ? {} : dataCopy(frame, null);
    if (s === null || f === null || !Array.isArray(s.calledNumbers) || typeof s.loaded !== 'boolean' ||
        Object.keys(f).some((key) => key !== 'eventChanged' || typeof f[key] !== 'boolean')) {
      healthy = false;
      forget();
      return;
    }
    healthy = s.loaded && s.stale !== true && (s.error === null || s.error === undefined);
    if (!healthy) {
      cancel();
      return;
    }
    if (f.eventChanged === true) {
      cancel();
      confirmed = false;
      if (!fresh) current = null;
    }
    if (fresh && current !== null) confirmed = true;
    fresh = false;
  }

  function setReducedMotion(flag) {
    reduced = flag === true;
    if (reduced) cancel();
  }

  function dispose() {
    if (disposed) return;
    disposed = true; // before cancel(): the hide callback must not re-enter any entry point
    cancel();
    current = null;
    seen.clear();
    unsubscribe();
  }

  try {
    const result = subscribe?.(onSignal);
    if (typeof result === 'function') unsubscribe = result;
  } catch { /* no signal source: playback stays inert */ }
  return { observeAward, observeFrame, setReducedMotion, dispose };
}
