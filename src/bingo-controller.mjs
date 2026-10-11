// Bingo operator controller: validated read, active-event context and lifecycle (F1), explicit begin/cancel (F2a)
// and explicit confirm with an optional committed fact-refresh hook (F2b), and held-award presentation pushes (F3a).
// Modes: unknown (not read for this event), idle, setup (a main-owned session is open), uncertain (an answer was
// lost, refused or invalid, or the bridge is unavailable: only an explicit read may continue) and declared.
// F3b stages pushes during a dispatched confirm and a read owning a setup; begin and cancel ignore them.
// Deliberately incomplete: there are no retry, repeat or legacy actions yet and nothing is connected to the operator
// UI. Nothing here reads, writes or plays by itself; the only writes are the explicit begin, cancel and confirm,
// sharing the read's flight.
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

// The store's lifecycle of one presentation id (src/line-award.ts): pending starts or fails, a started run completes or
// is interrupted. Retry and replay continue under a new id, so failed, completed and interrupted end an id.
const LATER = { pending: ['started', 'failed', 'completed', 'interrupted'], started: ['completed', 'interrupted'] };
const reaches = (from, to) => (LATER[from] ?? []).includes(to);
const sameFacts = (a, b) => a.eventId === b.eventId &&
  ['winnerCount', 'totalCents', 'shareCents', 'remainderCents', 'lot', 'lotResolution'].every((k) => a.award[k] === b.award[k]);
// Two observations of the same id: the most advanced one, or null when they cannot both be true. The money, count
// and lot never change; a run keeps its start and deadline; an older observation adds nothing.
function merge(known, next) {
  const a = known.presentation;
  const b = next.presentation;
  if (!sameFacts(known, next) || (a.startedAt !== null && b.startedAt !== null &&
      (a.startedAt !== b.startedAt || a.deadlineAt !== b.deadlineAt))) return null;
  if (a.status === b.status || reaches(b.status, a.status)) return known;
  return reaches(a.status, b.status) ? next : null;
}

// `committed` only refreshes the page's facts after a valid explicit confirm; it never plays or writes anything.
export function createBingoController(api, view, { committed = () => {} } = {}) {
  let mode = 'unknown';
  let pending = false;
  let error = null;
  let session = null;
  let award = null;
  // The trusted committed award of this event, kept while the view is uncertain, and ids an explicit read replaced.
  // Ids carry no order: only a local observation and an explicit read ever change which one is current.
  let anchor = null;
  const retired = new Set();
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

  // Fails closed: no award is shown, though a trusted one stays known. A valid setup is kept as uncertain, unless stale.
  function uncertain(message, keepSession = true) {
    mode = 'uncertain';
    error = message;
    award = null;
    if (!keepSession) session = null;
  }

  // A private award/null update. Ignored without a live event, for another identifiable event or a retired id, during
  // begin or cancel, and before a confirm is dispatched. A read or a dispatched confirm only stages it for its
  // answer; it never renders, releases, settles, consumes a session or proves a confirm. Otherwise only a held award moves: the same id to a later legal
  // status. Anything else held is ambiguous or corrupt and turns uncertain, keeping the award known; never a read.
  const onPush = (value) => {
    if (disposed || unavailable || context === null) return;
    if (isObject(value) && validId(value.eventId) && value.eventId !== context) return;
    const next = validBingoAward(value, context) ? copyAward(value) : null;
    if (next !== null && retired.has(next.presentation.id)) return;
    if (flight !== null) {
      const stage = flight.stage;
      if (stage === null || stage === 'dispatch') return;
      const known = stage.award ?? (anchor?.presentation.id === next?.presentation.id ? anchor : null);
      const merged = next === null ? null : known === null ? next :
        known.presentation.id === next.presentation.id ? merge(known, next) : null;
      if (merged === null) stage.conflict = true;
      else stage.award = merged;
      return;
    }
    if (anchor === null) return;
    const merged = next !== null && next.presentation.id === anchor.presentation.id ? merge(anchor, next) : null;
    if (merged === anchor) return;
    if (merged === null) uncertain(invalidUpdate);
    else {
      anchor = merged;
      if (mode === 'declared') award = anchor;
    }
    render();
  };
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

  // A read answer, with what was observed while it was in flight. A declared answer is shown only when it agrees with
  // every observation and the held award; a different id replaces the held one and retires it. Otherwise a known or
  // observed award stays known and uncertain: none, a setup, a refusal or a lost answer never unlock it.
  function settleRead(stage, result) {
    const seen = stage?.award ?? null;
    const failClosed = (message) => {
      keepSeen(stage);
      uncertain(message);
    };
    if (stage?.conflict) return failClosed(invalidUpdate);
    if (result?.ok === true && result.state === 'declared' && validBingoAward(result.award, context)) {
      const id = result.award.presentation.id;
      const held = anchor?.presentation.id === id ? anchor : null;
      let next = copyAward(result.award);
      for (const known of [seen, held]) {
        if (next !== null && known !== null) next = known.presentation.id === id ? merge(known, next) : null;
      }
      if (next === null || retired.has(id)) return failClosed(invalidUpdate);
      if (anchor !== null && held === null) retired.add(anchor.presentation.id);
      anchor = next; award = next; mode = 'declared'; session = null; error = null;
      return undefined;
    }
    if (seen !== null && anchor !== null && seen.presentation.id !== anchor.presentation.id) {
      return failClosed(invalidUpdate);
    }
    if (anchor === null && seen === null) return apply(result);
    return failClosed(result === null ? connectionError : result?.ok === false ? refusal(result) : invalidUpdate);
  }

  // An observation of the held id (or the only award seen) stays known at its strongest legal status, so later
  // answers merge against it; anything incompatible leaves the held award as it was. It never shows or commits.
  function keepSeen(stage) {
    const seen = stage?.award ?? null;
    if (seen !== null && (anchor === null || seen.presentation.id === anchor.presentation.id)) {
      anchor = merge(anchor ?? seen, seen) ?? anchor;
    }
  }

  // Only none, a setup and a declared award bound to the current event are recognized; anything else fails closed.
  function apply(result) {
    if (result?.ok === true && result.state === 'none') {
      mode = 'idle'; session = null; award = null; error = null;
    } else if (result?.ok === true && result.state === 'setup' && validSetup(result.session, context)) {
      mode = 'setup'; session = copySession(result.session); award = null; error = null;
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
      // A confirm stages only what arrives once it is really sent, never during the render before.
      if (own.stage === 'dispatch') own.stage = { award: null, conflict: false };
      let result;
      try { result = await send(); } catch { result = null; }
      if (flight === own) settle(result, own.stage);
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
  // `stage` collects pushes for a read, or 'dispatch' for a confirm; begin and cancel have none.
  function fly(ready, send, settle, stage = null) {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const own = { promise, stage };
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
    const stage = { award: null, conflict: false };
    return fly(() => true, () => api.readBingoSetup(), (result) => settleRead(stage, result), stage);
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
      () => api.confirmBingo(sessionId, winnerCount), (result, stage) => {
        if (exactlyDeclared(result, eventId, winnerCount)) {
          // Only the exact answer commits and owes one refresh. A compatible push of its id may advance it; any
          // conflicting observation keeps the owned award held but shown as uncertain.
          const owned = copyAward(result.award);
          const seen = stage.award;
          const best = seen === null ? owned : seen.presentation.id === owned.presentation.id ? merge(owned, seen) : null;
          anchor = best ?? owned; session = null; refreshDue = generation;
          if (best === null || stage.conflict) uncertain(invalidUpdate);
          else { mode = 'declared'; award = anchor; error = null; }
        } else if (knownRefusal(result) && result.code !== 'storage_failure') error = result.message;
        else {
          // Lost, stale or invalid: nothing commits or is owed, but an observed award stays known (never shown).
          keepSeen(stage);
          if (result?.ok === false && result.code === 'stale_session') uncertain(refusal(result), false);
          else uncertain(result?.ok === false ? refusal(result) : result === null ? connectionError : invalidUpdate);
        }
      }, 'dispatch');
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
      anchor = null;
      retired.clear();
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
