import { formatEuros } from './prize-format.mjs';

const invalidUpdate = 'Invalid public event update.';
const unavailable = 'The current event is unavailable.';
const readFailure = 'Could not read the current event.';

function validHistory(history) {
  if (!Array.isArray(history) || history.length > 90) return false;
  for (let index = 0; index < history.length; index++) {
    if (!Object.hasOwn(history, index)) return false;
    const number = history[index];
    if (typeof number !== 'number' || !Number.isInteger(number) ||
        number < 1 || number > 90) return false;
  }
  return new Set(history).size === history.length;
}

const phases = new Set(['drawing', 'checking_line', 'line_declared',
  'checking_bingo', 'bingo_declared', 'finished']);

export function validSnapshot(snapshot, previous = null) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !validHistory(snapshot.calledNumbers) || !phases.has(snapshot.phase)) return false;
  const timestamp = snapshot.lastTransitionAt;
  if (timestamp === null) {
    if (snapshot.phase !== 'drawing') return false;
  } else if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp) return false;
  if (previous === null) return true;
  if (snapshot.calledNumbers.length < previous.calledNumbers.length ||
      previous.calledNumbers.some((number, index) => snapshot.calledNumbers[index] !== number)) return false;
  if (previous.lastTransitionAt !== null &&
      (timestamp === null || timestamp < previous.lastTransitionAt ||
       (timestamp === previous.lastTransitionAt && snapshot.phase !== previous.phase))) return false;
  return true;
}

const lotResolutions = new Set(['not_required', 'pending', 'resolved']);

// Committed first-line award shape and arithmetic, mirroring line-award.ts (renderer cannot import it).
// Static state only: it carries no presentation identity, so receiving it never starts a celebration.
export function validLineAward(award) {
  if (award === null || typeof award !== 'object' || Array.isArray(award)) return false;
  const { eventId, winnerCount, totalCents, shareCents, remainderCents, lot, lotResolution } = award;
  if (typeof eventId !== 'string' || eventId.trim() === '' || !Number.isSafeInteger(winnerCount) || winnerCount < 1 ||
      !Number.isSafeInteger(totalCents) || totalCents < 0 || totalCents > 10_000_000 || totalCents % 100 !== 0 ||
      shareCents !== Math.floor(totalCents / winnerCount) || remainderCents !== totalCents % winnerCount ||
      typeof lot !== 'string' || lot !== lot.trim() || lot.length > 120 || !lotResolutions.has(lotResolution)) return false;
  return (lot !== '' && winnerCount >= 2) === (lotResolution !== 'not_required');
}

const centsText = (cents) => {
  const rest = cents % 100;
  return formatEuros(Math.floor(cents / 100)).replace(' €', rest === 0 ? ' €' : `,${String(rest).padStart(2, '0')} €`);
};

// Plain committed facts only; deliberately silent about whether any celebration was shown.
export function describeLineAward(award) {
  const parts = ['Línea declarada', `${award.winnerCount} ${award.winnerCount === 1 ? 'ganador' : 'ganadores'}`,
    award.winnerCount === 1 ? centsText(award.shareCents) : `${centsText(award.shareCents)} cada uno`];
  if (award.remainderCents > 0) parts.push(`${award.remainderCents} ${award.remainderCents === 1 ? 'céntimo' : 'céntimos'} sin repartir`);
  if (award.lot !== '') parts.push(`Lote: ${award.lot}${award.lotResolution === 'pending' ? ' (pendiente de desempate)' : ''}`);
  return parts.join(' · ');
}

export function createPublicController(api, view) {
  let calledNumbers = [];
  let phase = null;
  let lastTransitionAt = null;
  let loaded = false;
  let stale = false;
  let error = null;

  function render() {
    view.render({ loaded, calledNumbers: [...calledNumbers],
      latest: calledNumbers.at(-1) ?? null, count: calledNumbers.length,
      remaining: 90 - calledNumbers.length, phase, stale, error });
  }

  function reject(message) {
    stale = loaded;
    error = message;
    render();
  }

  function receive(result) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      reject(invalidUpdate);
      return;
    }
    if (result.ok === false &&
        (result.code === 'event_unavailable' || result.code === 'storage_failure') &&
        typeof result.message === 'string') {
      reject(result.code === 'event_unavailable' ? unavailable : readFailure);
      return;
    }
    // eventChanged marks a newly selected active event: its history starts a new baseline.
    if (result.ok !== true || !validSnapshot(result.snapshot, loaded && result.eventChanged !== true
      ? { calledNumbers, phase, lastTransitionAt } : null)) {
      reject(invalidUpdate);
      return;
    }
    const next = result.snapshot.calledNumbers;
    calledNumbers = [...next];
    phase = result.snapshot.phase;
    lastTransitionAt = result.snapshot.lastTransitionAt;
    loaded = true;
    stale = false;
    error = null;
    render();
  }

  render();
  const unsubscribe = api.subscribe(receive);
  let active = true;
  return { cleanup() {
    if (!active) return;
    active = false;
    unsubscribe();
  } };
}
