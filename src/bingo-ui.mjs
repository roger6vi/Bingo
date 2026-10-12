// Private Bingo composition of the operator page (H2). It binds the Bingo controller to the page's active event,
// fresh phase and guards, offers the explicit read the page's existing read paths use, and says what Bingo locks.
// Nothing here reads, writes or plays by itself: the declaration, manual and legacy actions stay unbound until H3–H5.
import { createBingoController } from './bingo-controller.mjs';

const running = (award) => award !== null && (award.presentation.status === 'pending' || award.presentation.status === 'started');

// Live: a Bingo read or action in flight, a setup main may hold (also while uncertain) or a public celebration in
// progress. Drawing: anything but an idle, read state of the active event with no legacy check or owed refresh, so
// a declared Bingo never unlocks it, a completed celebration included.
export function bingoLocks(state, eventId) {
  const live = state.pending || state.session !== null || running(state.award);
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

// Subscribes at once (inside the controller), before any read. `refresh` serves both the committed and the recovered
// fact refresh; neither is reachable before H3/H5 binds the actions.
export function createBingoBinding(api, { render, refresh }) {
  let applied = null;
  const controller = createBingoController(api, { render }, { committed: refresh, recovered: refresh });
  return {
    // The event and fresh phase first, so a change makes the guards unknown before the fresh ones are given. Only a
    // change is passed on (the controller renders on every call). Never reads.
    sync(eventId, phase, guards) {
      const key = JSON.stringify([eventId, phase ?? null]);
      if (key !== applied) {
        applied = key;
        controller.setEvent(eventId, phase);
      }
      controller.setGuards(guards);
    },
    // The explicit read of the page's read paths. One in flight may predate the change, so a new one follows.
    async reread() {
      if (controller.getState().pending) await controller.start();
      await controller.start();
    },
    dispose: () => controller.dispose(),
  };
}
