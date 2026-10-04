import type { GamePhase } from './game-phase';

export const TONGO_CHANNEL = 'tongo:play';
export const TONGO_DURATION_MS = 3000;

// A transient public celebration after a claim was rejected outside the app. Nothing is persisted and
// no game state changes; the id only lets each display drop a repeated signal.
export type TongoPresentation = { readonly kind: 'tongo'; readonly id: number; readonly durationMs: number };

export type TongoResult =
  | { ok: true; presentation: TongoPresentation }
  | { ok: false; code: 'invalid_request' | 'not_playable' | 'busy' | 'public_unavailable' | 'storage_failure'
    | 'line_presentation_active';
    message: string };

type TongoRequest = { sender: unknown; senderFrame: unknown };
type Registrar = {
  handle(channel: string, handler: (event: TongoRequest, ...args: unknown[]) => TongoResult): void;
};
type Store = { load(): { readonly phase: GamePhase } | null };
type Ports = {
  authorize(event: TongoRequest): void;
  // Reports whether the signal reached a live public window.
  publish(presentation: TongoPresentation): boolean;
  schedule?(done: () => void, delay: number): unknown;
  // A line celebration owns the public window; Tongo must not overlap it.
  lineBusy?(): boolean;
};

const playable = (phase: GamePhase) => phase === 'drawing' || phase === 'line_declared';
const failure = (code: Exclude<TongoResult, { ok: true }>['code'], message: string): TongoResult =>
  ({ ok: false, code, message });

export function registerTongoIpc(registrar: Registrar, store: Store, ports: Ports) {
  const schedule = ports.schedule ?? setTimeout;
  let playing = false;
  let nextId = 1;

  registrar.handle(TONGO_CHANNEL, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return failure('invalid_request', 'Invalid Tongo request.');
    if (playing) return failure('busy', 'Tongo is already playing on the public window.');
    if (ports.lineBusy?.()) {
      return failure('line_presentation_active', 'Wait for the line celebration to finish, then try Tongo again.');
    }
    let phase: GamePhase | null;
    try { phase = store.load()?.phase ?? null; }
    catch { return failure('storage_failure', 'Could not read the current event. Try again.'); }
    if (phase === null || !playable(phase)) return failure('not_playable', 'Tongo is only available during play.');
    const presentation: TongoPresentation = { kind: 'tongo', id: nextId, durationMs: TONGO_DURATION_MS };
    let delivered: boolean;
    try { delivered = ports.publish({ ...presentation }); } catch { delivered = false; }
    // Never acknowledge a celebration that nobody saw start.
    if (!delivered) return failure('public_unavailable', 'Open the public window, then try Tongo again.');
    nextId++;
    playing = true;
    schedule(() => { playing = false; }, TONGO_DURATION_MS);
    return { ok: true, presentation };
  });
  // While playing, other live actions (draws) are refused so the board cannot change underneath it.
  return { playing: (): boolean => playing };
}
