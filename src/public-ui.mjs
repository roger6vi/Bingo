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
import { createPublicController, describeLineAward, validLineAward } from './public-controller.mjs';
import { applyTheme, revealAfter } from './theme-controller.mjs';
import { publicBridges, validEventMeta } from './public-bridge.mjs';
import { validPrizes } from './prize-format.mjs';
import { createTongoPlayback } from './tongo.mjs';
import { createLineCelebrationPlayback } from './line-celebration.mjs';

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
  drawing: 'Drawing', checking_line: 'Checking line', line_declared: 'Line declared',
  checking_bingo: 'Checking bingo', bingo_declared: 'Bingo declared', finished: 'Finished',
};
const eventError = required('event-error', HTMLElement);
const eventName = required('event-name', HTMLHeadingElement);
const eventDetails = required('event-details', HTMLParagraphElement);
const prizes = required('prizes', HTMLElement);

// An unreadable or invalid event description falls back to the generic heading, never a stale one.
const unsubscribeMeta = bridges.meta.subscribe((meta) => {
  const valid = validEventMeta(meta);
  eventName.textContent = valid ? meta.name : 'Current event';
  eventDetails.textContent = valid ? `${meta.date} · ${meta.place}` : '';
  eventDetails.hidden = !valid;
});

// Only the committed prizes the main process sends; an unreadable payload shows them as undefined.
const unsubscribePrizes = bridges.prizes.subscribe((value) => { prizes.prizes = validPrizes(value) ? value : null; });

// Static committed award text only: no animation, timer or presentation state, so a late attach or reload shows
// the same facts and never implies that a celebration played. Invalid or cleared payloads remove it.
let awardFacts = '';
const lineAward = document.createElement('p');
lineAward.id = 'line-award';
lineAward.lang = 'es';
lineAward.hidden = true;
prizes.parentElement.append(lineAward);
const unsubscribeLineAward = bridges.lineAward.subscribe((award) => {
  const valid = validLineAward(award);
  lineAward.textContent = valid ? describeLineAward(award) : '';
  lineAward.hidden = !valid;
  awardFacts = valid ? describeLineAward(award) : '';
});

const controller = createPublicController(bridges.event, {
  render: (state) => {
    latest.latest = state.latest;
    latest.loaded = state.loaded;
    latestNumber.value = state.latest;
    latestNumber.emptyLabel = state.loaded ? 'No draws yet' : 'Waiting for draw';
    history.calledNumbers = state.calledNumbers;
    history.loaded = state.loaded;
    count.value = String(state.count);
    remaining.value = String(state.remaining);
    phaseStatus.message = state.phase === null ? 'Current phase: waiting for event state'
      : `Current phase: ${phaseLabels[state.phase]}`;
    phaseStatus.tone = 'info';
    status.message = state.loaded ? (state.stale ? 'Last confirmed history may be stale.' : 'Event ready')
      : (state.error ? '' : 'Waiting for event state');
    status.tone = state.stale ? 'warning' : 'info';
    status.hidden = Boolean(state.error && !state.loaded);
    eventError.message = state.error ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
  },
});
// Transient: only signals received by this page play, so a reload or reopen never replays one.
const tongo = required('tongo', HTMLElement);
const tongoPlayback = createTongoPlayback(bridges.presentation, {
  show: () => { tongo.active = true; },
  hide: () => { tongo.active = false; },
});
// The first-line celebration overlays the same unchanged board. Page-local, like Tongo: it plays only for a signal
// this page received, and its start receipt is sent after the overlay has actually rendered.
const lineCelebration = required('line-celebration', HTMLElement);
const linePlayback = createLineCelebrationPlayback(bridges.presentation, {
  show: () => {
    lineCelebration.facts = awardFacts;
    lineCelebration.active = true;
    return lineCelebration.updateComplete;
  },
  hide: () => { lineCelebration.active = false; },
}, bridges.lineReceipt);
window.addEventListener('pagehide', () => {
  controller.cleanup();
  tongoPlayback.cleanup();
  linePlayback.cleanup();
  unsubscribeTheme();
  unsubscribeMeta();
  unsubscribePrizes();
  unsubscribeLineAward();
  clearTimeout(revealTimer);
}, { once: true });
