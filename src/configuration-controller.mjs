// The active event's configuration as a draft over the last committed values. Edits stay local
// (they only feed the simulator) until save() receives an acknowledged commit for every changed part.
import { validTheme } from './theme-controller.mjs';

const MAX_TEXT = 120;
const META_FIELDS = ['name', 'date', 'place'];
const FIELDS = [...META_FIELDS, 'theme'];

// Same rules as the store: trimmed text of 1–120 characters and a real calendar date.
export const validText = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_TEXT;
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function validateDraft(draft) {
  const errors = {};
  if (!validText(draft.name)) errors.name = 'Escribe un nombre de 1 a 120 caracteres.';
  if (!validDate(draft.date)) errors.date = 'Elige una fecha válida.';
  if (!validText(draft.place)) errors.place = 'Escribe un lugar de 1 a 120 caracteres.';
  if (!validTheme(draft.theme)) errors.theme = 'Elige un tema.';
  return errors;
}

export const SAVE_ERRORS = Object.freeze({
  meta: 'No se guardaron los datos del evento. Los cambios siguen en el borrador; inténtalo de nuevo.',
  theme: 'No se guardó el tema. Los cambios siguen en el borrador; inténtalo de nuevo.',
  themeAfterMeta: 'Los datos del evento se guardaron, pero el tema no. El tema sigue en el borrador; inténtalo de nuevo.',
});

// saveMeta(id, meta) and saveTheme(theme) resolve true only after an acknowledged commit.
export function createConfigurationController({ saveMeta, saveTheme }, view) {
  let committed = null;
  // The theme read may settle before the event list, so it is kept apart until both are known.
  let committedTheme = null;
  let draft = null;
  let pending = false;
  let error = null;

  const changed = (fields) => committed !== null && fields.some((field) => draft[field] !== committed[field]);
  const dirty = () => changed(FIELDS);

  function render() {
    const errors = draft === null ? {} : validateDraft(draft);
    view.render({ committed: committed && { ...committed }, draft: draft && { ...draft }, dirty: dirty(), pending,
      error, errors, canSave: committed !== null && dirty() && !pending && Object.keys(errors).length === 0 });
  }

  // A field the operator has not edited follows the newly committed value; edited fields are kept.
  function follow(next) {
    const previous = committed;
    committed = next;
    if (next === null) draft = null;
    else if (previous === null || previous.id !== next.id || draft === null) {
      draft = { ...next };
      error = null;
    } else for (const field of FIELDS) if (draft[field] === previous[field]) draft[field] = next[field];
    render();
  }

  async function save() {
    if (committed === null || pending || !dirty() || Object.keys(validateDraft(draft)).length !== 0) return false;
    pending = true;
    error = null;
    render();
    const id = committed.id;
    let metaSaved = false;
    try {
      if (changed(META_FIELDS)) {
        const meta = { name: draft.name.trim(), date: draft.date, place: draft.place.trim() };
        if (!await saveMeta(id, meta)) {
          error = SAVE_ERRORS.meta;
          return false;
        }
        metaSaved = true;
        // The acknowledgement is the committed baseline even if the refreshed list was unreadable.
        if (committed?.id === id) {
          committed = { ...committed, ...meta };
          Object.assign(draft, meta);
        }
      }
      if (committed?.id === id && changed(['theme'])) {
        const theme = draft.theme;
        if (!await saveTheme(theme)) {
          error = metaSaved ? SAVE_ERRORS.themeAfterMeta : SAVE_ERRORS.theme;
          return false;
        }
        committedTheme = theme;
        if (committed?.id === id) committed = { ...committed, theme };
      }
      return committed?.id === id && !dirty();
    } catch {
      error = metaSaved ? SAVE_ERRORS.themeAfterMeta : SAVE_ERRORS.meta;
      return false;
    } finally {
      pending = false;
      render();
    }
  }

  render();
  return {
    setCommittedEvent(event) {
      if (event === null) return follow(null);
      follow({ id: event.id, name: event.name, date: event.date, place: event.place, theme: committedTheme });
    },
    setCommittedTheme(theme) {
      if (!validTheme(theme) || theme === committedTheme) return;
      committedTheme = theme;
      if (committed !== null) follow({ ...committed, theme });
    },
    edit(field, value) {
      if (committed === null || pending || !FIELDS.includes(field) || typeof value !== 'string') return;
      draft[field] = value;
      error = null;
      render();
    },
    // Restores the last committed configuration.
    discard() {
      if (committed === null || pending) return;
      draft = { ...committed };
      error = null;
      render();
    },
    save,
    isDirty: dirty,
    isPending: () => pending,
  };
}
