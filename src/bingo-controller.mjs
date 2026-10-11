// Bingo operator controller: validated read, active-event context and lifecycle (F1), explicit begin/cancel (F2a)
// and explicit confirm with an optional committed fact-refresh hook (F2b).
// Modes: unknown (not read for this event), idle, setup (a main-owned session is open), uncertain (an answer was
// lost, refused or invalid, or the bridge is unavailable: only an explicit read may continue) and declared.
// Deliberately incomplete: there are no retry, repeat or legacy actions yet, presentation pushes are subscribed
// but ignored, and nothing is connected to the operator UI. Nothing here reads, writes or plays by itself; the only
// writes are the explicit begin, cancel and confirm, sharing the read's single flight.
import { validLineAward } from './operator-controller.mjs';

const MAX_ID = 64;
const MAX_PRIZE = 100_000;
const MAX_LOT = 120;
const connectionError = 'Could not reach the Bingo state. Check it again.';
const invalidUpdate = 'Invalid Bingo update. Check the state again.';
const unavailableError = 'Bingo is unavailable in this window. Reload the operator.';
const noEventError = 'No active event. Choose an event before checking Bingo.';
const countError = 'Choose how many players share the Bingo (a whole number of at least 1).';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID;
// Called numbers keep their order and may be empty. Spreading turns holes into undefined, which fail.
const validCalled = (list) => Array.isArray(list) && [...list].every((n) => Number.isInteger(n) && n >= 1 && n <= 90) &&
  new Set(list).size === list.length;
const validPrize = (prize) => isObject(prize) && Number.isSafeInteger(prize.amount) && prize.amount >= 0 &&
  prize.amount <= MAX_PRIZE && typeof prize.lot === 'string' && prize.lot === prize.lot.trim() && prize.lot.length <= MAX_LOT;
const validSetup = (value, eventId) => isObject(value) && validId(value.sessionId) && validId(value.eventId) &&
  value.eventId === eventId && validCalled(value.calledNumbers) && validPrize(value.bingoPrize);
// The line award rules (share, remainder, lot, status and 4 s presentation timing) plus what a Bingo award always has:
// the bound current event and a presentation. The line's legacy award without a presentation is never accepted here.
const validBingoAward = (value, eventId) => isObject(value) && isObject(value.presentation) &&
  typeof value.presentation.status === 'string' && validLineAward(value) && validId(value.eventId) &&
  value.eventId === eventId && validId(value.presentation.id);
const refusal = (result) => (typeof result.message === 'string' && result.message.trim() !== '' ? result.message : invalidUpdate);
// Typed refusals main returns before changing anything. Any other failure, including stale, is not "nothing happened".
const refusalCodes = new Set(['invalid_request', 'not_available', 'setup_active', 'storage_failure', 'tongo_active',
  'presentation_busy']);
const knownRefusal = (result) => isObject(result) && result.ok === false && refusalCodes.has(result.code) &&
  typeof result.message === 'string' && result.message.trim() !== '';
const exactlyCancelled = (result) => isObject(result) && Object.keys(result).length === 2 && result.ok === true &&
  result.state === 'cancelled';
// Main's confirm answers exactly ok, state and the award it committed for this event and this winner count.
const exactlyDeclared = (result, eventId, count) => isObject(result) && Object.keys(result).length === 3 &&
  result.ok === true && result.state === 'declared' && validBingoAward(result.award, eventId) &&
  result.award.award.winnerCount === count;

// Copies keep only validated fields, so nothing the bridge, the view or a caller holds aliases the owner's state.
const copySession = (s) => ({ sessionId: s.sessionId, eventId: s.eventId, calledNumbers: [...s.calledNumbers],
  bingoPrize: { amount: s.bingoPrize.amount, lot: s.bingoPrize.lot } });
const copyAward = ({ eventId, award: a, presentation: p }) => ({ eventId,
  award: { winnerCount: a.winnerCount, totalCents: a.totalCents, shareCents: a.shareCents,
    remainderCents: a.remainderCents, lot: a.lot, lotResolution: a.lotResolution },
  presentation: { id: p.id, status: p.status, startedAt: p.startedAt, deadlineAt: p.deadlineAt } });

// `committed` only refreshes the page's facts after a valid explicit confirm; it never plays or writes anything.
export function createBingoController(api, view, { committed = () => {} } = {}) {
  let mode = 'unknown';
  let pending = false;
  let error = null;
  let session = null;
  let award = null;
  let context = null;
  let phase = null;
  // The one read or action in flight. Only its owner may apply an answer or release it; a new event or disposal
  // orphans it.
  let flight = null;
  let disposed = false;
  let unavailable = false;
  // Changes with every event switch, so a queued hook from an earlier event never runs, even if it comes back.
  let generation = 0;
  // The generation of a committed fact refresh still owed to the page, or null. Held while any flight is pending.
  let refreshDue = null;

  const snapshot = () => ({ mode, pending, error, eventId: context, phase,
    session: session === null ? null : copySession(session), award: award === null ? null : copyAward(award) });
  function render() {
    if (!disposed) view.render(snapshot());
  }

  // Fails closed: nothing held about an award survives. A valid setup is kept, shown as uncertain, unless stale.
  function uncertain(message, keepSession = true) {
    mode = 'uncertain';
    error = message;
    award = null;
    if (!keepSession) session = null;
  }

  // Inert until the push slice: a presentation update is neither validated nor adopted, and never renders.
  const onPush = () => {};
  // Subscribed before any read. A missing or throwing subscriber, a non-function cleanup or a missing read bridge
  // leaves the controller unavailable for good: no read is ever sent and it can never look idle.
  let unsubscribe = null;
  try {
    const release = api.onBingoPresentation(onPush);
    if (typeof release === 'function') unsubscribe = release;
    else unavailable = true;
  } catch { unavailable = true; }
  if (typeof api?.readBingoSetup !== 'function') unavailable = true;
  if (unavailable) uncertain(unavailableError);

  // Only none, a setup and a declared award bound to the current event are recognized; anything else fails closed.
  function apply(result) {
    if (result?.ok === true && result.state === 'none') {
      mode = 'idle'; session = null; award = null; error = null;
    } else if (result?.ok === true && result.state === 'setup' && validSetup(result.session, context)) {
      mode = 'setup'; session = copySession(result.session); award = null; error = null;
    } else if (result?.ok === true && result.state === 'declared' && validBingoAward(result.award, context)) {
      mode = 'declared'; award = copyAward(result.award); session = null; error = null;
    } else if (result?.ok === false && result.code === 'stale_session') {
      uncertain(refusal(result), false);
    } else {
      uncertain(result === null ? connectionError : result?.ok === false ? refusal(result) : invalidUpdate);
    }
  }

  // One operation of the shared flight: render, recheck that this flight still owns the controller and that `ready`
  // still permits dispatch, then send once. Only the same live owner adopts the answer; phase gates dispatch only.
  async function run(own, ready, send, settle) {
    try {
      render();
      if (disposed || flight !== own || !ready()) return;
      let result;
      try { result = await send(); } catch { result = null; }
      if (flight === own) settle(result);
    } finally {
      if (flight === own) {
        flight = null;
        pending = false;
        render();
        // Every live release offers the owed refresh; a flight started from that render keeps holding it.
        if (refreshDue !== null) queueMicrotask(deliverRefresh);
      }
    }
  }

  // Establish the shared settlement before any view or API callback, so every reentrant or competing start, begin
  // or cancel joins this flight's actual promise and sends nothing of its own.
  function fly(ready, send, settle) {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const own = { promise };
    flight = own;
    pending = true;
    error = null;
    run(own, ready, send, settle).then(resolve, reject);
    return promise;
  }

  // The explicit read. Never retried by itself; a second start while one is in flight joins it.
  function start() {
    if (disposed) return Promise.resolve();
    if (flight !== null) return flight.promise;
    if (unavailable || context === null) {
      uncertain(unavailable ? unavailableError : noEventError);
      render();
      return Promise.resolve();
    }
    return fly(() => true, () => api.readBingoSetup(), apply);
  }

  // Shared entry of the explicit actions: join a flight, or refuse without dispatch when the bridge is missing.
  function action(name, allowed) {
    if (disposed) return null;
    if (flight !== null) return flight.promise;
    if (unavailable || !allowed()) return null;
    if (typeof api[name] === 'function') return undefined;
    error = unavailableError;
    render();
    return null;
  }

  // Only from idle on a known event whose fresh phase is line_declared; a refusal keeps idle, anything else is
  // uncertain until an explicit read. Never re-begins or reads by itself.
  function begin() {
    const eventId = context;
    const allowed = () => mode === 'idle' && context !== null && context === eventId && phase === 'line_declared';
    const joined = action('beginBingoSetup', allowed);
    if (joined !== undefined) return joined ?? Promise.resolve();
    return fly(() => allowed() && typeof api.beginBingoSetup === 'function', () => api.beginBingoSetup(), (result) => {
      if (result?.ok === true && result.state === 'setup' && validSetup(result.session, eventId)) {
        mode = 'setup'; session = copySession(result.session); award = null; error = null;
      } else if (knownRefusal(result)) error = result.message;
      else uncertain(result === null ? connectionError : invalidUpdate);
    });
  }

  // Only the known setup owned by the current event, whatever its phase now, so a setup can always be unwound.
  function cancel() {
    const owned = session;
    const allowed = () => mode === 'setup' && owned !== null && session === owned && owned.eventId === context;
    const joined = action('cancelBingoSetup', allowed);
    if (joined !== undefined) return joined ?? Promise.resolve();
    const { sessionId, eventId } = owned;
    return fly(() => allowed() && typeof api.cancelBingoSetup === 'function',
      () => api.cancelBingoSetup(sessionId, eventId), (result) => {
        if (exactlyCancelled(result)) {
          mode = 'idle'; session = null; award = null; error = null;
        } else if (result?.ok === false && result.code === 'stale_session') uncertain(refusal(result), false);
        else if (knownRefusal(result)) error = result.message;
        else uncertain(result === null ? connectionError : invalidUpdate);
      });
  }

  // Once, for the same event and a live controller, only when no flight is pending: a read started by the settled
  // render keeps it owed until that read is released, without polling. Hook failures are contained: they never
  // revert the committed award or trigger another action.
  function deliverRefresh() {
    if (refreshDue === null) return;
    if (disposed || refreshDue !== generation) {
      refreshDue = null;
      return;
    }
    if (flight !== null) return;
    refreshDue = null;
    try { Promise.resolve(committed()).catch(() => {}); } catch { /* The award stays committed. */ }
  }

  // Only the known setup owned by the current event in a fresh line_declared phase, with an explicit positive safe
  // integer: never coerced or defaulted. Main's storage failure cannot tell "nothing written" from "unknown", so it
  // keeps the setup uncertain like a lost answer; only an explicit read settles it, never a retry or re-declaration.
  function confirm(winnerCount) {
    const owned = session;
    const eventId = context;
    const allowed = () => mode === 'setup' && owned !== null && session === owned && owned.eventId === context &&
      context === eventId && phase === 'line_declared';
    const joined = action('confirmBingo', allowed);
    if (joined !== undefined) return joined ?? Promise.resolve();
    if (!Number.isSafeInteger(winnerCount) || winnerCount < 1) {
      error = countError;
      render();
      return Promise.resolve();
    }
    const { sessionId } = owned;
    return fly(() => allowed() && typeof api.confirmBingo === 'function',
      () => api.confirmBingo(sessionId, winnerCount), (result) => {
        if (exactlyDeclared(result, eventId, winnerCount)) {
          mode = 'declared'; award = copyAward(result.award); session = null; error = null;
          refreshDue = generation;
        } else if (result?.ok === false && result.code === 'stale_session') uncertain(refusal(result), false);
        else if (knownRefusal(result) && result.code !== 'storage_failure') error = result.message;
        else uncertain(result?.ok === false ? refusal(result) : result === null ? connectionError : invalidUpdate);
      });
  }

  // The page's active event and its fresh phase. A different event drops everything held and orphans the read in
  // flight; the same event only updates the phase and keeps the session and the read. Never reads by itself.
  function setEvent(eventId, nextPhase = null) {
    if (disposed) return;
    const id = validId(eventId) ? eventId : null;
    phase = typeof nextPhase === 'string' ? nextPhase : null;
    if (id !== context) {
      context = id;
      generation += 1;
      flight = null;
      pending = false;
      session = null;
      award = null;
      mode = unavailable ? 'uncertain' : 'unknown';
      error = unavailable ? unavailableError : null;
    }
    render();
  }

  // Idempotent. Unsubscribes exactly once, even if that throws; a late answer then changes and renders nothing.
  function dispose() {
    if (disposed) return;
    disposed = true;
    flight = null;
    const release = unsubscribe;
    unsubscribe = null;
    if (release !== null) {
      try { release(); } catch { /* The controller is finished either way. */ }
    }
  }

  render();
  return { start, begin, cancel, confirm, setEvent, dispose, getState: snapshot };
}
