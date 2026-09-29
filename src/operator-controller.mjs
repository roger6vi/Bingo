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

  // `reread` marks a snapshot accepted from getCurrentEvent rather than from this window's own draw, so
  // cues treat it as a baseline: a milestone another process committed before a reload never plays.
  function render(reread = false) {
    const exhausted = calledNumbers.length === 90;
    view.render({ calledNumbers: [...calledNumbers], remaining: 90 - calledNumbers.length,
      phase, stale, error, pending, manualDisabled: pending || !loaded || exhausted,
      digitalDisabled: pending || !loaded || exhausted, reloadDisabled: pending,
      // The last acknowledged snapshot, kept through stale and failed states (the simulator shows it).
      snapshot: loaded ? { calledNumbers: [...calledNumbers], phase, lastTransitionAt } : null }, { reread });
  }

  let inFlight = Promise.resolve();
  function request(operation, { manual = false, reread = false } = {}) {
    if (pending) return inFlight;
    inFlight = settle(operation, manual, reread);
    return inFlight;
  }

  async function settle(operation, manual, reread) {
    let accepted = false;
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
          accepted = true;
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
      render(reread && accepted);
    }
  }

  const reload = () => request(() => api.getCurrentEvent(), { reread: true });
  const manual = (number) => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawManual(number), { manual: true });
  };
  const digital = () => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawDigital());
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
