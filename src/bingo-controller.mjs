// Bingo operator controller, first slice (F1): validated read, active-event context and lifecycle only.
// Modes: unknown (not read for this event), idle, setup (a main-owned session is open), uncertain (an answer was
// lost, refused or invalid, or the bridge is unavailable: only an explicit read may continue) and declared.
// Deliberately incomplete and inert: there are no begin, cancel, confirm, retry, repeat or legacy actions yet,
// presentation pushes are subscribed but ignored, and nothing is connected to the operator UI. Nothing here reads,
// writes or plays by itself; it is not race-complete for actions or pushes, which later slices must add.
import { validLineAward } from './operator-controller.mjs';

const MAX_ID = 64;
const MAX_PRIZE = 100_000;
const MAX_LOT = 120;
const connectionError = 'Could not reach the Bingo state. Check it again.';
const invalidUpdate = 'Invalid Bingo update. Check the state again.';
const unavailableError = 'Bingo is unavailable in this window. Reload the operator.';
const noEventError = 'No active event. Choose an event before checking Bingo.';

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

// Copies keep only validated fields, so nothing the bridge, the view or a caller holds aliases the owner's state.
const copySession = (s) => ({ sessionId: s.sessionId, eventId: s.eventId, calledNumbers: [...s.calledNumbers],
  bingoPrize: { amount: s.bingoPrize.amount, lot: s.bingoPrize.lot } });
const copyAward = ({ eventId, award: a, presentation: p }) => ({ eventId,
  award: { winnerCount: a.winnerCount, totalCents: a.totalCents, shareCents: a.shareCents,
    remainderCents: a.remainderCents, lot: a.lot, lotResolution: a.lotResolution },
  presentation: { id: p.id, status: p.status, startedAt: p.startedAt, deadlineAt: p.deadlineAt } });

export function createBingoController(api, view) {
  let mode = 'unknown';
  let pending = false;
  let error = null;
  let session = null;
  let award = null;
  let context = null;
  let phase = null;
  // The one read in flight. Only its owner may apply an answer or release it; a new event or disposal orphans it.
  let flight = null;
  let disposed = false;
  let unavailable = false;

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

  async function read(own) {
    try {
      render();
      if (disposed || flight !== own) return;
      let result;
      try { result = await api.readBingoSetup(); } catch { result = null; }
      if (flight === own) apply(result);
    } finally {
      if (flight === own) {
        flight = null;
        pending = false;
        render();
      }
    }
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
    // Establish the shared settlement before any view or API callback, so reentrant starts join this read.
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const own = { promise };
    flight = own;
    pending = true;
    error = null;
    read(own).then(resolve, reject);
    return promise;
  }

  // The page's active event and its fresh phase. A different event drops everything held and orphans the read in
  // flight; the same event only updates the phase and keeps the session and the read. Never reads by itself.
  function setEvent(eventId, nextPhase = null) {
    if (disposed) return;
    const id = validId(eventId) ? eventId : null;
    phase = typeof nextPhase === 'string' ? nextPhase : null;
    if (id !== context) {
      context = id;
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
  return { start, setEvent, dispose, getState: snapshot };
}
