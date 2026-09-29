import { normalizePrizes, type EventPrizes } from './event-prizes.ts';

export const PRIZE_CHANNELS = Object.freeze({ get: 'prizes:get', update: 'prizes:update' });

// eventId names the event the prizes belong to, so a reply that races a selection is recognizable.
export type PrizeResult =
  | { ok: true; eventId: string; prizes: EventPrizes }
  | { ok: false; code: 'invalid_request' | 'event_unavailable' | 'storage_failure'; message: string };

type PrizeRequest = { sender: unknown; senderFrame: unknown };
type PrizeStore = {
  loadPrizes(): { eventId: string; prizes: EventPrizes } | null;
  updateEventPrizes(id: string, prizes: EventPrizes): EventPrizes;
};
type Registrar = {
  handle(channel: string, handler: (event: PrizeRequest, ...args: unknown[]) => PrizeResult): void;
};

const invalidRequest = (): PrizeResult => ({ ok: false, code: 'invalid_request', message: 'Invalid prize request.' });
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64;
const copy = (prizes: EventPrizes): EventPrizes => ({ line: { ...prizes.line }, bingo: { ...prizes.bingo } });

export function registerPrizeIpc(
  registrar: Registrar, store: PrizeStore, authorize: (event: PrizeRequest) => void,
  notifyCommitted?: () => void,
): void {
  registrar.handle(PRIZE_CHANNELS.get, (event, ...args) => {
    authorize(event);
    if (args.length !== 0) return invalidRequest();
    try {
      const loaded = store.loadPrizes();
      return loaded === null
        ? { ok: false, code: 'event_unavailable', message: 'No active event is available.' }
        : { ok: true, eventId: loaded.eventId, prizes: copy(loaded.prizes) };
    } catch { return { ok: false, code: 'storage_failure', message: 'Could not read the prizes. Try again.' }; }
  });
  registrar.handle(PRIZE_CHANNELS.update, (event, ...args) => {
    authorize(event);
    const prizes = args.length === 2 && validId(args[0]) ? normalizePrizes(args[1]) : null;
    if (prizes === null) return invalidRequest();
    const id = args[0] as string;
    let saved: EventPrizes;
    try { saved = store.updateEventPrizes(id, prizes); }
    catch { return { ok: false, code: 'storage_failure', message: 'Could not save the prizes. Reload the events and try again.' }; }
    // The prizes have committed; delivery to the public window cannot undo them.
    try { notifyCommitted?.(); }
    catch { /* Delivery is best effort after persistence commits. */ }
    return { ok: true, eventId: id, prizes: copy(saved) };
  });
}
