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
import './components/bingo-tongo-control.mjs';
import { BingoButton } from './components/bingo-button.mjs';
import { BingoTextField } from './components/bingo-text-field.mjs';
import { BingoDateField } from './components/bingo-date-field.mjs';
import { BingoSelectField } from './components/bingo-select-field.mjs';
import { BingoFormActions } from './components/bingo-form-actions.mjs';
import './screen.css';
import { createOperatorController, createLineController } from './operator-controller.mjs';
import { createManualDrawHandler } from './manual-draw.mjs';
import { createEventsController, today } from './events-controller.mjs';
import { applyTheme, createThemeController, DEFAULT_THEME, revealAfter } from './theme-controller.mjs';
import { operatorMessage, lineAwardSummary, linePrizeSummary, LINE_REFRESH_FAILED_ES, PHASE_LABELS_ES, THEME_NAMES_ES } from './operator-copy.mjs';
import { bindSettings } from './settings-ui.mjs';
import { bindCueControls } from './cue-ui.mjs';
import { createTongoController, tongoPlayable } from './tongo.mjs';
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
const board = required('operator-board', HTMLElement);
const summary = required('event-summary', HTMLElement);
const phaseStatus = required('phase-status', HTMLElement);
const eventStatus = required('event-status', HTMLElement);
const eventError = required('event-error', HTMLElement);
const themeSelect = required('theme-select', BingoSelectField);
const cues = bindCueControls({ mute: required('cue-mute', HTMLInputElement), volume: required('cue-volume', HTMLInputElement),
  test: required('cue-test', HTMLInputElement), status: required('cue-status', HTMLElement) },
{ createAudio: (url) => new Audio(url),
  // Resolved per call: a blocked localStorage getter throws, and the player then keeps its defaults.
  storage: { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) } });
// Every operator Tongo request goes through the cue controls, so cues never overlap its public window.
const desktop = Object.freeze({ ...window.desktop, playTongo: () => cues.playTongo(() => window.desktop.playTongo()) });

// Configuración edits a draft that only the simulator shows; Save commits it through the same IPC.
let committedTheme = null;
const settings = bindSettings({
  form: required('settings-form', HTMLFormElement),
  inputs: { name: required('settings-name', BingoTextField), place: required('settings-place', BingoTextField),
    date: required('settings-date', BingoDateField),
    lineAmount: required('settings-line-amount', BingoTextField), lineLot: required('settings-line-lot', BingoTextField),
    bingoAmount: required('settings-bingo-amount', BingoTextField), bingoLot: required('settings-bingo-lot', BingoTextField) },
  theme: themeSelect,
  state: required('settings-state', HTMLElement),
  error: required('settings-error', HTMLElement),
  actions: required('settings-actions', BingoFormActions),
  save: required('settings-save', BingoButton),
  discard: required('settings-discard', BingoButton),
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
  const asked = settings.config.activeEventId();
  let result = null;
  try { result = await window.desktop.getPrizes(); } catch { /* Reported below. */ }
  const ok = result?.ok === true && typeof result.eventId === 'string' && validPrizes(result.prizes);
  if (ok) settings.config.setCommittedPrizes(result.eventId, result.prizes);
  // A failed read leaves the prizes unknown, never the older values, for the event it was asked under.
  else if (asked !== null) settings.config.invalidatePrizes(asked);
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
let drawLocks = { manualDisabled: true, digitalDisabled: true, reloadDisabled: false, pending: false };
let themePending = true;
let eventsPending = false;
let eventListRef = null;
// While Tongo is requested or playing, every other live action waits; it is offered only during play.
let tongoBusy = false;
let gameState = null;
// Until main's line state is read, drawing and the conflicting live actions stay locked.
let lineState = { mode: 'unknown', pending: false, drawBlocked: true, liveBlocked: true, refresh: 'none' };
let activeEventId = null;
let createSubmitRef = null;
// Main's line state must belong to the event the page shows as active; otherwise it is not trusted.
// Only the data of the current mode counts: the controller keeps an old award after a later read of none.
const lineEventId = () => (lineState.mode === 'setup' ? lineState.session?.eventId : lineState.mode === 'declared' ? lineState.award?.eventId : null) ?? null;
const lineMismatch = () => activeEventId !== null && lineEventId() !== null && lineEventId() !== activeEventId;
// A setup, a request in flight or a running celebration (pending/started) blocks the writes main refuses; a failed or
// interrupted one does not, so another event can still be selected.
const lineBlocked = () => lineState.liveBlocked !== false;
// Drawing needs a known, completed (and event-refreshed) presentation for the event the page shows as active.
const drawingBlocked = () => lineState.drawBlocked !== false || lineMismatch() || lineBlocked();
const LINE_MISMATCH = 'El estado de la línea pertenece a otro evento. Pulsa «Recargar eventos» para leerlo de nuevo.';
const claimLine = required('claim-line', BingoButton);
const lineRetry = required('line-retry', BingoButton);
const lineRepeat = required('line-repeat', BingoButton);
const LINE_LABELS = { setup: 'Reanudar línea', uncertain: 'Comprobar línea', declared: 'Línea declarada' };
// Starting needs a fully known drawing game; recovery and resuming need only main's answer.
function lineClaimDisabled() {
  // Pending stays enabled so the button keeps focus; the controller already ignores a second request.
  if (lineState.mode === 'declared' || lineMismatch()) return true;
  if (lineState.mode === 'idle') return !(gameState?.snapshot && !gameState.stale && !gameState.pending && gameState.phase === 'drawing');
  return false;
}
const tongoControl = required('tongo-control', HTMLElement);
const tongoError = required('tongo-error', HTMLElement);
function applyLocks() {
  // An open or in-flight first-line setup blocks the same writes main refuses.
  const lineLocked = lineBlocked();
  const locked = selecting || activating || tongoBusy || lineLocked;
  const drawLocked = locked || drawingBlocked();
  claimLine.disabled = selecting || activating || tongoBusy || lineClaimDisabled();
  tongoControl.disabled = locked || !tongoPlayable(gameState);
  controls.manualDisabled = drawLocked || drawLocks.manualDisabled;
  controls.digitalDisabled = drawLocked || drawLocks.digitalDisabled;
  // Reloading the event is the recovery path while a setup is open (it only re-reads); a line request in flight still blocks it.
  controls.reloadDisabled = selecting || activating || tongoBusy || lineState.pending || drawLocks.reloadDisabled;
  // A request in flight keeps the board idle-looking but inert; it is disabled only when it cannot draw.
  board.disabled = drawLocked || (drawLocks.manualDisabled && !drawLocks.pending);
  board.pending = drawLocks.pending;
  settings.setLocked(locked || themePending);
  // A second selection must not start until the first one's dependent panels have re-read.
  if (eventListRef !== null) eventListRef.disabled = eventsPending || activating || tongoBusy || lineLocked;
  // Main refuses a create during a setup; reload stays available as the recovery path.
  if (createSubmitRef !== null) createSubmitRef.disabled = eventsPending || lineLocked;
  paintLineActions();
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

const controller = createOperatorController(desktop, {
  bind: ({ manual, digital, reload: reloadEvent }) => {
    // Reload only reads; after a failed post-celebration refresh it is also the explicit recovery.
    const reload = () => { reloadEvent(); void rereadLine(); line.retryRefresh(); };
    // The board only requests a call; it shows the number called once the acknowledged snapshot arrives.
    board.addEventListener('number-select', (event) => {
      if (selecting || activating || tongoBusy || drawingBlocked() || controls.mode === 'digital') return;
      manual(event.detail.number);
    });
    controls.addEventListener('click', (event) => {
      if (selecting || activating || tongoBusy) return;
      const action = event.composedPath().find((node) => node?.id === 'draw-manual' || node?.id === 'draw-digital' || node?.id === 'reload-event');
      if (action?.id === 'draw-manual') { if (!drawingBlocked()) createManualDrawHandler(controls.manualInput, manual)(); }
      else if (action?.id === 'draw-digital') { if (!drawingBlocked()) digital(); }
      else if (action?.id === 'reload-event') reload();
    });
  },
  clearManual: () => { controls.manualInput.value = ''; },
  render: (state, acknowledgement) => {
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
    gameState = state;
    drawLocks = { manualDisabled: state.manualDisabled, digitalDisabled: state.digitalDisabled,
      reloadDisabled: state.reloadDisabled, pending: state.pending };
    applyLocks();
    cues.observe(state.snapshot, acknowledgement);
    // The simulator shows only committed history; it has no draw path of its own.
    settings.showCommitted(state.snapshot === null
      ? { ok: false, code: 'event_unavailable', message: 'No current event is available.' }
      : { ok: true, snapshot: state.snapshot, eventChanged: true });
  },
});
void controller.start();

const lineStatus = required('line-status', HTMLElement);
const lineDialog = required('line-dialog', HTMLElement);
const lineWinners = required('line-winners', BingoTextField);
const linePrize = required('line-prize', HTMLElement);
lineDialog.actions = [{ action: 'cancel', label: 'Cancelar', signal: 'dismiss' },
  { action: 'confirm', label: 'Declarar línea', signal: 'confirm' }];
let lineDialogShown = false;
// Only a failed celebration can be retried and only an interrupted one repeated; nothing else is offered.
function paintLineActions() {
  const presentation = lineState.mode === 'declared' && !lineMismatch() ? lineState.award?.presentation : undefined;
  const busy = lineState.pending || selecting || activating || tongoBusy;
  for (const [button, status] of [[lineRetry, 'failed'], [lineRepeat, 'interrupted']]) {
    button.hidden = presentation?.status !== status;
    button.disabled = busy;
  }
}
function paintLineStatus() {
  const state = lineState;
  const shown = lineStatus.hidden;
  const presentation = state.mode === 'declared' ? state.award?.presentation?.status : undefined;
  lineStatus.message = state.pending ? 'Comprobando la línea' : operatorMessage(state.error)
    ?? (lineMismatch() ? LINE_MISMATCH : state.mode === 'declared' && state.award
      ? `${lineAwardSummary(state.award)}${state.refresh === 'failed' ? ` ${LINE_REFRESH_FAILED_ES}` : ''}`
      : state.mode === 'setup' && !state.dialogOpen ? 'Hay una declaración de línea abierta. Pulsa «Reanudar línea» para continuar o cancelarla.' : '');
  lineStatus.tone = state.error ? 'error' : lineMismatch() || presentation === 'failed' || presentation === 'interrupted' || state.refresh === 'failed' ? 'warning'
    : presentation === 'completed' ? 'success' : 'info';
  lineStatus.hidden = lineStatus.message === '';
  // Like Tongo's refusal, a new line message must not stay clipped at the bottom of the rail.
  if (lineStatus.hidden === false && shown) void lineStatus.updateComplete.then(() => lineStatus.scrollIntoView({ block: 'nearest' }));
}
const line = createLineController(desktop, {
  render: (state) => {
    lineState = state;
    claimLine.textContent = LINE_LABELS[state.mode] ?? 'Línea';
    paintLineStatus();
    paintLineActions();
    if (state.session) linePrize.textContent = linePrizeSummary(state.session.linePrize);
    lineWinners.error = operatorMessage(state.countError) ?? '';
    if (state.dialogOpen && !lineDialogShown) {
      lineDialogShown = true;
      // A fresh setup starts at one winner; a corrected attempt keeps what was typed.
      if (state.countError === null) lineWinners.value = '1';
      // After the dialog closed itself, the opener has regained focus, so it is restored to the same button.
      queueMicrotask(() => { void lineDialog.show(); });
    }
    applyLocks();
  },
}, { committed: refreshEvent });
// A completed celebration needs a fresh authoritative event. A read already in flight may predate it, so the new
// read is queued behind it; the answer says whether the page now holds an accepted, current event.
async function refreshEvent() {
  while (drawLocks.pending) await controller.start();
  await controller.start();
  return gameState !== null && !gameState.stale && gameState.error === null && gameState.snapshot !== null;
}
// Explicit buttons only: the handler re-validates the exact current id, status, event and busy state itself.
const presentationClick = (status, run) => () => {
  const award = lineState.award;
  const presentation = award?.presentation;
  if (lineState.pending || selecting || activating || tongoBusy || lineState.mode !== 'declared' || lineMismatch() ||
    award.eventId !== activeEventId || presentation?.status !== status) return;
  void run(presentation.id);
};
lineRetry.addEventListener('click', presentationClick('failed', (id) => line.retry(id)));
lineRepeat.addEventListener('click', presentationClick('interrupted', (id) => line.repeat(id)));
window.addEventListener('pagehide', () => line.dispose());
claimLine.addEventListener('click', () => { if (!claimLine.disabled) void line.open(); });
lineDialog.addEventListener('dismiss', () => { lineDialogShown = false; void line.cancel(); });
lineDialog.addEventListener('confirm', () => { lineDialogShown = false; void line.confirm(lineWinners.value); });
void line.start();
// After any change of the active event, main's line state is read again (never confirmed or cancelled).
// A read already in flight may predate the change, so it settles first.
async function rereadLine() {
  if (lineState.pending) await line.start();
  await line.start();
}

const tongo = createTongoController(desktop, {
  render: ({ busy, progress, error }) => {
    tongoBusy = busy;
    tongoControl.progress = progress;
    tongoError.message = operatorMessage(error) ?? '';
    tongoError.tone = 'error';
    // A refusal adds a status line below the claims; the rail has no spare height at 1280×720, so bring
    // it into view instead of leaving it clipped at the bottom of the rail.
    const shown = Boolean(error) && tongoError.hidden;
    tongoError.hidden = !error;
    if (shown) void tongoError.updateComplete.then(() => tongoError.scrollIntoView({ block: 'nearest' }));
    applyLocks();
  },
});
tongoControl.addEventListener('tongo-play', () => {
  if (!tongoBusy && !tongoControl.disabled) void tongo.play();
});

const themeStatus = required('theme-status', HTMLElement);
const themes = createThemeController(desktop, {
  render: ({ theme, pending, error }) => {
    // Only an acknowledged theme is applied; a failed first read reveals the default.
    if (theme !== null) applyTheme(document.documentElement, theme);
    else if (error !== null && !document.documentElement.dataset.theme) applyTheme(document.documentElement, DEFAULT_THEME);
    committedTheme = theme;
    if (theme !== null) settings.config.setCommittedTheme(theme);
    themePending = pending;
    themeSelect.pending = pending;
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
const createSubmit = required('create-event-submit', BingoButton);
createSubmitRef = createSubmit;
const createActions = required('create-event-actions', BingoFormActions);
const eventDate = required('event-date', BingoDateField);
const banner = required('active-event-banner', HTMLElement);
eventDate.value = today();

// Both dependent panels re-read the newly committed event and its theme.
const events = createEventsController(desktop, {
  render: ({ events: list, loaded, pending, stale, error, active }) => {
    eventList.events = list;
    eventList.loaded = loaded;
    selecting = pending === 'select';
    eventsPending = pending !== null;
    applyLocks();
    reloadEvents.disabled = pending !== null;
    if (!stale) {
      activeEventId = active?.id ?? null;
      line.setEvent(activeEventId);
    }
    paintLineStatus();
    applyLocks();
    createActions.pending = pending === 'create';
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
    banner.message = active ? `${active.name} — ${active.date}, ${active.place}`
      : loaded ? 'Ningún evento seleccionado. Elige uno en Eventos.' : 'Cargando evento';
    banner.tone = active && !stale ? 'info' : 'warning';
  },
}, () => Promise.all([controller.resync(), themes.start(), loadPrizes(), rereadLine()]));
// events.select resolves only after resync() and the theme re-read settle.
eventList.addEventListener('event-select', async (event) => {
  if (activating || tongoBusy || lineBlocked()) return;
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
reloadEvents.addEventListener('click', () => { void events.start(); void loadPrizes(); void rereadLine(); line.retryRefresh(); });
createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lineBlocked()) return;
  const meta = { name: createForm.elements.name.value, place: createForm.elements.place.value, date: eventDate.value };
  const created = await events.create(meta);
  // A create may have activated the new event, so main's line state is read again either way.
  void rereadLine();
  if (created) {
    createForm.reset();
    eventDate.value = today();
  }
});
void events.start();
// If getTheme() never settles, reveal the default without marking it as the saved theme.
revealAfter(document.documentElement, 2000);
