import { createPublicController } from './public-controller.mjs';

function required(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing or invalid public element: ${id}`);
  return element;
}

const latest = required('latest-draw', HTMLOutputElement);
const history = required('called-numbers', HTMLOListElement);
const count = required('called-count', HTMLOutputElement);
const remaining = required('remaining-count', HTMLOutputElement);
const status = required('event-status', HTMLParagraphElement);
const staleWarning = required('stale-warning', HTMLParagraphElement);
const eventError = required('event-error', HTMLParagraphElement);

const controller = createPublicController(window.publicEvent, {
  render: (state) => {
    latest.value = state.loaded
      ? (state.latest === null ? 'No draws yet' : String(state.latest))
      : 'Waiting for event';
    history.replaceChildren(...state.calledNumbers.map((number) => {
      const item = document.createElement('li');
      item.textContent = String(number);
      return item;
    }));
    count.value = String(state.count);
    remaining.value = String(state.remaining);
    status.textContent = state.loaded ? (state.stale ? 'Last confirmed event state' : 'Event ready')
      : (state.error ? 'Event unavailable' : 'Waiting for event state');
    staleWarning.hidden = !state.stale;
    eventError.textContent = state.error ?? '';
  },
});
window.addEventListener('pagehide', () => controller.cleanup(), { once: true });
