import { createLineLotPlayback } from './line-lot-playback.mjs';
import { describeBingoAward, describeLineAward } from './public-controller.mjs';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Page-local DOM adapter for the transient lot playback. It owns one hidden Spanish line beside the static award,
// the reduced-motion media query and the playback itself (global timers, 4000 ms). It has no interaction, audio,
// receipt or styling: the line shows the already-known winner only while the playback reports one, and is cleared
// whenever it reports null or the page goes away.
//
// options: { bridge: { subscribe(onSignal) => unsubscribe }, anchor: Element, win = window,
//   kind = 'line' }: the 'bingo' kind reuses the same playback with Bingo award wording and its own DOM id.
// Returns { observeAward, observeFrame, dispose }.
export function createLineLotAdapter({ bridge, anchor, win = window, kind = 'line' }) {
  const bingo = kind === 'bingo';
  const line = anchor.ownerDocument.createElement('p');
  line.id = bingo ? 'bingo-lot-playback' : 'line-lot-playback';
  line.lang = 'es';
  line.hidden = true;
  anchor.after(line);

  // Reuses the award wording and colour translation instead of repeating the palette.
  const describe = bingo ? describeBingoAward : describeLineAward;
  function winnerText({ participantNumber, colorId }) {
    const facts = describe({ winnerCount: 1, shareCents: 0, remainderCents: 0, lot: '',
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
