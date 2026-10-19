// Private Bingo composition of the operator page (H2). It binds the Bingo controller to the page's active event,
// fresh phase and guards, offers the explicit read the page's existing read paths use, and says what Bingo locks.
// Nothing here reads, writes or plays by itself. H3 binds the explicit declaration and H4a the failed-only retry; repeat
// and legacy stay unbound until H4b–H5.
import { createBingoController } from './bingo-controller.mjs';

const NOT_NOW = 'The Bingo presentation cannot be started now.';
const running = (award) => award !== null && (award.presentation.status === 'pending' || award.presentation.status === 'started');

// Live: a Bingo read or action in flight, a setup main may hold (also while uncertain), a public celebration in
// progress, or the celebration this controller still trusts while it shows nothing. Uncertain therefore keeps
// locking instead of releasing the page mid-celebration. Drawing: anything but an idle, read state of the active
// event with no legacy check or owed refresh, so a declared Bingo never unlocks it, a completed celebration included.
export function bingoLocks(state, eventId) {
  const live = state.pending || state.session !== null || running(state.award) || state.celebrationRunning === true;
  return { live, draw: live || state.mode !== 'idle' || state.eventId !== eventId || state.legacy.status !== 'none' ||
    state.refresh !== 'none' };
}

// The three guards Bingo's manual and legacy actions need from the page; the Line's two stay unknown (null) until
// its state is known.
export function bingoGuards(line, tongoBusy) {
  const known = line.mode === 'idle' || line.mode === 'setup' || line.mode === 'declared';
  const status = line.mode === 'declared' ? line.award?.presentation?.status : undefined;
  return { tongoPlaying: tongoBusy === true, presentationBusy: known ? status === 'pending' || status === 'started' : null,
    otherSetupActive: known ? line.pending === true || line.mode === 'setup' : null };
}

// Every page lock a Bingo begin or confirm must respect at dispatch: the controller has none of its own, so the
// renderer gates them with this (H3).
export const pageBlocked = (page) => Boolean(page.selecting || page.activating || page.eventsPending || page.eventsStale ||
  page.tongoBusy || page.lineBlocked);

const isObject = (value) => value !== null && typeof value === 'object';
// The page's projection is clear for a Bingo write: no page lock, the accepted current list and event owner, no Line
// request or owed refresh, no event read or draw in flight and the three fresh guards all known false.
export const pageClear = (page) => !pageBlocked(page) && page.owner === true && page.linePending === false &&
  page.lineRefresh === 'none' && page.eventPending === false && isObject(page.guards) &&
  ['tongoPlaying', 'presentationBusy', 'otherSetupActive'].every((key) => page.guards[key] === false);

// A manual action on the award shown (H4a): every page gate clear, a Line of this event, no owed committed refresh,
// the fresh bingo_declared phase, and exactly the event, id and status `expected` captured at the click, with no
// setup, legacy check or recovery refresh. The action's own pending reservation is not a blocker: the page checks
// this once more after the controller's pending render, right before the bridge.
export function manualAdmitted(page, state, expected) {
  const shown = state?.mode === 'declared' ? state.award : null;
  return pageClear(page) && page.lineForeign === false && page.owed === 'none' && page.phase === 'bingo_declared' &&
    expected?.eventId !== null && page.eventId === expected.eventId && state.eventId === expected.eventId &&
    state.session === null && state.legacy?.status === 'none' && state.refresh === 'none' &&
    shown?.eventId === expected.eventId && shown.presentation?.id === expected.id && shown.presentation.status === expected.status;
}

// A Bingo winner count as typed: only a positive safe integer in full digits, never a blank, default or coercion.
export function parseWinners(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const count = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

// The persisted Line evidence a Bingo needs: the active event's declared Line award with no lot to settle, or its tied lot
// already resolved, by the award itself or by a validated lot read of exactly that award (event, celebration, winners
// and lot). A historical line_declared without an award, or a lot still pending or unread, is not evidence.
export function lineResolved(line, lot, eventId) {
  const award = line.mode === 'declared' && !line.pending ? line.award : null;
  if (eventId === null || award?.eventId !== eventId) return false;
  const { lotResolution, winnerCount, lot: name } = award.award;
  if (lotResolution !== 'pending') return lotResolution === 'not_required' || lotResolution === 'resolved';
  const seen = lot?.status === 'resolved' ? lot.snapshot : null;
  return seen !== null && seen.fact.resolution === 'resolved' && seen.eventId === eventId &&
    seen.presentation.id === award.presentation?.id && seen.winnerCount === winnerCount && seen.lot === name;
}

// The page's shared committed-fact refresh. A read already in flight may predate the commit, so it is awaited and a
// genuinely new read follows, never joined. An event snapshot names no event: the page's owner token (accepted active
// event, selection and list freshness) is pinned before any read and must be the same afterwards. `settled` first
// waits for a list read in flight, so a startup refresh pins only what that list accepted. No owner, a lost owner, a
// failed read or unaccepted facts answer false.
export function createFactRefresh({ owner, settled = () => undefined, busy, read, accepted }) {
  return async () => {
    let own = null;
    try {
      await settled();
      own = owner();
      if (own === null) return false;
      while (busy()) {
        await read();
        if (owner() !== own) return false;
      }
      await read();
    } catch { return false; }
    return owner() === own && accepted();
  };
}

// The dedicated Bingo lot panel (BG-06C2a) is shown only for a declared Bingo of the active event whose lot still
// needs settling or has been settled: pending or resolved. Anything else — another event, a setup, an uncertain or
// idle read, no award at all — stays hidden, fail closed.
export function bingoLotVisible(state, activeEventId) {
  const award = state?.mode === 'declared' && activeEventId !== null && state.eventId === activeEventId ? state.award : null;
  const resolution = award?.award?.lotResolution;
  return resolution === 'pending' || resolution === 'resolved';
}

// The Bingo lot panel's own busy gates. This is deliberately NOT a drawingBlocked() copy: once the Bingo is declared
// bingoLocks().draw is permanently true, so a verbatim copy would disable the Bingo lot draw forever, while the
// settled lot is exactly what a declared Bingo leaves behind. Everything else ordinary drawing needs still applies:
// the page's locks, a live Bingo (a read, a setup or the pending/running celebration, per bingoLocks().live) and a
// stale, pending or failed event state. Only the declared draw lock itself is excluded.
export function bingoLotBusy(page, state, eventId) {
  return Boolean(page.selecting || page.activating || page.tongoBusy || page.eventsPending || page.eventsStale ||
    bingoLocks(state, eventId).live || page.eventPending || page.eventStale || page.eventError);
}

// The read-once key of the shown Bingo lot, mirroring the Line's lotKey: exactly the event, the celebration id and
// whether that celebration completed. A pending or started celebration starts nothing; the key only turns readable
// (operator-ui gates the read on the completed flag) once, and an unchanged key never reads again.
export function bingoLotKey(state) {
  const award = state?.mode === 'declared' ? state.award : null;
  return award ? `${award.eventId}|${award.presentation?.id}|${award.presentation?.status === 'completed'}` : null;
}

// Subscribes at once (inside the controller), before any read. `refresh` serves both the committed and the recovered
// fact refresh. The committed one runs once, after a valid explicit confirm has released its flight; its outcome is
// kept for the event it ran under (pending, failed or none) and only an explicit retry runs it again.
export function createBingoBinding(api, { render, refresh }) {
  let applied = null;
  let owed = null;
  let disposed = false;
  // The page's check of the manual retry being sent, or null. The controller renders pending, rechecks its own
  // guards and calls the bridge synchronously within retry(), so the bridge below runs this check last: anything
  // but true sends nothing and answers a refusal, which keeps the shown award.
  let gate = null;
  const bridge = { ...api };
  // The retry (H4a) and the repeat (H4b) share the adapter: the page's check runs last, right before the send.
  for (const name of ['retryBingoPresentation', 'repeatBingoPresentation']) {
    if (typeof api?.[name] === 'function') {
      bridge[name] = (id) => {
        let ready = false;
        try { ready = gate?.() === true; } catch { /* Not admitted. */ }
        return ready ? api[name](id) : { ok: false, code: 'not_available', message: NOT_NOW };
      };
    }
  }
  const controller = createBingoController(bridge, { render }, { committed: () => committed(), recovered: refresh });
  // Only the live binding's current attempt may refresh, settle or paint: a disposal, event change or newer attempt,
  // also from the pending render itself, orphans it before the refresh is called or after it settles.
  const live = (own) => !disposed && owed === own;
  const committed = async () => {
    if (disposed) return;
    const own = { eventId: controller.getState().eventId, state: 'pending' };
    owed = own;
    render(controller.getState());
    if (!live(own)) return;
    let ok = false;
    try { ok = await refresh() === true; } catch { /* Reported as failed below. */ }
    if (!live(own)) return;
    owed = ok ? null : { ...own, state: 'failed' };
    render(controller.getState());
  };
  return {
    begin: () => controller.begin(),
    cancel: () => controller.cancel(),
    confirm: (count) => controller.confirm(count),
    // The explicit retry of exactly `id`, admitted by the page's `ready` once more right before the bridge. A call
    // reentering from the pending render joins that flight and restores the outer check.
    retry(id, ready) {
      if (disposed) return Promise.resolve();
      const outer = gate;
      gate = ready;
      try { return controller.retry(id); } finally { gate = outer; }
    },
    // The explicit full repeat of exactly `id` (H4b), admitted and gated exactly like the retry.
    repeat(id, ready) {
      if (disposed) return Promise.resolve();
      const outer = gate;
      gate = ready;
      try { return controller.repeat(id); } finally { gate = outer; }
    },
    // The explicit read of an uncertain answer: never a begin, confirm or playback.
    read: () => controller.start(),
    // The explicit legacy check surface (H5): one read establishes or refreshes the held check, the cancel sends the
    // exact held identity once, and only a failed recovery refresh may be retried; never a begin or a playback.
    checkLegacy: () => controller.checkLegacy(),
    cancelLegacy: () => controller.cancelLegacy(),
    retryRecovery: () => controller.retryRefresh(),
    // The committed refresh of the given event: pending, failed or none.
    refreshState: (eventId) => (owed !== null && owed.eventId === eventId ? owed.state : 'none'),
    retryRefresh() {
      if (!disposed && owed?.state === 'failed') committed().catch(() => {});
    },
    // The event and fresh phase first, so a change makes the guards unknown before the fresh ones are given. Only a
    // change is passed on (the controller renders on every call). Never reads.
    sync(eventId, phase, guards) {
      if (disposed) return;
      const key = JSON.stringify([eventId, phase ?? null]);
      if (key !== applied) {
        applied = key;
        if (owed !== null && owed.eventId !== eventId) owed = null;
        controller.setEvent(eventId, phase);
      }
      controller.setGuards(guards);
    },
    // The explicit read of the page's read paths. One in flight may predate the change, so a new one follows.
    async reread() {
      if (controller.getState().pending) await controller.start();
      await controller.start();
    },
    // Idempotent. The owed refresh is dropped first, so no settlement, retry or render can revive it.
    dispose() {
      if (disposed) return;
      disposed = true;
      owed = null;
      controller.dispose();
    },
  };
}
