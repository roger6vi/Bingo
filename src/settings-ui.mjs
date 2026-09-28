// Configuración workspace: form ⇄ draft, visible dirty state, the unsaved-changes guard, and the
// simulator feed. Only the draft reaches the simulator; committed values come from acknowledged IPC.
import { createConfigurationController, previewPrizes, PRIZE_FIELDS } from './configuration-controller.mjs';
import { createSimulatorFeed } from './public-bridge.mjs';

const SIMULATOR_WIDTH = 1920;
const TEXT_FIELDS = ['name', 'place', 'date'];

export function bindSettings(elements, { saveMeta, saveTheme, savePrizes }) {
  const { form, inputs, fieldErrors, theme, state, error, save, discard, dialog, frame, viewport } = elements;
  const feed = createSimulatorFeed(frame);
  let locked = false;
  let last = null;

  dialog.actions = [
    { action: 'cancel', label: 'Cancelar', signal: 'dismiss' },
    { action: 'discard', label: 'Descartar cambios', signal: 'discard' },
    { action: 'save', label: 'Guardar cambios', signal: 'save' },
  ];

  function render(next) {
    last = next;
    const { committed, draft, dirty, pending, errors, canSave } = next;
    const editable = draft !== null && !pending && !locked;
    for (const field of [...TEXT_FIELDS, ...PRIZE_FIELDS]) {
      const input = inputs[field];
      // Prizes that could not be read (null) stay blank and locked rather than inviting an overwrite.
      const value = draft?.[field] ?? null;
      if (value !== null && input.value !== value) input.value = value;
      if (draft !== null && value === null) input.value = '';
      input.disabled = !editable || value === null;
      const message = errors[field] ?? '';
      input.setAttribute('aria-invalid', String(message !== ''));
      fieldErrors[field].textContent = message;
      fieldErrors[field].hidden = message === '';
    }
    if (draft?.theme) theme.value = draft.theme;
    theme.disabled = !editable;
    save.disabled = !canSave || locked;
    discard.disabled = !dirty || pending || locked;
    state.message = draft === null ? 'Elige un evento activo para configurarlo.'
      : pending ? 'Guardando cambios'
        : dirty ? 'Cambios sin guardar: solo se ven en el simulador.' : 'Sin cambios pendientes.';
    state.tone = dirty && !pending ? 'warning' : 'info';
    error.message = next.error ?? '';
    error.tone = 'error';
    error.hidden = !next.error;
    // The simulator previews the draft presentation; the history it shows is always the committed one.
    if (draft !== null) {
      feed.update({ meta: { name: draft.name.trim(), date: draft.date, place: draft.place.trim() } });
      if (draft.theme) feed.update({ theme: draft.theme });
      feed.update({ prizes: previewPrizes(draft, committed) });
    } else feed.update({ meta: null, prizes: null });
  }

  const config = createConfigurationController({ saveMeta, saveTheme, savePrizes }, { render });

  for (const field of [...TEXT_FIELDS, ...PRIZE_FIELDS]) {
    inputs[field].addEventListener('input', () => config.edit(field, inputs[field].value));
  }
  theme.addEventListener('change', () => config.edit('theme', theme.value));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void config.save();
  });
  discard.addEventListener('click', () => config.discard());

  // Scale the 1920×1080 public page to the viewport so it lays out exactly as on the screen.
  const scale = () => viewport.style.setProperty('--simulator-scale', String(viewport.clientWidth / SIMULATOR_WIDTH));
  new ResizeObserver(scale).observe(viewport);
  scale();

  function choose() {
    return new Promise((resolve) => {
      const signals = ['save', 'discard', 'dismiss'];
      const listeners = signals.map((signal) => {
        const listener = () => {
          signals.forEach((name, index) => dialog.removeEventListener(name, listeners[index]));
          resolve(signal);
        };
        dialog.addEventListener(signal, listener);
        return listener;
      });
      void dialog.show();
    });
  }

  return {
    config,
    // Resolves true when leaving is safe: no edits, a committed save, or an explicit discard.
    confirmLeave() {
      if (!config.isDirty()) return true;
      if (config.isPending()) return false;
      return choose().then(async (choice) => {
        if (choice === 'save') return config.save();
        if (choice === 'discard') {
          config.discard();
          return true;
        }
        return false;
      });
    },
    showCommitted(result) { feed.update({ event: result }); },
    setLocked(value) {
      locked = value;
      if (last !== null) render(last);
    },
  };
}
