import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-status.mjs';
import './components/bingo-operator-summary.mjs';
import './components/bingo-call-history.mjs';
import './components/bingo-draw-controls.mjs';
import './components/bingo-dialog.mjs';
import './components/bingo-event-list.mjs';
import './screen.css';
import { createOperatorController } from './operator-controller.mjs';
import { createManualDrawHandler } from './manual-draw.mjs';
import { createEventsController, today } from './events-controller.mjs';
import { bindTabs } from './operator-tabs.mjs';
import { applyTheme, createThemeController, DEFAULT_THEME, revealAfter, THEME_LABELS } from './theme-controller.mjs';

function required(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing or invalid operator element: ${id}`);
  return element;
}

const openPublic = required('open-public', HTMLElement);
const movePublic = required('move-public', HTMLElement);
const publicStatus = required('public-status', HTMLElement);
const controls = required('draw-controls', HTMLElement);
const history = required('called-numbers', HTMLElement);
const summary = required('event-summary', HTMLElement);
const phaseStatus = required('phase-status', HTMLElement);
const eventStatus = required('event-status', HTMLElement);
const phaseLabels = {
  drawing: 'Drawing', checking_line: 'Checking line', line_declared: 'Line declared',
  checking_bingo: 'Checking bingo', bingo_declared: 'Bingo declared', finished: 'Finished',
};
const eventError = required('event-error', HTMLElement);
const themeSelect = required('theme-select', HTMLSelectElement);

// While an event select is in flight, writes could land on the newly active event unnoticed.
let selecting = false;
let drawLocks = { manualDisabled: true, digitalDisabled: true, reloadDisabled: false };
let themePending = true;
function applyLocks() {
  controls.manualDisabled = selecting || drawLocks.manualDisabled;
  controls.digitalDisabled = selecting || drawLocks.digitalDisabled;
  controls.reloadDisabled = selecting || drawLocks.reloadDisabled;
  themeSelect.disabled = selecting || themePending;
}

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
    controls.addEventListener('click', (event) => {
      if (selecting) return;
      const action = event.composedPath().find((node) => node?.id === 'draw-manual' || node?.id === 'draw-digital' || node?.id === 'reload-event');
      if (action?.id === 'draw-manual') createManualDrawHandler(controls.manualInput, manual)();
      else if (action?.id === 'draw-digital') digital();
      else if (action?.id === 'reload-event') reload();
    });
  },
  clearManual: () => { controls.manualInput.value = ''; },
  render: (state) => {
    history.calledNumbers = state.calledNumbers;
    summary.latest = state.calledNumbers.at(-1) ?? null;
    summary.count = state.calledNumbers.length;
    summary.remaining = state.remaining;
    phaseStatus.message = state.phase === null ? 'Current phase: waiting for event state'
      : `Current phase: ${phaseLabels[state.phase]}`;
    phaseStatus.tone = 'info';
    eventStatus.message = state.stale ? 'Event history may be stale. Reload before relying on it.'
      : state.pending ? 'Loading event state' : state.manualDisabled && state.remaining > 0
        ? 'Waiting for event state' : 'Event ready';
    eventStatus.tone = state.stale ? 'warning' : 'info';
    eventError.message = state.error ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
    drawLocks = { manualDisabled: state.manualDisabled, digitalDisabled: state.digitalDisabled,
      reloadDisabled: state.reloadDisabled };
    applyLocks();
  },
});
void controller.start();

const themeStatus = required('theme-status', HTMLElement);
const themes = createThemeController(window.desktop, {
  render: ({ theme, pending, error }) => {
    // Only an acknowledged theme is applied; a failed first read reveals the default.
    if (theme !== null) applyTheme(document.documentElement, theme);
    else if (error !== null && !document.documentElement.dataset.theme) applyTheme(document.documentElement, DEFAULT_THEME);
    themeSelect.value = theme ?? DEFAULT_THEME;
    themePending = pending;
    applyLocks();
    themeStatus.message = error ?? (pending ? 'Saving theme' : theme === null ? 'Waiting for theme'
      : `Current theme: ${THEME_LABELS[theme]}`);
    themeStatus.tone = error ? 'error' : 'info';
  },
});
themeSelect.addEventListener('change', () => { if (!selecting) void themes.select(themeSelect.value); });
void themes.start();

bindTabs(document.querySelector('[role="tablist"]'));
const eventList = required('event-list', HTMLElement);
const eventsStatus = required('events-status', HTMLElement);
const eventsError = required('events-error', HTMLElement);
const reloadEvents = required('reload-events', HTMLElement);
const createForm = required('create-event', HTMLFormElement);
const createSubmit = required('create-event-submit', HTMLButtonElement);
const eventDate = required('event-date', HTMLInputElement);
const banners = [...document.querySelectorAll('.active-event-banner')];
eventDate.value = today();

// Both dependent panels re-read the newly committed event and its theme.
const events = createEventsController(window.desktop, {
  render: ({ events: list, loaded, pending, stale, error, active }) => {
    eventList.events = list;
    eventList.loaded = loaded;
    selecting = pending === 'select';
    applyLocks();
    eventList.disabled = pending !== null;
    reloadEvents.disabled = pending !== null;
    createSubmit.disabled = pending !== null;
    eventsStatus.message = pending === 'select' ? 'Activando evento' : pending === 'create' ? 'Creando evento'
      : !loaded ? (pending ? 'Cargando eventos' : 'No se pudieron cargar los eventos')
        : stale ? 'La lista de eventos puede estar desactualizada. Recárgala antes de continuar.'
          : `${list.length} evento${list.length === 1 ? '' : 's'}`;
    eventsStatus.tone = stale ? 'warning' : 'info';
    eventsError.message = error ?? '';
    eventsError.tone = 'error';
    eventsError.hidden = !error;
    for (const banner of banners) {
      banner.message = active ? `Evento activo: ${active.name} — ${active.date}, ${active.place}`
        : loaded ? 'Ningún evento activo. Elige uno en Eventos.' : 'Cargando evento activo';
      banner.tone = active && !stale ? 'info' : 'warning';
    }
  },
}, () => Promise.all([controller.resync(), themes.start()]));
eventList.addEventListener('event-select', (event) => { void events.select(event.detail.id); });
reloadEvents.addEventListener('click', () => { void events.start(); });
createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const meta = { name: createForm.elements.name.value, place: createForm.elements.place.value, date: eventDate.value };
  if (await events.create(meta)) {
    createForm.reset();
    eventDate.value = today();
  }
});
void events.start();
// If getTheme() never settles, reveal the default without marking it as the saved theme.
revealAfter(document.documentElement, 2000);
