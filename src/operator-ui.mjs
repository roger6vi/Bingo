import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-status.mjs';
import './components/bingo-operator-summary.mjs';
import './components/bingo-call-history.mjs';
import './screen.css';
import { createOperatorController } from './operator-controller.mjs';
import { createManualDrawHandler } from './manual-draw.mjs';

function required(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing or invalid operator element: ${id}`);
  return element;
}

const openPublic = required('open-public', HTMLButtonElement);
const movePublic = required('move-public', HTMLButtonElement);
const publicStatus = required('public-status', HTMLElement);
const manualInput = required('manual-number', HTMLInputElement);
const manualButton = required('draw-manual', HTMLButtonElement);
const digitalButton = required('draw-digital', HTMLButtonElement);
const reloadButton = required('reload-event', HTMLButtonElement);
const history = required('called-numbers', HTMLElement);
const summary = required('event-summary', HTMLElement);
const eventStatus = required('event-status', HTMLElement);
const eventError = required('event-error', HTMLElement);

openPublic.addEventListener('click', () => window.desktop.openPublic());
movePublic.addEventListener('click', () => window.desktop.movePublicToSecondary());
window.desktop.onPublicStatus((pauseSuggested) => {
  publicStatus.message = pauseSuggested
    ? 'Secondary display disconnected. Public output moved to primary preview; pause bingo until ready.'
    : '';
  publicStatus.tone = 'warning';
  publicStatus.hidden = !pauseSuggested;
});

const controller = createOperatorController(window.desktop, {
  bind: ({ manual, digital, reload }) => {
    manualButton.addEventListener('click', createManualDrawHandler(manualInput, manual));
    digitalButton.addEventListener('click', digital);
    reloadButton.addEventListener('click', reload);
  },
  clearManual: () => { manualInput.value = ''; },
  render: (state) => {
    history.calledNumbers = state.calledNumbers;
    summary.latest = state.calledNumbers.at(-1) ?? null;
    summary.count = state.calledNumbers.length;
    summary.remaining = state.remaining;
    eventStatus.message = state.stale ? 'Event history may be stale. Reload before relying on it.'
      : state.pending ? 'Loading event state' : state.manualDisabled && state.remaining > 0
        ? 'Waiting for event state' : 'Event ready';
    eventStatus.tone = state.stale ? 'warning' : 'info';
    eventError.message = state.error ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
    manualInput.disabled = state.manualDisabled;
    manualButton.disabled = state.manualDisabled;
    digitalButton.disabled = state.digitalDisabled;
    reloadButton.disabled = state.reloadDisabled;
  },
});
void controller.start();
