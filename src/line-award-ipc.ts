import type { EventSnapshot } from './event-core';
import type { GamePhase } from './game-phase';
import { validWinners, type LineAward } from './line-award.ts';

export const LINE_AWARD_CHANNELS = Object.freeze({ get: 'line:get', award: 'line:award' });

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

// A line is acknowledged only from this committed pair; eventId lets a reply that races a selection be dropped.
export type LineAwardResult =
  | { ok: true; eventId: string; snapshot: PhaseSnapshot; award: LineAward | null }
  | { ok: false; code: 'invalid_request' | 'event_unavailable' | 'not_awardable' | 'presentation_active' |
    'storage_failure'; message: string };

type LineAwardRequest = { sender: unknown; senderFrame: unknown };
type Loaded = { eventId: string; snapshot: PhaseSnapshot; award: LineAward | null };
type Store = {
  loadLineAward(): Loaded | null;
  awardLine(id: string, winners: number, transitionAt: string): { snapshot: PhaseSnapshot; award: LineAward };
};
type Registrar = {
  handle(channel: string, handler: (event: LineAwardRequest, ...args: unknown[]) => LineAwardResult): void;
};
type Ports = {
  authorize(event: LineAwardRequest): void;
  now?(): string;
  // True while a public presentation (Tongo) is showing.
  presenting?(): boolean;
  notifyCommitted?(snapshot: PhaseSnapshot): void;
};

const awardable = (phase: GamePhase) => phase === 'drawing' || phase === 'checking_line';
const failure = (code: Exclude<LineAwardResult, { ok: true }>['code'], message: string): LineAwardResult =>
  ({ ok: false, code, message });
const copy = ({ eventId, snapshot, award }: Loaded): Extract<LineAwardResult, { ok: true }> => ({
  ok: true, eventId, award: award === null ? null : { ...award },
  snapshot: { calledNumbers: [...snapshot.calledNumbers], phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt },
});

export function registerLineAwardIpc(registrar: Registrar, store: Store, ports: Ports): void {
  const now = ports.now ?? (() => new Date().toISOString());
  const load = (): Loaded | LineAwardResult => {
    try {
      return store.loadLineAward() ?? failure('event_unavailable', 'No active event is available.');
    } catch { return failure('storage_failure', 'Could not read the current event. Try again.'); }
  };

  registrar.handle(LINE_AWARD_CHANNELS.get, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return failure('invalid_request', 'Invalid line request.');
    const loaded = load();
    return 'ok' in loaded ? loaded : copy(loaded);
  });
  registrar.handle(LINE_AWARD_CHANNELS.award, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 2 || typeof args[0] !== 'string' || args[0].length === 0 || args[0].length > 64 ||
        !validWinners(args[1])) return failure('invalid_request', 'Invalid line request.');
    const [id, winners] = args as [string, number];
    if (ports.presenting?.()) return failure('presentation_active', 'Wait for Tongo to finish, then try again.');
    const loaded = load();
    if ('ok' in loaded) return loaded;
    if (loaded.eventId !== id || !awardable(loaded.snapshot.phase)) {
      return failure('not_awardable', 'The line can no longer be awarded. Reload and try again.');
    }
    let committed: { snapshot: PhaseSnapshot; award: LineAward };
    // Any failure here rolled back, including a race with another writer: the prior state stands.
    try { committed = store.awardLine(id, winners, now()); }
    catch { return failure('storage_failure', 'Could not save the line. Reload and try again.'); }
    const result = copy({ eventId: id, ...committed });
    try { ports.notifyCommitted?.(copy({ eventId: id, ...committed }).snapshot); }
    catch { /* Delivery is best effort after persistence commits. */ }
    return result;
  });
}
