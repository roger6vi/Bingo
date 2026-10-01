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

const lineConnectionError = 'Could not connect to the first-line setup. Check the state and try again.';
const lineInvalidUpdate = 'Invalid first-line update. Check the state and try again.';
const invalidCount = 'Enter a whole number of winners, 1 or more.';

const safeCount = (value, low) => Number.isSafeInteger(value) && value >= low;
const validSession = (value) => value !== null && typeof value === 'object' && typeof value.sessionId === 'string' &&
  typeof value.eventId === 'string' && Array.isArray(value.calledNumbers) && value.linePrize !== null &&
  typeof value.linePrize === 'object' && safeCount(value.linePrize.amount, 0) && typeof value.linePrize.lot === 'string';
const validLineAward = (value) => value !== null && typeof value === 'object' && typeof value.eventId === 'string' &&
  value.award !== null && typeof value.award === 'object' && safeCount(value.award.winnerCount, 1) &&
  safeCount(value.award.totalCents, 0) && safeCount(value.award.shareCents, 0) &&
  safeCount(value.award.remainderCents, 0) && typeof value.award.lot === 'string' &&
  typeof value.award.lotResolution === 'string';

// Only a positive safe integer typed in full digits is a winner count.
function parseCount(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return safeCount(count, 1) ? count : null;
}

// Drives the main-owned first-line setup. Modes: unknown (not read yet), idle, setup (a session is open),
// uncertain (an answer was lost or refused: only a read may continue) and declared (an award is committed).
// Nothing here retries, and a read never confirms or cancels.
export function createLineController(api, view, { committed = () => {} } = {}) {
  let mode = 'unknown';
  let session = null;
  let award = null;
  let error = null;
  let countError = null;
  let dialogOpen = false;
  let pending = false;
  let refresh = false;
  let inFlight = Promise.resolve();

  function render() {
    view.render({ mode, pending, error, countError, dialogOpen,
      session: session === null ? null : structuredClone(session), award: award === null ? null : structuredClone(award) });
  }

  function guarded(work) {
    if (pending) return inFlight;
    pending = true;
    error = null;
    render();
    inFlight = (async () => {
      try { await work(); } finally {
        pending = false;
        render();
        if (refresh) {
          refresh = false;
          try { void Promise.resolve(committed()).catch(() => {}); } catch { /* The event reload reports its own errors. */ }
        }
      }
    })();
    return inFlight;
  }

  const ask = async (operation) => { try { return await operation(); } catch { return null; } };
  const refusal = (result) => (result?.ok === false && typeof result.message === 'string' ? result.message : lineInvalidUpdate);

  function declared(value, announce) {
    award = structuredClone(value);
    session = null;
    mode = 'declared';
    dialogOpen = false;
    refresh = announce;
  }

  function uncertain(message) {
    mode = 'uncertain';
    dialogOpen = false;
    error = message;
  }

  function adopt(value, openDialog) {
    session = structuredClone(value);
    mode = 'setup';
    countError = null;
    dialogOpen = openDialog;
  }

  // Recovery: reports what main holds. An open session is adopted but never confirmed or cancelled.
  async function readState(openDialog, announce) {
    const result = await ask(() => api.readLineSetup());
    if (result === null) return uncertain(lineConnectionError);
    if (result.ok === true && result.state === 'none') { session = null; mode = 'idle'; return undefined; }
    if (result.ok === true && result.state === 'setup' && validSession(result.session)) return adopt(result.session, openDialog);
    if (result.ok === true && result.state === 'declared' && validLineAward(result.award)) return declared(result.award, announce);
    return uncertain(refusal(result));
  }

  const start = () => guarded(() => readState(false, false));

  const open = () => guarded(async () => {
    if (mode === 'setup') { countError = null; dialogOpen = true; return; }
    if (mode !== 'idle') return readState(true, true);
    const result = await ask(() => api.beginLineSetup());
    if (result?.ok === true && validSession(result.session)) return adopt(result.session, true);
    if (result?.ok === false && result.code === 'setup_active') return readState(true, true);
    if (result === null) { error = lineConnectionError; return; }
    error = refusal(result);
  });

  const cancel = () => {
    dialogOpen = false;
    return guarded(cancelSetup);
  };
  async function cancelSetup() {
    if (mode !== 'setup' || session === null) return;
    const result = await ask(() => api.cancelLineSetup(session.sessionId, session.eventId));
    if (result?.ok === true) { session = null; mode = 'idle'; return; }
    uncertain(result === null ? lineConnectionError : refusal(result));
  }

  function confirm(text) {
    if (pending || mode !== 'setup' || session === null) return inFlight;
    const count = parseCount(text);
    if (count === null) {
      countError = invalidCount;
      dialogOpen = true;
      render();
      return inFlight;
    }
    countError = null;
    dialogOpen = false;
    return guarded(async () => {
      const result = await ask(() => api.confirmLine(session.sessionId, session.eventId, count));
      if (result?.ok === true && validLineAward(result.award)) return declared(result.award, true);
      // An uncertain acknowledgement is never confirmed again: the operator must read the state first.
      uncertain(result === null ? lineConnectionError : result.ok === true ? lineInvalidUpdate : refusal(result));
    });
  }

  render();
  return { start, open, cancel, confirm };
}
