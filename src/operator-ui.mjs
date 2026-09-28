import './components/bingo-app-shell.mjs';
import './components/bingo-tabs.mjs';
import './components/bingo-side-rail.mjs';
import './components/bingo-button.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-status.mjs';
import './components/bingo-operator-summary.mjs';
import './components/bingo-call-history.mjs';
import './components/bingo-operator-board.mjs';
import './components/bingo-draw-controls.mjs';
import './components/bingo-dialog.mjs';
import './components/bingo-event-list.mjs';
import './screen.css';
import { createOperatorController } from './operator-controller.mjs';
import { createManualDrawHandler } from './manual-draw.mjs';
import { createEventsController, today } from './events-controller.mjs';
import { applyTheme, createThemeController, DEFAULT_THEME, revealAfter } from './theme-controller.mjs';
import { operatorMessage, PHASE_LABELS_ES, THEME_NAMES_ES } from './operator-copy.mjs';
import { bindSettings } from './settings-ui.mjs';

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
const board = required('operator-board', HTMLElement);
const summary = required('event-summary', HTMLElement);
const phaseStatus = required('phase-status', HTMLElement);
const eventStatus = required('event-status', HTMLElement);
const eventError = required('event-error', HTMLElement);
const themeSelect = required('theme-select', HTMLSelectElement);

// Configuración edits a draft that only the simulator shows; Save commits it through the same IPC.
let committedTheme = null;
const settings = bindSettings({
  form: required('settings-form', HTMLFormElement),
  inputs: { name: required('settings-name', HTMLInputElement), place: required('settings-place', HTMLInputElement),
    date: required('settings-date', HTMLInputElement) },
  fieldErrors: { name: required('settings-name-error', HTMLElement), place: required('settings-place-error', HTMLElement),
    date: required('settings-date-error', HTMLElement) },
  theme: themeSelect,
  state: required('settings-state', HTMLElement),
  error: required('settings-error', HTMLElement),
  save: required('settings-save', HTMLButtonElement),
  discard: required('settings-discard', HTMLButtonElement),
  dialog: required('unsaved-dialog', HTMLElement),
  frame: required('public-simulator', HTMLIFrameElement),
  viewport: required('simulator-viewport', HTMLElement),
}, {
  saveMeta: (id, meta) => events.update(id, meta),
  saveTheme: async (theme) => {
    await themes.select(theme);
    return committedTheme === theme;
  },
});

// From the select request until the dependent panels have re-read the new event,
// writes could land on the newly active event unnoticed.
let selecting = false;
let activating = false;
let drawLocks = { manualDisabled: true, digitalDisabled: true, reloadDisabled: false, pending: false };
let themePending = true;
let eventsPending = false;
let eventListRef = null;
function applyLocks() {
  const locked = selecting || activating;
  controls.manualDisabled = locked || drawLocks.manualDisabled;
  controls.digitalDisabled = locked || drawLocks.digitalDisabled;
  controls.reloadDisabled = locked || drawLocks.reloadDisabled;
  // A request in flight keeps the board idle-looking but inert; it is disabled only when it cannot draw.
  board.disabled = locked || (drawLocks.manualDisabled && !drawLocks.pending);
  board.pending = drawLocks.pending;
  settings.setLocked(locked || themePending);
  // A second selection must not start until the first one's dependent panels have re-read.
  if (eventListRef !== null) eventListRef.disabled = eventsPending || activating;
}

openPublic.addEventListener('click', () => window.desktop.openPublic());
movePublic.addEventListener('click', () => window.desktop.movePublicToSecondary());
window.desktop.onPublicStatus((pauseSuggested) => {
  publicStatus.message = pauseSuggested
    ? 'Pantalla secundaria desconectada: la salida pública pasó a la vista previa principal. Pausa el bingo hasta que esté lista.'
    : '';
  publicStatus.tone = 'warning';
  publicStatus.hidden = !pauseSuggested;
});

// Manual mode lets the operator call a number from the board; digital mode leaves it read-only.
board.readonly = controls.mode === 'digital';
controls.addEventListener('mode-change', () => { board.readonly = controls.mode === 'digital'; });

const controller = createOperatorController(window.desktop, {
  bind: ({ manual, digital, reload }) => {
    // The board only requests a call; it shows the number called once the acknowledged snapshot arrives.
    board.addEventListener('number-select', (event) => {
      if (selecting || activating || controls.mode === 'digital') return;
      manual(event.detail.number);
    });
    controls.addEventListener('click', (event) => {
      if (selecting || activating) return;
      const action = event.composedPath().find((node) => node?.id === 'draw-manual' || node?.id === 'draw-digital' || node?.id === 'reload-event');
      if (action?.id === 'draw-manual') createManualDrawHandler(controls.manualInput, manual)();
      else if (action?.id === 'draw-digital') digital();
      else if (action?.id === 'reload-event') reload();
    });
  },
  clearManual: () => { controls.manualInput.value = ''; },
  render: (state) => {
    history.calledNumbers = state.calledNumbers;
    board.calledNumbers = state.calledNumbers;
    board.loaded = state.snapshot !== null;
    board.stale = state.stale;
    summary.latest = state.calledNumbers.at(-1) ?? null;
    summary.count = state.calledNumbers.length;
    summary.remaining = state.remaining;
    phaseStatus.message = state.phase === null ? 'Fase: esperando el estado del evento'
      : `Fase: ${PHASE_LABELS_ES[state.phase]}`;
    phaseStatus.tone = 'info';
    eventStatus.message = state.stale ? 'El historial puede estar desactualizado. Recarga el evento antes de seguir.'
      : state.pending ? 'Actualizando el evento' : state.manualDisabled && state.remaining > 0
        ? 'Esperando el estado del evento' : state.remaining === 0 ? 'Todas las bolas cantadas' : 'Evento listo';
    eventStatus.tone = state.stale ? 'warning' : 'info';
    eventError.message = operatorMessage(state.error) ?? '';
    eventError.tone = 'error';
    eventError.hidden = !state.error;
    drawLocks = { manualDisabled: state.manualDisabled, digitalDisabled: state.digitalDisabled,
      reloadDisabled: state.reloadDisabled, pending: state.pending };
    applyLocks();
    // The simulator shows only committed history; it has no draw path of its own.
    settings.showCommitted(state.snapshot === null
      ? { ok: false, code: 'event_unavailable', message: 'No current event is available.' }
      : { ok: true, snapshot: state.snapshot, eventChanged: true });
  },
});
void controller.start();

const themeStatus = required('theme-status', HTMLElement);
const themes = createThemeController(window.desktop, {
  render: ({ theme, pending, error }) => {
    // Only an acknowledged theme is applied; a failed first read reveals the default.
    if (theme !== null) applyTheme(document.documentElement, theme);
    else if (error !== null && !document.documentElement.dataset.theme) applyTheme(document.documentElement, DEFAULT_THEME);
    committedTheme = theme;
    if (theme !== null) settings.config.setCommittedTheme(theme);
    themePending = pending;
    applyLocks();
    themeStatus.message = operatorMessage(error) ?? (pending ? 'Guardando tema' : theme === null ? 'Esperando el tema guardado'
      : `Tema guardado: ${THEME_NAMES_ES[theme]}`);
    themeStatus.tone = error ? 'error' : 'info';
  },
});
void themes.start();

// Leaving Configuración with unsaved edits offers Save, Discard, or Cancel first.
required('workspace-tabs', HTMLElement).canLeave = (current) => (current.id === 'tab-settings' ? settings.confirmLeave() : true);
const eventList = required('event-list', HTMLElement);
eventListRef = eventList;
const eventsStatus = required('events-status', HTMLElement);
const eventsError = required('events-error', HTMLElement);
const reloadEvents = required('reload-events', HTMLElement);
const createForm = required('create-event', HTMLFormElement);
const createSubmit = required('create-event-submit', HTMLButtonElement);
const eventDate = required('event-date', HTMLInputElement);
const banner = required('active-event-banner', HTMLElement);
eventDate.value = today();

// Both dependent panels re-read the newly committed event and its theme.
const events = createEventsController(window.desktop, {
  render: ({ events: list, loaded, pending, stale, error, active }) => {
    eventList.events = list;
    eventList.loaded = loaded;
    selecting = pending === 'select';
    eventsPending = pending !== null;
    applyLocks();
    reloadEvents.disabled = pending !== null;
    createSubmit.disabled = pending !== null;
    eventsStatus.message = pending === 'select' ? 'Activando evento' : pending === 'create' ? 'Creando evento'
      : !loaded ? (pending ? 'Cargando eventos' : 'No se pudieron cargar los eventos')
        : stale ? 'La lista de eventos puede estar desactualizada. Recárgala antes de continuar.'
          : `${list.length} evento${list.length === 1 ? '' : 's'}`;
    eventsStatus.tone = stale ? 'warning' : 'info';
    eventsError.message = operatorMessage(error) ?? '';
    eventsError.tone = 'error';
    eventsError.hidden = !error;
    // A stale list may predate an acknowledged save; the store rejects a draft for an inactive event anyway.
    if (!stale) settings.config.setCommittedEvent(active);
    banner.message = active ? `Evento activo: ${active.name} — ${active.date}, ${active.place}`
      : loaded ? 'Ningún evento activo. Elige uno en Eventos.' : 'Cargando evento activo';
    banner.tone = active && !stale ? 'info' : 'warning';
  },
}, () => Promise.all([controller.resync(), themes.start()]));
// events.select resolves only after resync() and the theme re-read settle.
eventList.addEventListener('event-select', async (event) => {
  if (activating) return;
  // Selecting another event would replace the draft: offer Save, Discard, or Cancel first.
  if (await settings.confirmLeave() !== true || activating) return;
  activating = true;
  applyLocks();
  try { await events.select(event.detail.id); }
  catch { /* Controllers report their own errors; never leave the rejection unhandled. */ }
  finally {
    activating = false;
    applyLocks();
  }
});
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
