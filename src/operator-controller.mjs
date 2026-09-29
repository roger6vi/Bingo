// Only a validated IPC acknowledgement may replace the displayed event history.
import { validSnapshot } from './public-controller.mjs';

const connectionError = 'Could not connect to the event. Reload and try again.';
const invalidUpdate = 'Invalid event update. Reload and try again.';

export function createOperatorController(api, view) {
  let calledNumbers = [];
  let phase = null;
  let lastTransitionAt = null;
  let pending = false;
  let stale = false;
  let error = null;
  let loaded = false;
  // 'read' when the shown snapshot came from reading the event (startup, reload, event switch), 'draw'
  // when it acknowledged this operator's own draw. Only the latter may announce a new milestone.
  let snapshotSource = null;

  function render() {
    const exhausted = calledNumbers.length === 90;
    view.render({ calledNumbers: [...calledNumbers], remaining: 90 - calledNumbers.length,
      phase, stale, error, pending, manualDisabled: pending || !loaded || exhausted,
      digitalDisabled: pending || !loaded || exhausted, reloadDisabled: pending,
      // The last acknowledged snapshot, kept through stale and failed states (the simulator shows it).
      snapshot: loaded ? { calledNumbers: [...calledNumbers], phase, lastTransitionAt } : null,
      snapshotSource: loaded ? snapshotSource : null });
  }

  let inFlight = Promise.resolve();
  function request(operation, source, manual = false) {
    if (pending) return inFlight;
    inFlight = settle(operation, source, manual);
    return inFlight;
  }

  async function settle(operation, source, manual) {
    pending = true;
    render();
    try {
      const result = await operation();
      if (result?.ok === true) {
        if (validSnapshot(result.snapshot, loaded ? { calledNumbers, phase, lastTransitionAt } : null)) {
          calledNumbers = [...result.snapshot.calledNumbers];
          phase = result.snapshot.phase;
          lastTransitionAt = result.snapshot.lastTransitionAt;
          loaded = true;
          snapshotSource = source;
          stale = false;
          error = null;
          if (manual) view.clearManual();
        } else {
          stale = true;
          error = invalidUpdate;
        }
      } else {
        stale = true;
        error = result?.ok === false && typeof result.message === 'string'
          ? result.message : invalidUpdate;
      }
    } catch {
      stale = true;
      error = connectionError;
    } finally {
      pending = false;
      render();
    }
  }

  const reload = () => request(() => api.getCurrentEvent(), 'read');
  const manual = (number) => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawManual(number), 'draw', true);
  };
  const digital = () => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawDigital(), 'draw');
  };
  // After the active event changes, drop the old baseline so the new event's history is accepted.
  let resyncQueued = null;
  const resync = async () => {
    if (pending) {
      resyncQueued ??= inFlight.then(resync);
      return resyncQueued;
    }
    resyncQueued = null;
    calledNumbers = [];
    phase = null;
    lastTransitionAt = null;
    loaded = false;
    await reload();
  };
  view.bind({ manual, digital, reload: () => { void reload(); } });
  render();
  return { start: reload, resync };
}
