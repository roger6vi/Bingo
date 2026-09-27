import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-number.mjs';
import './components/bingo-latest-draw.mjs';
import './components/bingo-status.mjs';
import './screen.css';
import sampleVideoUrl from '../assets/sample.mp4?url';
import { createPublicController } from './public-controller.mjs';

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
const history = required('called-numbers', HTMLOListElement);
const count = required('called-count', HTMLOutputElement);
const remaining = required('remaining-count', HTMLOutputElement);
const status = required('event-status', HTMLElement);
const eventError = required('event-error', HTMLElement);

const controller = createPublicController(window.publicEvent, {
  render: (state) => {
    latest.latest = state.latest;
    latest.loaded = state.loaded;
    latestNumber.value = state.latest;
    latestNumber.emptyLabel = state.loaded ? 'No draws yet' : 'Waiting for draw';
    history.replaceChildren(...state.calledNumbers.map((number) => {
      const item = document.createElement('li');
      item.textContent = String(number);
      return item;
    }));
    count.value = String(state.count);
    remaining.value = String(state.remaining);
    status.message = state.loaded ? (state.stale ? 'Last confirmed history may be stale.' : 'Event ready')
      : (state.error ? '' : 'Waiting for event state');
    status.tone = state.stale ? 'warning' : 'info';
    status.hidden = Boolean(state.error && !state.loaded);
    eventError.message = state.error ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
  },
});
window.addEventListener('pagehide', () => controller.cleanup(), { once: true });
