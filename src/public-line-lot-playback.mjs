import { createLineLotPlayback } from './line-lot-playback.mjs';
import { describeLineAward } from './public-controller.mjs';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Page-local DOM adapter for the transient lot playback. It owns one hidden Spanish line beside the static award,
// the reduced-motion media query and the playback itself (global timers, 4000 ms). It has no interaction, audio,
// receipt or styling: the line shows the already-known winner only while the playback reports one, and is cleared
// whenever it reports null or the page goes away.
//
// options: { bridge: { subscribe(onSignal) => unsubscribe }, anchor: Element, win = window }.
// Returns { observeAward, observeFrame, dispose }.
export function createLineLotAdapter({ bridge, anchor, win = window }) {
  const line = anchor.ownerDocument.createElement('p');
  line.id = 'line-lot-playback';
  line.lang = 'es';
  line.hidden = true;
  anchor.after(line);

  // Reuses the award wording and colour translation instead of repeating the palette.
  function winnerText({ participantNumber, colorId }) {
    const facts = describeLineAward({ winnerCount: 1, shareCents: 0, remainderCents: 0, lot: '',
      lotResult: { origin: 'numbered_v1', participantNumber, colorId } });
    return facts.slice(facts.indexOf('Ganador del lote'));
  }

  const query = win.matchMedia?.(REDUCED_MOTION) ?? null;
  let disposed = false;
  const onMotionChange = () => {
    if (!disposed) playback.setReducedMotion(query.matches === true);
  };
  const playback = createLineLotPlayback({
    subscribe: (onSignal) => bridge.subscribe(onSignal),
    onChange: (view) => {
      line.textContent = view === null ? '' : winnerText(view);
      line.hidden = view === null;
    },
    reducedMotion: query?.matches === true,
  });
  query?.addEventListener('change', onMotionChange);

  return {
    observeAward: (award) => playback.observeAward(award),
    observeFrame: (state, frame) => playback.observeFrame(state, frame),
    dispose() {
      if (disposed) return;
      disposed = true; // before any cleanup: a saved media callback can no longer reach the playback
      query?.removeEventListener('change', onMotionChange);
      playback.dispose();
    },
  };
}
