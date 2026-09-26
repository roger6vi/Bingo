const invalidUpdate = 'Invalid public event update.';
const unavailable = 'The current event is unavailable.';
const readFailure = 'Could not read the current event.';

function validHistory(history) {
  return Array.isArray(history) && history.length <= 90 &&
    history.every((number) => typeof number === 'number' &&
      Number.isInteger(number) && number >= 1 && number <= 90) &&
    new Set(history).size === history.length;
}

export function createPublicController(api, view) {
  let calledNumbers = [];
  let loaded = false;
  let stale = false;
  let error = null;

  function render() {
    view.render({ loaded, calledNumbers: [...calledNumbers],
      latest: calledNumbers.at(-1) ?? null, count: calledNumbers.length,
      remaining: 90 - calledNumbers.length, stale, error });
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
    if (result.ok !== true || result.snapshot === null ||
        typeof result.snapshot !== 'object' || Array.isArray(result.snapshot) ||
        !validHistory(result.snapshot.calledNumbers)) {
      reject(invalidUpdate);
      return;
    }
    const next = result.snapshot.calledNumbers;
    if (loaded && (next.length < calledNumbers.length ||
        calledNumbers.some((number, index) => next[index] !== number))) {
      reject(invalidUpdate);
      return;
    }
    calledNumbers = [...next];
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
