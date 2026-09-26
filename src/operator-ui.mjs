import { createOperatorController } from './operator-controller.mjs';

function required(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing or invalid operator element: ${id}`);
  return element;
}

const openPublic = required('open-public', HTMLButtonElement);
const movePublic = required('move-public', HTMLButtonElement);
const publicStatus = required('status', HTMLParagraphElement);
const manualInput = required('manual-number', HTMLInputElement);
const manualButton = required('draw-manual', HTMLButtonElement);
const digitalButton = required('draw-digital', HTMLButtonElement);
const reloadButton = required('reload-event', HTMLButtonElement);
const history = required('called-numbers', HTMLOListElement);
const remaining = required('remaining-count', HTMLOutputElement);
const staleWarning = required('stale-warning', HTMLParagraphElement);
const eventError = required('event-error', HTMLParagraphElement);

openPublic.addEventListener('click', () => window.desktop.openPublic());
movePublic.addEventListener('click', () => window.desktop.movePublicToSecondary());
window.desktop.onPublicStatus((pauseSuggested) => {
  publicStatus.textContent = pauseSuggested
    ? 'Secondary display disconnected. Public output moved to primary preview; pause bingo until ready.'
    : '';
});

const controller = createOperatorController(window.desktop, {
  bind: ({ manual, digital, reload }) => {
    manualButton.addEventListener('click', () => manual(manualInput.valueAsNumber));
    digitalButton.addEventListener('click', digital);
    reloadButton.addEventListener('click', reload);
  },
  clearManual: () => { manualInput.value = ''; },
  render: (state) => {
    history.replaceChildren(...state.calledNumbers.map((number) => {
      const item = document.createElement('li');
      item.textContent = String(number);
      return item;
    }));
    remaining.value = String(state.remaining);
    staleWarning.hidden = !state.stale;
    eventError.textContent = state.error ?? '';
    manualInput.disabled = state.manualDisabled;
    manualButton.disabled = state.manualDisabled;
    digitalButton.disabled = state.digitalDisabled;
    reloadButton.disabled = state.reloadDisabled;
  },
});
void controller.start();
