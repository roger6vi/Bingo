// The active event's configuration as a draft over the last committed values. Edits stay local
// (they only feed the simulator) until save() receives an acknowledged commit for every changed part.
import { validTheme } from './theme-controller.mjs';
import { MAX_PRIZE_AMOUNT, MAX_PRIZE_LOT, validPrizes } from './prize-format.mjs';

const MAX_TEXT = 120;
const META_FIELDS = ['name', 'date', 'place'];
// Prize fields hold the form text: an amount of '' means 0 € (no money), a lot of '' means no lot.
export const PRIZE_FIELDS = ['lineAmount', 'lineLot', 'bingoAmount', 'bingoLot'];
const FIELDS = [...META_FIELDS, 'theme', ...PRIZE_FIELDS];
const UNKNOWN_PRIZES = Object.freeze(Object.fromEntries(PRIZE_FIELDS.map((field) => [field, null])));

// Same rules as the store: trimmed text of 1–120 characters and a real calendar date.
export const validText = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_TEXT;
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

// Same rules as the store: whole euros from 0 to 100 000 (blank is 0) and a trimmed lot of up to 120 characters.
export const validAmount = (value) => typeof value === 'string' &&
  (value.trim() === '' || (/^\d{1,6}$/.test(value.trim()) && Number(value.trim()) <= MAX_PRIZE_AMOUNT));
export const validLot = (value) => typeof value === 'string' && value.trim().length <= MAX_PRIZE_LOT;

// Committed prizes as form text, and form text back to the prizes the store accepts.
export function prizeFields(prizes) {
  const amount = (value) => (value === 0 ? '' : String(value));
  return { lineAmount: amount(prizes.line.amount), lineLot: prizes.line.lot,
    bingoAmount: amount(prizes.bingo.amount), bingoLot: prizes.bingo.lot };
}
export function toPrizes(fields) {
  const amount = (value) => (value.trim() === '' ? 0 : Number(value.trim()));
  return { line: { amount: amount(fields.lineAmount), lot: fields.lineLot.trim() },
    bingo: { amount: amount(fields.bingoAmount), lot: fields.bingoLot.trim() } };
}

// What the simulator shows for the draft prizes: each prize falls back to its committed value while invalid.
export function previewPrizes(draft, committed) {
  if (draft === null || committed === null || draft.lineAmount === null) return null;
  const pick = (kind) => (validAmount(draft[`${kind}Amount`]) && validLot(draft[`${kind}Lot`]) ? draft : committed);
  const line = pick('line'), bingo = pick('bingo');
  return toPrizes({ lineAmount: line.lineAmount, lineLot: line.lineLot, bingoAmount: bingo.bingoAmount, bingoLot: bingo.bingoLot });
}

export function validateDraft(draft) {
  const errors = {};
  if (!validText(draft.name)) errors.name = 'Escribe un nombre de 1 a 120 caracteres.';
  if (!validDate(draft.date)) errors.date = 'Elige una fecha válida.';
  if (!validText(draft.place)) errors.place = 'Escribe un lugar de 1 a 120 caracteres.';
  // null means the committed theme could not be read; metadata stays saveable while the theme is untouched.
  if (draft.theme !== null && !validTheme(draft.theme)) errors.theme = 'Elige un tema.';
  // null (or absent) prizes could not be read; the rest stays saveable while they are untouched.
  for (const kind of ['line', 'bingo']) {
    const amount = draft[`${kind}Amount`], lot = draft[`${kind}Lot`];
    if (amount != null && !validAmount(amount)) errors[`${kind}Amount`] = 'Escribe un importe en euros enteros, de 0 a 100 000.';
    if (lot != null && !validLot(lot)) errors[`${kind}Lot`] = 'Escribe un lote de hasta 120 caracteres.';
  }
  return errors;
}

export const SAVE_ERRORS = Object.freeze({
  meta: 'No se guardaron los datos del evento. Los cambios siguen en el borrador; inténtalo de nuevo.',
  theme: 'No se guardó el tema. Los cambios siguen en el borrador; inténtalo de nuevo.',
  themeAfterMeta: 'Los datos del evento se guardaron, pero el tema no. El tema sigue en el borrador; inténtalo de nuevo.',
  prizes: 'No se guardaron los premios. Los cambios siguen en el borrador; inténtalo de nuevo.',
  prizesAfterOther: 'Los demás cambios se guardaron, pero los premios no. Los premios siguen en el borrador; inténtalo de nuevo.',
});

// saveMeta(id, meta), saveTheme(theme), and savePrizes(id, prizes) resolve true only after an acknowledged commit.
export function createConfigurationController({ saveMeta, saveTheme, savePrizes }, view) {
  let committed = null;
  // The theme read may settle before the event list, so it is kept apart until both are known.
  let committedTheme = null;
  // Likewise the prizes, kept per event so a reply that races a selection never lands on another event.
  const committedPrizes = new Map();
  const prizesFor = (id) => committedPrizes.get(id) ?? UNKNOWN_PRIZES;
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
    // Whether any earlier part committed, so a later failure says which changes are still drafted.
    let saved = false;
    let stage = 'meta';
    try {
      if (changed(META_FIELDS)) {
        const meta = { name: draft.name.trim(), date: draft.date, place: draft.place.trim() };
        if (!await saveMeta(id, meta)) {
          error = SAVE_ERRORS.meta;
          return false;
        }
        metaSaved = true;
        saved = true;
        // The acknowledgement is the committed baseline even if the refreshed list was unreadable.
        if (committed?.id === id) {
          committed = { ...committed, ...meta };
          Object.assign(draft, meta);
        }
      }
      if (committed?.id === id && changed(['theme'])) {
        stage = 'theme';
        const theme = draft.theme;
        if (!await saveTheme(theme)) {
          error = metaSaved ? SAVE_ERRORS.themeAfterMeta : SAVE_ERRORS.theme;
          return false;
        }
        committedTheme = theme;
        saved = true;
        if (committed?.id === id) committed = { ...committed, theme };
      }
      if (committed?.id === id && changed(PRIZE_FIELDS)) {
        stage = 'prizes';
        const prizes = toPrizes(draft);
        if (!await savePrizes(id, prizes)) {
          error = saved ? SAVE_ERRORS.prizesAfterOther : SAVE_ERRORS.prizes;
          return false;
        }
        const fields = prizeFields(prizes);
        committedPrizes.set(id, fields);
        if (committed?.id === id) {
          committed = { ...committed, ...fields };
          Object.assign(draft, fields);
        }
      }
      return committed?.id === id && !dirty();
    } catch {
      error = stage === 'meta' ? SAVE_ERRORS.meta
        : stage === 'theme' ? (metaSaved ? SAVE_ERRORS.themeAfterMeta : SAVE_ERRORS.theme)
          : saved ? SAVE_ERRORS.prizesAfterOther : SAVE_ERRORS.prizes;
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
      follow({ id: event.id, name: event.name, date: event.date, place: event.place, theme: committedTheme,
        ...prizesFor(event.id) });
    },
    // Acknowledged prizes of eventId; they apply once that event is the committed one.
    setCommittedPrizes(eventId, prizes) {
      if (typeof eventId !== 'string' || !validPrizes(prizes)) return;
      committedPrizes.set(eventId, prizeFields(prizes));
      if (committed?.id === eventId) follow({ ...committed, ...committedPrizes.get(eventId) });
    },
    // Prizes that could not be read again are unknown: locked, unedited, and skipped by save until re-read.
    invalidatePrizes(eventId) {
      committedPrizes.delete(eventId);
      if (committed?.id !== eventId) return;
      committed = { ...committed, ...UNKNOWN_PRIZES };
      for (const field of PRIZE_FIELDS) draft[field] = null;
      render();
    },
    activeEventId: () => committed?.id ?? null,
    setCommittedTheme(theme) {
      if (!validTheme(theme) || theme === committedTheme) return;
      committedTheme = theme;
      if (committed !== null) follow({ ...committed, theme });
    },
    edit(field, value) {
      if (committed === null || pending || !FIELDS.includes(field) || typeof value !== 'string') return;
      // Prizes that could not be read stay locked, so a blank form never overwrites unknown values.
      if (PRIZE_FIELDS.includes(field) && committed[field] === null) return;
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
