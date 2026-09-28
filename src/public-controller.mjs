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
    if (result.ok !== true || !validSnapshot(result.snapshot, loaded
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
