import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-number.mjs';
import './components/bingo-latest-draw.mjs';
import './components/bingo-status.mjs';
import './components/bingo-number-board.mjs';
import './screen.css';
import sampleVideoUrl from '../assets/sample.mp4?url';
import { createPublicController } from './public-controller.mjs';
import { applyTheme, revealAfter } from './theme-controller.mjs';
import { publicBridges, validEventMeta } from './public-bridge.mjs';
import { formatEuros, validPrizes } from './prize-format.mjs';

const bridges = publicBridges(window);
const unsubscribeTheme = bridges.theme.subscribe((theme) => applyTheme(document.documentElement, theme));
const revealTimer = revealAfter(document.documentElement, 2000);

const sampleSource = document.getElementById('sample-video-source');
if (!(sampleSource instanceof HTMLSourceElement)) throw new Error('Missing sample video source');
sampleSource.src = sampleVideoUrl;

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

// An unreadable or invalid event description falls back to the generic heading, never a stale one.
const unsubscribeMeta = bridges.meta.subscribe((meta) => {
  const valid = validEventMeta(meta);
  eventName.textContent = valid ? meta.name : 'Current event';
  eventDetails.textContent = valid ? `${meta.date} · ${meta.place}` : '';
  eventDetails.hidden = !valid;
});

// Committed (or, in the simulator, drafted) prizes. Unreadable or invalid ones never leave a stale prize
// on screen: both show as pending confirmation.
const prizeSlots = ['line', 'bingo'].map((kind) => ({ kind, amount: required(`prize-${kind}-amount`, HTMLElement),
  lot: required(`prize-${kind}-lot`, HTMLElement), empty: required(`prize-${kind}-empty`, HTMLElement) }));
const unsubscribePrizes = bridges.prizes.subscribe((prizes) => {
  const valid = validPrizes(prizes);
  for (const { kind, amount, lot, empty } of prizeSlots) {
    const prize = valid ? prizes[kind] : { amount: 0, lot: '' };
    amount.textContent = prize.amount > 0 ? formatEuros(prize.amount) : '';
    amount.hidden = prize.amount === 0;
    lot.textContent = prize.lot;
    lot.hidden = prize.lot === '';
    empty.textContent = valid ? 'Sin premio' : 'Premio por confirmar';
    empty.hidden = !amount.hidden || !lot.hidden;
  }
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
window.addEventListener('pagehide', () => {
  controller.cleanup();
  unsubscribeTheme();
  unsubscribeMeta();
  unsubscribePrizes();
  clearTimeout(revealTimer);
}, { once: true });
