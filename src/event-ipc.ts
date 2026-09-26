import type { EventSnapshot } from './event-core';

export const EVENT_CHANNELS = Object.freeze({
  get: 'event:get',
  manual: 'event:draw-manual',
  digital: 'event:draw-digital',
});

export type EventResult =
  | { ok: true; snapshot: { calledNumbers: number[] } }
  | { ok: false; code: 'invalid_request' | 'event_unavailable' | 'duplicate' | 'exhausted' | 'invalid_draw' | 'storage_failure'; message: string };

type EventRequest = { sender: unknown; senderFrame: unknown };
type EventStore = {
  load(): EventSnapshot | null;
  update(transition: (current: EventSnapshot) => EventSnapshot): EventSnapshot;
};
type DrawRules = {
  drawManual(event: EventSnapshot, number: number): EventSnapshot;
  drawDigital(event: EventSnapshot, random: () => number): EventSnapshot;
};
type Registrar = {
  handle(channel: string, handler: (event: EventRequest, ...args: unknown[]) => EventResult): void;
};

const invalidRequest = (): EventResult => ({ ok: false, code: 'invalid_request', message: 'Invalid event request.' });
const committed = (snapshot: EventSnapshot): EventResult =>
  ({ ok: true, snapshot: { calledNumbers: [...snapshot.calledNumbers] } });

export function registerEventIpc(
  registrar: Registrar, store: EventStore, rules: DrawRules, random: () => number,
  sender: object, mainFrame: object,
): void {
  function authorized(event: EventRequest): void {
    if (event.sender !== sender || event.senderFrame !== mainFrame) {
      throw new Error('Unauthorized event request');
    }
  }

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
      return committed(snapshot);
    } catch (error) {
      if (domain.thrown && error === domain.error) {
        if (domain.code === 'exhausted') return { ok: false, code: 'exhausted', message: 'All numbers have been called.' };
        if (domain.code === 'duplicate') return { ok: false, code: 'duplicate', message: 'That number has already been called.' };
        return { ok: false, code: 'invalid_draw', message: 'Could not draw a number. Reload and try again.' };
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
    return draw((current) => rules.drawManual(current, number), number);
  });
  registrar.handle(EVENT_CHANNELS.digital, (event, ...args) => {
    authorized(event);
    if (args.length !== 0) return invalidRequest();
    return draw((current) => rules.drawDigital(current, random));
  });
}
