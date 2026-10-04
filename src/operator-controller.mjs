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
const presentationUnknown = 'Could not confirm the line celebration. Check the line and try again.';
const invalidCount = 'Enter a whole number of winners, 1 or more.';
const LINE_SIGNAL_MS = 4000;

const safeCount = (value, low) => Number.isSafeInteger(value) && value >= low;
const validSession = (value) => value !== null && typeof value === 'object' && typeof value.sessionId === 'string' &&
  typeof value.eventId === 'string' && Array.isArray(value.calledNumbers) && value.linePrize !== null &&
  typeof value.linePrize === 'object' && safeCount(value.linePrize.amount, 0) && typeof value.linePrize.lot === 'string';
// How far a presentation has progressed; the same id can only move forward, never back.
const STATUS_RANK = { pending: 0, started: 1, failed: 2, completed: 2, interrupted: 2 };
const MAX_TOTAL_CENTS = 10_000_000;
const MAX_LOT_LENGTH = 120;
const validPresentation = (value) => {
  if (value === null || typeof value !== 'object' || typeof value.id !== 'string' || value.id.trim() === '' ||
    !Object.hasOwn(STATUS_RANK, value.status)) return false;
  if (value.status === 'pending' || value.status === 'failed') return value.startedAt === null && value.deadlineAt === null;
  return safeCount(value.startedAt, 0) && safeCount(value.deadlineAt, 0) && value.deadlineAt - value.startedAt === LINE_SIGNAL_MS;
};
// Mirrors the store's re-derivation of a stored award (src/line-award.ts, src/event-store.ts): whole-euro total up to the
// maximum prize, a trimmed lot, the exact equal share and remainder, and a lot resolution consistent with lot and count.
// A tied lot (lot present, two or more winners) may be pending or resolved; anything else needs no resolution.
const validAwardParts = (award) => {
  if (award === null || typeof award !== 'object' || !safeCount(award.winnerCount, 1) || !safeCount(award.totalCents, 0) ||
    award.totalCents > MAX_TOTAL_CENTS || award.totalCents % 100 !== 0 || typeof award.lot !== 'string' ||
    award.lot !== award.lot.trim() || award.lot.length > MAX_LOT_LENGTH) return false;
  if (award.shareCents !== Math.floor(award.totalCents / award.winnerCount) ||
    award.remainderCents !== award.totalCents % award.winnerCount) return false;
  const tied = award.lot !== '' && award.winnerCount >= 2;
  return tied ? award.lotResolution === 'pending' || award.lotResolution === 'resolved' : award.lotResolution === 'not_required';
};
// A missing presentation is the legacy shape (shown, never actionable); a present one must be fully valid.
const validLineAward = (value) => value !== null && typeof value === 'object' && typeof value.eventId === 'string' &&
  validAwardParts(value.award) && (value.presentation === undefined || validPresentation(value.presentation));

// Only a positive safe integer typed in full digits is a winner count.
function parseCount(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return safeCount(count, 1) ? count : null;
}

const STALE = Symbol('stale');

// Drives the main-owned first-line setup and its public celebration. Modes: unknown (not read yet), idle, setup
// (a session is open), uncertain (an answer was lost or refused: only a read may continue) and declared (an award
// is committed). Nothing here retries, replays or confirms by itself, and a read never confirms or cancels.
// `generation` changes with the active event, so an answer to a question asked under another event is dropped.
export function createLineController(api, view, { committed = () => {} } = {}) {
  let mode = 'unknown';
  let session = null;
  let award = null;
  let error = null;
  let countError = null;
  let dialogOpen = false;
  let pending = false;
  let needRefresh = false;
  let refreshing = false;
  let refreshState = 'none';
  let inFlight = Promise.resolve();
  let context = null;
  let contextSet = false;
  let named = false;
  let version = 0;
  let confirming = false;
  let lastEvent = null;
  let generation = 0;
  let action = null;
  let disposed = false;
  const retired = new Set();

  const mismatch = () => award !== null && context !== null && award.eventId !== context;
  const drawBlocked = () => {
    if (mode === 'idle') return false;
    if (mode !== 'declared' || mismatch()) return true;
    return award.presentation?.status !== 'completed' || refreshState !== 'none';
  };
  // Pending/started: the public screen is busy, so conflicting live actions wait. Failed and interrupted are idle.
  const liveBlocked = () => pending || mode === 'setup' ||
    (mode === 'declared' && (award.presentation?.status === 'pending' || award.presentation?.status === 'started'));

  function render() {
    view.render({ mode, pending, error, countError, dialogOpen, refresh: refreshState,
      drawBlocked: drawBlocked(), liveBlocked: liveBlocked(),
      session: session === null ? null : structuredClone(session), award: award === null ? null : structuredClone(award) });
  }

  // The event refresh after a completion is queued behind a running line operation and never overlaps itself.
  function flushRefresh() {
    if (!needRefresh || pending || refreshing || disposed) return;
    needRefresh = false;
    refreshing = true;
    const asked = generation;
    const required = refreshState === 'pending';
    Promise.resolve().then(() => committed()).then((result) => result !== false, () => false).then((ok) => {
      refreshing = false;
      if (asked === generation) {
        if (required) refreshState = ok ? 'none' : 'failed';
        render();
      }
      flushRefresh();
    });
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
        flushRefresh();
      }
    })();
    return inFlight;
  }

  const ask = async (operation) => {
    const asked = generation;
    let result;
    try { result = await operation(); } catch { result = null; }
    return asked === generation ? result : STALE;
  };
  const refusal = (result) => (result?.ok === false && typeof result.message === 'string' ? result.message : lineInvalidUpdate);

  // Fails closed: nothing held about the award can unlock drawing until an explicit read.
  function uncertain(message) {
    mode = 'uncertain';
    dialogOpen = false;
    error = message;
    award = null;
  }

  // Takes a validated award from a read, an action result or a push. Returns 'adopted', 'ignored' or 'invalid'.
  function adoptAward(value, source) {
    // A known event never accepts another event's award as authority, whatever the source.
    if (context !== null && value.eventId !== context) return 'invalid';
    const before = award?.eventId === value.eventId ? award.presentation : undefined;
    const next = value.presentation;
    if (before !== undefined && next === undefined) return 'ignored';
    if (before !== undefined && before.id === next?.id) {
      const [now, old] = [STATUS_RANK[next.status], STATUS_RANK[before.status]];
      if (now < old) return 'ignored';
      if (now === old && next.status !== before.status) return 'invalid';
    } else if (next !== undefined) {
      if (retired.has(next.id)) return 'ignored';
      if (before !== undefined) retired.add(before.id);
    }
    const completion = next?.status === 'completed' && !(before?.id === next.id && before.status === 'completed') &&
      (context === null || value.eventId === context);
    award = structuredClone(value);
    lastEvent = value.eventId;
    session = null;
    mode = 'declared';
    dialogOpen = false;
    if (completion) { refreshState = 'pending'; needRefresh = true; }
    return 'adopted';
  }

  function onPush(value) {
    if (disposed) return;
    if (!validLineAward(value)) { version += 1; uncertain(lineInvalidUpdate); render(); return; }
    const known = context ?? award?.eventId ?? session?.eventId ?? lastEvent;
    if (known === null || value.eventId !== known) return;
    // Outside an operation only a held award is updated; an explicit check is needed to leave uncertainty.
    if (!pending && mode !== 'declared') return;
    // An open setup keeps its real session; only a confirm in flight owns the commit that replaces it.
    if (mode === 'setup' && !confirming) return;
    if (award !== null && value.presentation?.id !== award.presentation?.id && !(action !== null && action.eventId === value.eventId)) return;
    const result = adoptAward(value, 'push');
    if (result === 'invalid') uncertain(lineInvalidUpdate);
    if (result !== 'ignored') { version += 1; render(); flushRefresh(); }
  }

  // Subscribed before any read, so no transition between the read and the subscription is missed.
  let unsubscribe = null;
  try { unsubscribe = api.onLinePresentation?.(onPush) ?? null; } catch { unsubscribe = null; }

  function adopt(value, openDialog) {
    if (context !== null && value.eventId !== context) return uncertain(lineInvalidUpdate);
    session = structuredClone(value);
    lastEvent = value.eventId;
    mode = 'setup';
    countError = null;
    dialogOpen = openDialog;
  }

  function declared(value, announce) {
    const result = adoptAward(value, 'read');
    if (result === 'invalid') return uncertain(lineInvalidUpdate);
    if (result === 'adopted' && announce) needRefresh = true;
    return undefined;
  }

  // Recovery: reports what main holds. An open session is adopted but never confirmed or cancelled.
  async function readState(openDialog, announce) {
    const sent = version;
    const named = context;
    const result = await ask(() => api.readLineSetup());
    // A push accepted while this read was in flight is newer than the whole answer, so none of it applies; only a
    // new explicit check can establish fresh authority.
    if (result === STALE || sent !== version) return undefined;
    // The first event may be named while the initial read is in flight: only that event's own state is adopted.
    const owner = result?.state === 'declared' ? result.award?.eventId : result?.session?.eventId;
    // An answer asked before the event was named is dropped; one asked under it fails closed in adopt/adoptAward.
    if (result?.ok === true && named !== context && owner !== undefined && owner !== context) return undefined;
    if (result === null) return uncertain(lineConnectionError);
    if (result.ok === true && result.state === 'none') { session = null; award = null; mode = 'idle'; return undefined; }
    if (result.ok === true && result.state === 'setup' && validSession(result.session)) return adopt(result.session, openDialog);
    if (result.ok === true && result.state === 'declared' && validLineAward(result.award)) return declared(result.award, announce);
    return uncertain(refusal(result));
  }

  const start = () => guarded(() => readState(false, false));

  const open = () => guarded(async () => {
    if (mode === 'setup') { countError = null; dialogOpen = true; return undefined; }
    if (mode !== 'idle') return readState(true, true);
    const sent = version;
    const named = context;
    const result = await ask(() => api.beginLineSetup());
    if (result === STALE || sent !== version) return undefined;
    if (result?.ok === true && named !== context && result.session?.eventId !== context) return undefined;
    if (result?.ok === true && validSession(result.session)) return adopt(result.session, true);
    if (result?.ok === false && result.code === 'setup_active') return readState(true, true);
    if (result === null) { error = lineConnectionError; return undefined; }
    error = refusal(result);
    return undefined;
  });

  const cancel = () => {
    dialogOpen = false;
    return guarded(cancelSetup);
  };
  async function cancelSetup() {
    if (mode !== 'setup' || session === null) return;
    const sent = version;
    const result = await ask(() => api.cancelLineSetup(session.sessionId, session.eventId));
    if (result === STALE || sent !== version) return;
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
      confirming = true;
      const sentEvent = session.eventId;
      const result = await ask(() => api.confirmLine(session.sessionId, session.eventId, count)).finally(() => { confirming = false; });
      if (result === STALE) return;
      if (result?.ok === true && validLineAward(result.award) && result.award.eventId !== sentEvent) {
        uncertain(lineInvalidUpdate);
        return;
      }
      if (result?.ok === true && validLineAward(result.award)) {
        // A push may already have adopted the same award; the commit itself still refreshes the event.
        if (declared(result.award, true) === undefined && mode === 'declared') needRefresh = true;
        return;
      }
      // An uncertain acknowledgement is never confirmed again: the operator must read the state first.
      uncertain(result === null ? lineConnectionError : result.ok === true ? lineInvalidUpdate : refusal(result));
    });
  }

  // Manual presentation steps. Only the exact id of the current award in the exact source status is sent, once.
  function present(kind, id) {
    const step = kind === 'retry' ? 'failed' : 'interrupted';
    const current = award?.presentation;
    if (pending || mode !== 'declared' || mismatch() || current === undefined || current.id !== id || current.status !== step) return inFlight;
    const eventId = award.eventId;
    return guarded(async () => {
      action = { eventId };
      try {
        const result = await ask(() => (kind === 'retry' ? api.retryLinePresentation(id) : api.repeatLinePresentation(id)));
        if (result === STALE) return;
        if (result?.ok === true && validLineAward(result.award) && result.award.eventId === eventId &&
          result.award.presentation !== undefined) {
          if (adoptAward(result.award, 'action') === 'invalid') uncertain(lineInvalidUpdate);
          return;
        }
        uncertain(result === null ? presentationUnknown : result?.ok === false ? refusal(result) : lineInvalidUpdate);
      } finally { action = null; }
    });
  }

  // The page's active event. Leaving an event drops everything held and invalidates answers still in flight.
  // Until an event has ever been named, the context only fills in: a read begun before it is still the initial one.
  // Every later change, including one through a null context, invalidates what was asked under the previous context.
  function setEvent(id) {
    if (contextSet && id === context) return;
    const initial = !named;
    contextSet = true;
    if (id !== null) named = true;
    context = id;
    if (initial) {
      // Naming the first event validates what the initial recovery held: another event's state fails closed.
      const held = award?.eventId ?? session?.eventId;
      if (id !== null && held !== undefined && held !== id) { session = null; uncertain(lineInvalidUpdate); }
      render();
      return;
    }
    generation += 1;
    mode = 'unknown';
    session = null;
    award = null;
    error = null;
    countError = null;
    dialogOpen = false;
    refreshState = 'none';
    needRefresh = false;
    lastEvent = null;
    retired.clear();
    render();
  }

  // Recovery after a failed required refresh: reads the event again; drawing stays blocked until it succeeds.
  function retryRefresh() {
    if (refreshState !== 'failed') return Promise.resolve();
    refreshState = 'pending';
    needRefresh = true;
    render();
    flushRefresh();
    return Promise.resolve();
  }

  function dispose() {
    disposed = true;
    const release = unsubscribe;
    unsubscribe = null;
    if (typeof release === 'function') release();
  }

  render();
  return { start, open, cancel, confirm, setEvent, retryRefresh, dispose,
    retry: (id) => present('retry', id), repeat: (id) => present('repeat', id) };
}
