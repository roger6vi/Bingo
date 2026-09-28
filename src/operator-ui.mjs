import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-status.mjs';
import './components/bingo-operator-summary.mjs';
import './components/bingo-call-history.mjs';
import './components/bingo-draw-controls.mjs';
import './components/bingo-dialog.mjs';
import './screen.css';
import { createOperatorController } from './operator-controller.mjs';
import { createManualDrawHandler } from './manual-draw.mjs';
import { applyTheme, createThemeController, DEFAULT_THEME, THEME_LABELS } from './theme-controller.mjs';

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
    controls.manualDisabled = state.manualDisabled;
    controls.digitalDisabled = state.digitalDisabled;
    controls.reloadDisabled = state.reloadDisabled;
  },
});
void controller.start();

const themeSelect = required('theme-select', HTMLSelectElement);
const themeStatus = required('theme-status', HTMLElement);
const themes = createThemeController(window.desktop, {
  render: ({ theme, pending, error }) => {
    // Only an acknowledged theme is applied; a failed first read reveals the default.
    if (theme !== null) applyTheme(document.documentElement, theme);
    else if (error !== null && !document.documentElement.dataset.theme) applyTheme(document.documentElement, DEFAULT_THEME);
    themeSelect.value = theme ?? DEFAULT_THEME;
    themeSelect.disabled = pending;
    themeStatus.message = error ?? (pending ? 'Saving theme' : theme === null ? 'Waiting for theme'
      : `Current theme: ${THEME_LABELS[theme]}`);
    themeStatus.tone = error ? 'error' : 'info';
  },
});
themeSelect.addEventListener('change', () => { void themes.select(themeSelect.value); });
void themes.start();
