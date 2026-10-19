import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-number.mjs';
import './components/bingo-latest-draw.mjs';
import './components/bingo-status.mjs';
import './components/bingo-number-board.mjs';
import './components/bingo-prize-display.mjs';
import './components/bingo-tongo.mjs';
import './components/bingo-line-celebration.mjs';
import './screen.css';
import { createPublicController, describeBingoAward, describeLineAward, validBingoAward, validLineAward } from './public-controller.mjs';
import { applyTheme, revealAfter } from './theme-controller.mjs';
import { publicBridges, validEventMeta } from './public-bridge.mjs';
import { validPrizes } from './prize-format.mjs';
import { createTongoPlayback } from './tongo.mjs';
import { createCelebrationPlayback } from './line-celebration.mjs';
import { createLineLotAdapter } from './public-line-lot-playback.mjs';

const bridges = publicBridges(window);
const unsubscribeTheme = bridges.theme.subscribe((theme) => applyTheme(document.documentElement, theme));
const revealTimer = revealAfter(document.documentElement, 2000);

function required(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing or invalid public element: ${id}`);
  return element;
}

const latest = required('latest-draw', HTMLElement);
const latestNumber = required('latest-number', HTMLElement);
const history = required('called-numbers', HTMLElement);
const count = required('called-count', HTMLOutputElement);
const remaining = required('remaining-count', HTMLOutputElement);
const phaseStatus = required('phase-status', HTMLElement);
const status = required('event-status', HTMLElement);
const phaseLabels = {
  drawing: 'Cantando números', checking_line: 'Comprobando línea', line_declared: 'Línea cantada',
  checking_bingo: 'Comprobando bingo', bingo_declared: 'Bingo cantado', finished: 'Partida terminada',
};
const eventError = required('event-error', HTMLElement);
const eventName = required('event-name', HTMLHeadingElement);
const eventDetails = required('event-details', HTMLParagraphElement);
const prizes = required('prizes', HTMLElement);

// An unreadable or invalid event description falls back to the generic heading, never a stale one.
const unsubscribeMeta = bridges.meta.subscribe((meta) => {
  const valid = validEventMeta(meta);
  eventName.textContent = valid ? meta.name : 'Evento actual';
  eventDetails.textContent = valid ? `${meta.date} · ${meta.place}` : '';
  eventDetails.hidden = !valid;
});

// Only the committed prizes the main process sends; an unreadable payload shows them as undefined.
const unsubscribePrizes = bridges.prizes.subscribe((value) => { prizes.prizes = validPrizes(value) ? value : null; });

// Static committed award text only: no animation, timer or presentation state, so a late attach or reload shows
// the same facts and never implies that a celebration played. Invalid or cleared payloads remove it.
// The server sends the award before every event frame, so an award seen since the last frame is fresh for this one.
let awardFacts = '';
let awardFresh = false;
const lineAward = document.createElement('p');
lineAward.id = 'line-award';
lineAward.lang = 'es';
lineAward.hidden = true;
prizes.parentElement.append(lineAward);
function showAward(award) {
  const valid = validLineAward(award);
  awardFacts = valid ? describeLineAward(award) : '';
  lineAward.textContent = awardFacts;
  lineAward.hidden = !valid;
}
// Transient winner line: created before the award subscription so a hydrated award reaches it too.
const lotPlayback = createLineLotAdapter({ bridge: bridges.lineLot, anchor: lineAward });
const unsubscribeLineAward = bridges.lineAward.subscribe((award) => {
  awardFresh = true;
  showAward(award);
  lotPlayback.observeAward(award);
});
// The committed Bingo award, static like the line one and independent of it: an invalid or cleared Bingo payload
// removes only this text. Receiving it never plays anything; only a Bingo signal shows these facts in the overlay.
let bingoFacts = '';
let bingoFresh = false;
const bingoAward = document.createElement('p');
bingoAward.id = 'bingo-award';
bingoAward.lang = 'es';
bingoAward.hidden = true;
// Appended after the line award and its transient lot line, so the two line facts stay adjacent.
prizes.parentElement.append(bingoAward);
function showBingo(award) {
  const valid = validBingoAward(award);
  bingoFacts = valid ? describeBingoAward(award) : '';
  bingoAward.textContent = bingoFacts;
  bingoAward.hidden = !valid;
}
// Transient Bingo lot line: created before the award subscription so a hydrated award reaches it too. Shares the
// line adapter with its own kind, wording and DOM id; only a live Bingo signal can play it.
const bingoLotPlayback = createLineLotAdapter({ bridge: bridges.bingoLot, anchor: bingoAward, kind: 'bingo' });
const unsubscribeBingoAward = bridges.bingoAward.subscribe((award) => {
  bingoFresh = true;
  showBingo(award);
  bingoLotPlayback.observeAward(award);
});

const controller = createPublicController(bridges.event, {
  render: (state, frame) => {
    latest.latest = state.latest;
    latest.loaded = state.loaded;
    latestNumber.value = state.latest;
    latestNumber.emptyLabel = state.loaded ? 'Sin números cantados' : 'Esperando el primer número';
    history.calledNumbers = state.calledNumbers;
    history.loaded = state.loaded;
    count.value = String(state.count);
    remaining.value = String(state.remaining);
    phaseStatus.message = state.phase === null ? 'Fase: esperando el estado del evento'
      : `Fase: ${phaseLabels[state.phase]}`;
    phaseStatus.tone = 'info';
    status.message = state.loaded ? (state.stale ? 'La última lectura confirmada puede estar desactualizada.' : 'Evento listo')
      : (state.error ? '' : 'Esperando el estado del evento');
    status.tone = state.stale ? 'warning' : 'info';
    status.hidden = Boolean(state.error && !state.loaded);
    eventError.message = state.error ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
    // An unusable frame, or a new event without a fresh award, must not keep the previous event's facts.
    if (frame !== undefined) {
      if (state.error || (frame.eventChanged && !awardFresh)) showAward(null);
      if (state.error || (frame.eventChanged && !bingoFresh)) showBingo(null);
      awardFresh = false;
      bingoFresh = false;
    }
    lotPlayback.observeFrame(state, frame);
    bingoLotPlayback.observeFrame(state, frame);
  },
});
// Transient: only signals received by this page play, so a reload or reopen never replays one.
const tongo = required('tongo', HTMLElement);
const tongoPlayback = createTongoPlayback(bridges.presentation, {
  show: () => { tongo.active = true; },
  hide: () => { tongo.active = false; },
});
// The first-line and Bingo celebrations share one overlay over the same unchanged board. Page-local, like Tongo: it
// plays only for a signal this page received, and the start receipt goes through that kind's own sender after the
// overlay has actually rendered. A competing signal is dropped by the playback before the kind or facts change.
const lineCelebration = required('line-celebration', HTMLElement);
const linePlayback = createCelebrationPlayback(bridges.presentation, {
  show: (signal) => {
    lineCelebration.kind = signal.kind;
    lineCelebration.facts = signal.kind === 'bingo' ? bingoFacts : awardFacts;
    lineCelebration.active = true;
    return lineCelebration.updateComplete;
  },
  hide: () => { lineCelebration.active = false; },
}, { line: bridges.lineReceipt, bingo: bridges.bingoReceipt });
window.addEventListener('pagehide', () => {
  controller.cleanup();
  tongoPlayback.cleanup();
  linePlayback.cleanup();
  lotPlayback.dispose();
  bingoLotPlayback.dispose();
  unsubscribeTheme();
  unsubscribeMeta();
  unsubscribePrizes();
  unsubscribeLineAward();
  unsubscribeBingoAward();
  clearTimeout(revealTimer);
}, { once: true });
