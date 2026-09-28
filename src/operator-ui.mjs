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
import { bindSettings } from './settings-ui.mjs';
import { validPrizes } from './prize-format.mjs';

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

// Configuración edits a draft that only the simulator shows; Save commits it through the same IPC.
let committedTheme = null;
const settings = bindSettings({
  form: required('settings-form', HTMLFormElement),
  inputs: { name: required('settings-name', HTMLInputElement), place: required('settings-place', HTMLInputElement),
    date: required('settings-date', HTMLInputElement),
    lineAmount: required('settings-line-amount', HTMLInputElement), lineLot: required('settings-line-lot', HTMLInputElement),
    bingoAmount: required('settings-bingo-amount', HTMLInputElement), bingoLot: required('settings-bingo-lot', HTMLInputElement) },
  fieldErrors: { name: required('settings-name-error', HTMLElement), place: required('settings-place-error', HTMLElement),
    date: required('settings-date-error', HTMLElement),
    lineAmount: required('settings-line-amount-error', HTMLElement), lineLot: required('settings-line-lot-error', HTMLElement),
    bingoAmount: required('settings-bingo-amount-error', HTMLElement), bingoLot: required('settings-bingo-lot-error', HTMLElement) },
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
  // Only an acknowledgement for the same event counts as committed.
  savePrizes: async (id, prizes) => {
    const result = await window.desktop.updatePrizes(id, prizes);
    return result?.ok === true && result.eventId === id && validPrizes(result.prizes);
  },
});

// The active event's committed prizes. The reply names its event, so one that races a selection is
// only applied once that event is the committed one. Until a read succeeds the prize inputs stay locked.
const prizesStatus = required('prizes-status', HTMLElement);
async function loadPrizes() {
  let result = null;
  try { result = await window.desktop.getPrizes(); } catch { /* Reported below. */ }
  const ok = result?.ok === true && typeof result.eventId === 'string' && validPrizes(result.prizes);
  if (ok) settings.config.setCommittedPrizes(result.eventId, result.prizes);
  prizesStatus.message = ok || result?.code === 'event_unavailable' ? ''
    : 'No se pudieron leer los premios guardados. Pulsa «Recargar eventos» en Eventos para reintentarlo.';
  prizesStatus.tone = 'error';
  prizesStatus.hidden = prizesStatus.message === '';
}
void loadPrizes();

// From the select request until the dependent panels have re-read the new event,
// writes could land on the newly active event unnoticed.
let selecting = false;
let activating = false;
let drawLocks = { manualDisabled: true, digitalDisabled: true, reloadDisabled: false };
let themePending = true;
let eventsPending = false;
let eventListRef = null;
function applyLocks() {
  const locked = selecting || activating;
  controls.manualDisabled = locked || drawLocks.manualDisabled;
  controls.digitalDisabled = locked || drawLocks.digitalDisabled;
  controls.reloadDisabled = locked || drawLocks.reloadDisabled;
  settings.setLocked(locked || themePending);
  // A second selection must not start until the first one's dependent panels have re-read.
  if (eventListRef !== null) eventListRef.disabled = eventsPending || activating;
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
    themeStatus.message = error ?? (pending ? 'Guardando tema' : theme === null ? 'Esperando el tema guardado'
      : `Tema guardado: ${THEME_LABELS[theme]}`);
    themeStatus.tone = error ? 'error' : 'info';
  },
});
void themes.start();

bindTabs(document.querySelector('[role="tablist"]'), {
  canLeave: (current) => (current.id === 'tab-settings' ? settings.confirmLeave() : true),
});
const eventList = required('event-list', HTMLElement);
eventListRef = eventList;
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
    eventsPending = pending !== null;
    applyLocks();
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
    // A stale list may predate an acknowledged save; the store rejects a draft for an inactive event anyway.
    if (!stale) settings.config.setCommittedEvent(active);
    for (const banner of banners) {
      banner.message = active ? `Evento activo: ${active.name} — ${active.date}, ${active.place}`
        : loaded ? 'Ningún evento activo. Elige uno en Eventos.' : 'Cargando evento activo';
      banner.tone = active && !stale ? 'info' : 'warning';
    }
  },
}, () => Promise.all([controller.resync(), themes.start(), loadPrizes()]));
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
reloadEvents.addEventListener('click', () => { void events.start(); void loadPrizes(); });
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
