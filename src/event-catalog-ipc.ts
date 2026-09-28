import type { EventSummary } from './event-store';

export const CATALOG_CHANNELS = Object.freeze({
  list: 'events:list',
  create: 'events:create',
  select: 'events:select',
});

export type CatalogResult =
  | { ok: true; events: EventSummary[] }
  | { ok: false; code: 'invalid_request' | 'storage_failure'; message: string; selected?: true };

type CatalogRequest = { sender: unknown; senderFrame: unknown };
type CatalogStore = {
  listEvents(): EventSummary[];
  createEvent(meta: { name: string; date: string; place: string }): EventSummary;
  selectEvent(id: string): EventSummary;
};
type Registrar = {
  handle(channel: string, handler: (event: CatalogRequest, ...args: unknown[]) => CatalogResult): void;
};

const MAX_TEXT = 120;
const invalidRequest = (): CatalogResult => ({ ok: false, code: 'invalid_request', message: 'Invalid event request.' });
const text = (value: unknown) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_TEXT;
const isoDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);

// Accepts only a plain { name, date, place } record; extra keys are a malformed request.
function validMeta(value: unknown): value is { name: string; date: string; place: string } {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  if (keys.join() !== 'date,name,place') return false;
  const meta = value as Record<string, unknown>;
  return text(meta.name) && text(meta.place) && isoDate(meta.date);
}

export function registerEventCatalogIpc(
  registrar: Registrar, store: CatalogStore, authorize: (event: CatalogRequest) => void,
  notifySelected?: () => void,
): void {
  const list = (failure: string): CatalogResult => {
    try { return { ok: true, events: store.listEvents().map((event) => ({ ...event })) }; }
    catch { return { ok: false, code: 'storage_failure', message: failure }; }
  };

  registrar.handle(CATALOG_CHANNELS.list, (event, ...args) => {
    authorize(event);
    if (args.length !== 0) return invalidRequest();
    return list('Could not read the events. Try again.');
  });
  registrar.handle(CATALOG_CHANNELS.create, (event, ...args) => {
    authorize(event);
    if (args.length !== 1 || !validMeta(args[0])) return invalidRequest();
    const { name, date, place } = args[0];
    try { store.createEvent({ name, date, place }); }
    catch { return { ok: false, code: 'storage_failure', message: 'Could not create the event. Try again.' }; }
    return list('The event was created, but the list could not be read. Reload the events.');
  });
  registrar.handle(CATALOG_CHANNELS.select, (event, ...args) => {
    authorize(event);
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length === 0 || args[0].length > 64) {
      return invalidRequest();
    }
    try { store.selectEvent(args[0]); }
    catch { return { ok: false, code: 'storage_failure', message: 'Could not select the event. Reload the events and try again.' }; }
    // The pointer has committed; delivery to either window cannot undo the selection.
    try { notifySelected?.(); }
    catch { /* Delivery is best effort after persistence commits. */ }
    // Tell the operator the selection committed even when the refreshed list cannot be read.
    const result = list('The event was selected, but the list could not be read. Reload the events.');
    return result.ok ? result : { ...result, selected: true };
  });
}
