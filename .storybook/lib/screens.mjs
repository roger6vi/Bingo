// Screen stories mount the real page markup (src/operator.html, src/public.html) and drive its components
// with in-memory state, mirroring the render functions in operator-ui.mjs / public-ui.mjs. No controllers,
// IPC or preload run here; only presentation. If a page gains or renames ids, update the setters below.
import '../../src/bingo-shell.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-event-list.mjs';
import operatorSource from '../../src/operator.html?raw';
import publicSource from '../../src/public.html?raw';
import sampleVideoUrl from '../../assets/sample.mp4?url';
import { bindTabs } from '../../src/operator-tabs.mjs';
import { validateDraft } from '../../src/configuration-controller.mjs';
import { DEFAULT_THEME, THEME_LABELS } from '../../src/theme-controller.mjs';
import { ACTIVE_EVENT, EVENTS, PHASE_LABELS } from './fixtures.mjs';

const SIMULATOR_WIDTH = 1920;

function mountPage(source) {
  const page = new DOMParser().parseFromString(source, 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  const container = document.createElement('div');
  container.className = 'sb-screen';
  container.lang = page.documentElement.lang;
  container.append(...[...page.body.childNodes].map((node) => document.importNode(node, true)));
  customElements.upgrade(container);
  return container;
}

const status = (element, message, tone = 'info', hidden = false) => {
  if (!element) return;
  element.message = message;
  element.tone = tone;
  element.hidden = hidden;
};

// Runs once the story root is in the document (tabs and the simulator need layout and ids).
const whenConnected = (container, callback) => requestAnimationFrame(() => { if (container.isConnected) callback(); });

/* ---------------------------------------------------------------- Operator console */

export const operatorDefaults = {
  tab: 'bingo',
  events: { list: EVENTS, loaded: true, pending: null, stale: false, error: null },
  game: { calledNumbers: [], phase: 'drawing', loaded: true, pending: false, stale: false, error: null },
  settings: { draft: null, pending: false, error: null, themePending: false, themeError: null, dialog: false },
  publicWarning: false,
  simulatorStory: 'screens-public-display--mid-game',
};

export function operatorScreen(options) {
  const state = {
    ...operatorDefaults, ...options,
    events: { ...operatorDefaults.events, ...options.events },
    game: { ...operatorDefaults.game, ...options.game },
    settings: { ...operatorDefaults.settings, ...options.settings },
  };
  const container = mountPage(operatorSource);
  const $ = (id) => container.querySelector(`#${id}`);
  const active = state.events.list.find((event) => event.active) ?? null;
  const theme = document.documentElement.dataset.theme || DEFAULT_THEME;

  // Tabs: same attributes bindTabs() writes, so the first paint is already correct.
  for (const tab of container.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${state.tab}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }

  // Eventos
  const { list, loaded, pending, stale, error } = state.events;
  const eventList = $('event-list');
  eventList.events = list;
  eventList.loaded = loaded;
  eventList.disabled = pending !== null;
  status($('events-status'), pending === 'select' ? 'Activando evento' : pending === 'create' ? 'Creando evento'
    : !loaded ? (pending ? 'Cargando eventos' : 'No se pudieron cargar los eventos')
      : stale ? 'La lista de eventos puede estar desactualizada. Recárgala antes de continuar.'
        : `${list.length} evento${list.length === 1 ? '' : 's'}`, stale ? 'warning' : 'info');
  status($('events-error'), error ?? '', 'error', !error);
  $('reload-events').disabled = pending !== null;
  $('create-event-submit').disabled = pending !== null;
  $('event-date').value = '2026-10-03';
  for (const banner of container.querySelectorAll('.active-event-banner')) {
    status(banner, active ? `Evento activo: ${active.name} — ${active.date}, ${active.place}`
      : loaded ? 'Ningún evento activo. Elige uno en Eventos.' : 'Cargando evento activo', active && !stale ? 'info' : 'warning');
  }

  // Bingo
  const game = state.game;
  const remaining = 90 - game.calledNumbers.length;
  const locked = game.pending || !game.loaded || remaining === 0 || pending === 'select';
  $('called-numbers').calledNumbers = game.calledNumbers;
  Object.assign($('event-summary'), { latest: game.calledNumbers.at(-1) ?? null, count: game.calledNumbers.length, remaining });
  status($('phase-status'), game.phase === null ? 'Current phase: waiting for event state' : `Current phase: ${PHASE_LABELS[game.phase]}`);
  status($('event-status'), game.stale ? 'Event history may be stale. Reload before relying on it.'
    : game.pending ? 'Loading event state' : !game.loaded ? 'Waiting for event state' : 'Event ready', game.stale ? 'warning' : 'info');
  status($('event-error'), game.error ?? '', 'error', !game.error);
  Object.assign($('draw-controls'), { manualDisabled: locked, digitalDisabled: locked, reloadDisabled: game.pending });
  status($('public-status'), state.publicWarning
    ? 'Secondary display disconnected. Public output moved to primary preview; pause bingo until ready.' : '', 'warning', !state.publicWarning);

  // Configuración: the draft over the committed active event.
  const settings = state.settings;
  const committed = active && { ...active, theme };
  const draft = committed && { ...committed, ...settings.draft };
  const errors = draft ? validateDraft(draft) : {};
  const dirty = Boolean(committed && ['name', 'date', 'place', 'theme'].some((field) => draft[field] !== committed[field]));
  const editable = draft !== null && !settings.pending;
  for (const field of ['name', 'place', 'date']) {
    const input = $(`settings-${field}`);
    input.value = draft?.[field] ?? '';
    input.disabled = !editable;
    input.setAttribute('aria-invalid', String(Boolean(errors[field])));
    const message = $(`settings-${field}-error`);
    message.textContent = errors[field] ?? '';
    message.hidden = !errors[field];
  }
  const themeSelect = $('theme-select');
  themeSelect.value = draft?.theme ?? theme;
  themeSelect.disabled = !editable || settings.themePending;
  status($('theme-status'), settings.themeError ?? (settings.themePending ? 'Guardando tema' : `Tema guardado: ${THEME_LABELS[theme] ?? theme}`),
    settings.themeError ? 'error' : 'info');
  $('settings-save').disabled = !(dirty && !settings.pending && Object.keys(errors).length === 0);
  $('settings-discard').disabled = !dirty || settings.pending;
  status($('settings-state'), draft === null ? 'Elige un evento activo para configurarlo.'
    : settings.pending ? 'Guardando cambios' : dirty ? 'Cambios sin guardar: solo se ven en el simulador.' : 'Sin cambios pendientes.',
    dirty && !settings.pending ? 'warning' : 'info');
  status($('settings-error'), settings.error ?? '', 'error', !settings.error);
  const dialog = $('unsaved-dialog');
  dialog.actions = [
    { action: 'cancel', label: 'Cancelar', signal: 'dismiss' },
    { action: 'discard', label: 'Descartar cambios', signal: 'discard' },
    { action: 'save', label: 'Guardar cambios', signal: 'save' },
  ];

  // Simulator: in the app a sandboxed frame of the bundled public page fed over postMessage; here the
  // public-display story that matches the draft, at the draft theme, scaled the same way.
  const frame = $('public-simulator');
  frame.removeAttribute('sandbox');
  frame.src = `iframe.html?id=${state.simulatorStory}&viewMode=story&globals=theme:${draft?.theme ?? theme}`;

  whenConnected(container, () => {
    bindTabs(container.querySelector('[role="tablist"]'));
    const viewport = $('simulator-viewport');
    const scale = () => viewport.style.setProperty('--simulator-scale', String(viewport.clientWidth / SIMULATOR_WIDTH));
    new ResizeObserver(scale).observe(viewport);
    scale();
    if (settings.dialog) void dialog.show();
  });
  return container;
}

/* ---------------------------------------------------------------- Public display */

export const publicDefaults = {
  meta: ACTIVE_EVENT, calledNumbers: [], phase: 'drawing', loaded: true, stale: false, error: null,
};

export function publicScreen(options) {
  const state = { ...publicDefaults, ...options };
  const container = mountPage(publicSource);
  const $ = (id) => container.querySelector(`#${id}`);
  const count = state.calledNumbers.length;
  const latest = state.loaded ? (state.calledNumbers.at(-1) ?? null) : null;

  $('event-name').textContent = state.meta ? state.meta.name : 'Current event';
  $('event-details').textContent = state.meta ? `${state.meta.date} · ${state.meta.place}` : '';
  $('event-details').hidden = !state.meta;
  Object.assign($('latest-draw'), { latest, loaded: state.loaded });
  Object.assign($('latest-number'), { value: latest, emptyLabel: state.loaded ? 'No draws yet' : 'Waiting for draw' });
  Object.assign($('called-numbers'), { calledNumbers: state.loaded ? state.calledNumbers : [], loaded: state.loaded });
  $('called-count').value = String(state.loaded ? count : 0);
  $('remaining-count').value = String(state.loaded ? 90 - count : 90);
  status($('phase-status'), state.phase === null ? 'Current phase: waiting for event state' : `Current phase: ${PHASE_LABELS[state.phase]}`);
  status($('event-status'), state.loaded ? (state.stale ? 'Last confirmed history may be stale.' : 'Event ready')
    : (state.error ? '' : 'Waiting for event state'), state.stale ? 'warning' : 'info', Boolean(state.error && !state.loaded));
  status($('event-error'), state.error ?? '', 'error', !state.error);
  $('sample-video-source').src = sampleVideoUrl;
  return container;
}

/**
 * Shared meta for the operator screen story files (one per tab, so the sidebar groups by workspace).
 * Storybook indexes titles statically, so each file keeps `title` and `id` as literals and spreads this.
 */
export const operatorMeta = (tab) => ({
  parameters: { layout: 'fullscreen', sideBySide: false },
  args: { tab, publicWarning: false },
  argTypes: {
    tab: { control: 'inline-radio', options: ['events', 'settings', 'bingo'], description: 'Selected workspace tab.' },
    events: { control: 'object', description: 'Event list state (`list`, `loaded`, `pending`, `stale`, `error`).' },
    game: { control: 'object', description: 'Bingo state (`calledNumbers`, `phase`, `loaded`, `pending`, `stale`, `error`).' },
    settings: { control: 'object', description: 'Configuración draft over the active event, plus save state.' },
    publicWarning: { control: 'boolean', description: 'Secondary display disconnected warning.' },
    simulatorStory: { table: { disable: true } },
  },
  render: (args) => operatorScreen(args),
});
