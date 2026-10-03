import type { EventSnapshot } from './event-core';
import type { GamePhase } from './game-phase';

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

const copySnapshot = (snapshot: PhaseSnapshot): PhaseSnapshot => ({
  calledNumbers: [...snapshot.calledNumbers], phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt,
});

export const EVENT_CHANNELS = Object.freeze({
  get: 'event:get',
  manual: 'event:draw-manual',
  digital: 'event:draw-digital',
});

export type EventResult =
  | { ok: true; snapshot: PhaseSnapshot }
  | { ok: false; code: 'invalid_request' | 'event_unavailable' | 'duplicate' | 'exhausted' | 'invalid_draw' | 'storage_failure'
    | 'presentation_active' | 'line_setup_active' | 'line_presentation_active' | 'presentation_pending'; message: string };

type EventRequest = { sender: unknown; senderFrame: unknown };
type EventStore = {
  load(): PhaseSnapshot | null;
  update(transition: (current: EventSnapshot) => EventSnapshot): PhaseSnapshot;
};
type DrawRules = {
  drawManual(event: EventSnapshot, number: number): EventSnapshot;
  drawDigital(event: EventSnapshot, random: () => number): EventSnapshot;
};
type Registrar = {
  handle(channel: string, handler: (event: EventRequest, ...args: unknown[]) => EventResult): void;
};

const invalidRequest = (): EventResult => ({ ok: false, code: 'invalid_request', message: 'Invalid event request.' });
const committed = (snapshot: PhaseSnapshot): EventResult => ({ ok: true, snapshot: copySnapshot(snapshot) });

// Only the operator's current main frame at its exact page URL may use operator channels.
export function createOperatorGuard(
  sender: object, getMainFrame: () => { url: string } | null, expectedUrl: string,
) {
  return (event: EventRequest): void => {
    if (event.sender !== sender) throw new Error('Unauthorized event request');
    const mainFrame = getMainFrame();
    if (mainFrame === null || event.senderFrame !== mainFrame || mainFrame.url !== expectedUrl) {
      throw new Error('Unauthorized event request');
    }
  };
}

export function registerEventIpc(
  registrar: Registrar, store: EventStore, rules: DrawRules, random: () => number,
  sender: object, getMainFrame: () => { url: string } | null, expectedUrl: string,
  notifyCommitted?: (snapshot: PhaseSnapshot) => void, presenting?: () => boolean,
  setupActive?: () => boolean, linePresenting?: () => boolean,
): void {
  const authorized = createOperatorGuard(sender, getMainFrame, expectedUrl);
  const busy = (): EventResult =>
    ({ ok: false, code: 'presentation_active', message: 'Wait for Tongo to finish, then draw again.' });

  // An open first-line setup holds a baseline of the called numbers, so no draw may change them underneath it.
  const setupOpen = (): EventResult =>
    ({ ok: false, code: 'line_setup_active', message: 'Finish or cancel the first-line setup, then draw again.' });

  // A line celebration is running (or the store holds an unfinished presentation): the board must not change.
  const lineBusy = (): EventResult => ({ ok: false, code: 'line_presentation_active',
    message: 'Wait for the line celebration to finish, then draw again.' });

  function draw(transition: (current: EventSnapshot) => EventSnapshot, manualNumber?: number): EventResult {
    const domain: { thrown: boolean; error?: unknown; code: 'duplicate' | 'exhausted' | 'invalid_draw' } =
      { thrown: false, code: 'invalid_draw' };
    try {
      const snapshot = store.update((current) => {
        try { return transition(current); }
        catch (error) {
          domain.thrown = true;
          domain.error = error;
          if (current.calledNumbers.length === 90) domain.code = 'exhausted';
          else if (manualNumber !== undefined && current.calledNumbers.includes(manualNumber)) domain.code = 'duplicate';
          throw error;
        }
      });
      // The store has returned after commit. A broken display cannot undo the draw.
      try { notifyCommitted?.(copySnapshot(snapshot)); }
      catch { /* Delivery is best effort after persistence commits. */ }
      return committed(snapshot);
    } catch (error) {
      if (domain.thrown && error === domain.error) {
        if (domain.code === 'exhausted') return { ok: false, code: 'exhausted', message: 'All numbers have been called.' };
        if (domain.code === 'duplicate') return { ok: false, code: 'duplicate', message: 'That number has already been called.' };
        return { ok: false, code: 'invalid_draw', message: 'Could not draw a number. Reload and try again.' };
      }
      if (error instanceof Error && /until the line presentation is completed/.test(error.message)) {
        return { ok: false, code: 'presentation_pending', message: 'The line celebration is not finished.' };
      }
      return { ok: false, code: 'storage_failure', message: 'Could not save the draw. Reload and try again.' };
    }
  }

  registrar.handle(EVENT_CHANNELS.get, (event, ...args) => {
    authorized(event);
    if (args.length !== 0) return invalidRequest();
    try {
      const snapshot = store.load();
      return snapshot === null
        ? { ok: false, code: 'event_unavailable', message: 'No current event is available.' }
        : committed(snapshot);
    } catch {
      return { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' };
    }
  });
  registrar.handle(EVENT_CHANNELS.manual, (event, ...args) => {
    authorized(event);
    if (args.length !== 1 || typeof args[0] !== 'number' ||
        !Number.isInteger(args[0]) || args[0] < 1 || args[0] > 90) return invalidRequest();
    const number = args[0];
    if (setupActive?.()) return setupOpen();
    if (presenting?.()) return busy();
    if (linePresenting?.()) return lineBusy();
    return draw((current) => rules.drawManual(current, number), number);
  });
  registrar.handle(EVENT_CHANNELS.digital, (event, ...args) => {
    authorized(event);
    if (args.length !== 0) return invalidRequest();
    if (setupActive?.()) return setupOpen();
    if (presenting?.()) return busy();
    if (linePresenting?.()) return lineBusy();
    return draw((current) => rules.drawDigital(current, random));
  });
}
