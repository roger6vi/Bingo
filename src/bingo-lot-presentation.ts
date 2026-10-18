import { randomUUID } from 'node:crypto';
import { BINGO_LOT_CHANNELS, registerBingoLotIpc, type BingoLotIpcResult } from './bingo-lot-ipc.ts';

export const BINGO_LOT_PRESENT_CHANNEL = 'bingo:lot:present';

type Inner = Parameters<typeof registerBingoLotIpc>;
type Request = { sender: unknown; senderFrame: unknown };
type Handler = Parameters<Inner[0]['handle']>[1];
type Registrar = { handle(channel: string, handler: (event: Request, ...args: unknown[]) => unknown): void };
// The only fields that may reach the public window: an opaque correlation id and the winner number and color.
export type BingoLotSignal = Readonly<{ id: string; participantNumber: number; colorId: string }>;
type Ports = Inner[2] & { publish(signal: BingoLotSignal): unknown };
export type BingoLotPresentResult = { ok: true } | { ok: false; message: string;
  code: 'invalid_request' | 'ineligible' | 'stale_identity' | 'storage_failure' };
// One owned handoff: the actor, frame and generation that drew it, plus a frozen copy of every snapshot field.
type Ticket = Readonly<{ sender: unknown; frame: unknown; epoch: number; tuple: readonly unknown[] }>;

const fail = (code: Exclude<BingoLotPresentResult, { ok: true }>['code'], message: string): BingoLotPresentResult =>
  ({ ok: false, code, message });
const ROOT = ['auditSequence', 'eventId', 'fact', 'lot', 'presentation', 'winnerCount'];
const FACT = ['colorId', 'origin', 'paletteVersion', 'participantNumber', 'resolution'];

// Plain object with exactly these own enumerable data properties; descriptors are read, so no getter ever runs.
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(own).length !== keys.length) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = own[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return null;
    out[key] = descriptor.value;
  }
  return out;
}

// Every identity and fact field of a strict numbered snapshot as one frozen tuple; null for any other shape.
function tupleOf(value: unknown): readonly unknown[] | null {
  try {
    const root = plain(value, ROOT);
    const presentation = root && plain(root.presentation, ['id', 'status']);
    const fact = root && plain(root.fact, FACT);
    if (!root || !presentation || !fact) return null;
    return Object.freeze([root.eventId, root.auditSequence, root.winnerCount, root.lot, presentation.id,
      presentation.status, fact.origin, fact.resolution, fact.paletteVersion, fact.participantNumber, fact.colorId]);
  } catch { return null; }
}
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// Wraps the real lot IPC. Only a draw that this wrapper saw commit as a completed numbered fact, still in the same
// actor, frame and generation and still equal to a fresh store read, becomes the single handoff the operator may
// submit. Submitting consumes it before publishing, so delivery can fail or reenter without ever repeating.
// Bingo lot playback is the audited one-shot presentation with a Bingo label (user decision: "Igual que Línea,
// rotulado Bingo"); every failure text below is already lot-generic and needs no rewriting.
export function registerBingoLotPresentation(registrar: Registrar, store: Inner[1], ports: Ports): { invalidate(): void } {
  let epoch = 0;
  let ordinal = 0;
  let eligible: Ticket | null = null;
  const invalidate = () => { epoch++; eligible = null; };

  const draw = (handler: Handler): Handler => (event, ...args) => {
    const [sender, frame, started, mine] = [event.sender, event.senderFrame, epoch, ++ordinal];
    const result: BingoLotIpcResult = handler(event, ...args);
    try {
      if (!result.ok || result.kind !== 'committed') return result;
      const issued = tupleOf(result.snapshot);
      if (issued === null || issued[5] !== 'completed' || issued[6] !== 'numbered_v1' || issued[7] !== 'resolved' ||
          !Number.isSafeInteger(issued[9]) || typeof issued[10] !== 'string') return result;
      const fresh = tupleOf(store.loadBingoLotResult());
      ports.authorize(event); // The store callback may have moved the actor, so authority is checked after it.
      if (fresh !== null && same(fresh, issued) && epoch === started && ordinal === mine) {
        eligible = Object.freeze({ sender, frame, epoch: started, tuple: issued });
      }
    } catch { /* Not eligible. */ }
    return result;
  };

  const present = (event: Request, ...args: unknown[]): BingoLotPresentResult => {
    ports.authorize(event);
    const sent = args.length === 1 ? tupleOf(args[0]) : null;
    if (sent === null) return fail('invalid_request', 'Invalid lot presentation request.');
    const ticket = eligible;
    if (ticket === null || ticket.epoch !== epoch || ticket.sender !== event.sender || ticket.frame !== event.senderFrame) {
      return fail('ineligible', 'No drawn lot is ready to present.');
    }
    if (!same(sent, ticket.tuple)) return fail('stale_identity', 'The lot changed. Read it again.');
    let fresh: readonly unknown[] | null;
    try { fresh = tupleOf(store.loadBingoLotResult()); }
    catch { return fail('storage_failure', 'Could not read the lot state. Try again.'); }
    try { ports.authorize(event); } catch { throw new Error('Unauthorized event request'); }
    if (eligible !== ticket || ticket.epoch !== epoch) return fail('ineligible', 'No drawn lot is ready to present.');
    if (fresh === null || !same(fresh, ticket.tuple)) return fail('stale_identity', 'The lot changed. Read it again.');
    eligible = null;
    try {
      ports.publish(Object.freeze({ id: randomUUID(), participantNumber: ticket.tuple[9] as number, colorId: ticket.tuple[10] as string }));
    } catch { /* The handoff is already consumed; delivery is never retried. */ }
    return { ok: true };
  };

  // registerBingoLotIpc already maps the shared channels onto their Bingo names, so the filtering registrar
  // below sees Bingo names only; only the draw route gains the one-shot ticket wrapper.
  registerBingoLotIpc({ handle: (channel, handler) =>
    registrar.handle(channel, channel === BINGO_LOT_CHANNELS.draw ? draw(handler) : handler) }, store, ports);
  registrar.handle(BINGO_LOT_PRESENT_CHANNEL, present);
  return { invalidate };
}
