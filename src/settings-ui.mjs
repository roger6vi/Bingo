// Configuración workspace: form ⇄ draft, visible dirty state, the unsaved-changes guard, and the
// simulator feed. Only the draft reaches the simulator; committed values come from acknowledged IPC.
import { createConfigurationController } from './configuration-controller.mjs';
import { createSimulatorFeed } from './public-bridge.mjs';

const SIMULATOR_WIDTH = 1920;
const TEXT_FIELDS = ['name', 'place', 'date'];

export function bindSettings(elements, { saveMeta, saveTheme }) {
  const { form, inputs, theme, state, error, actions, save, discard, dialog, frame, viewport } = elements;
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
    const { draft, dirty, pending, errors, canSave } = next;
    const editable = draft !== null && !pending && !locked;
    for (const field of TEXT_FIELDS) {
      const input = inputs[field];
      if (draft !== null && input.value !== draft[field]) input.value = draft[field];
      input.disabled = !editable;
      // The field renders, describes and announces its own error.
      input.error = errors[field] ?? '';
    }
    if (draft?.theme) theme.value = draft.theme;
    theme.disabled = !editable;
    theme.error = errors.theme ?? '';
    if (actions) actions.pending = pending;
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
    } else feed.update({ meta: null });
  }

  const config = createConfigurationController({ saveMeta, saveTheme }, { render });

  for (const field of TEXT_FIELDS) {
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
