import type { LineLotResult } from './line-lot-contract.ts';
import { drawLineLotParticipant } from './line-lot-draw.ts';
import type { LineLotSnapshot } from './event-store';

export const LINE_LOT_CHANNELS = Object.freeze({ read: 'line:lot:read', draw: 'line:lot:draw' });

// 'current' is stored state read now; 'committed' only follows a live store acknowledgement of this call's write;
// 'recovered' is a reread after an uncertain write and must never be treated as a new draw.
export type LineLotIpcResult =
  | { ok: true; kind: 'current' | 'committed' | 'recovered'; snapshot: LineLotSnapshot }
  | { ok: false; code: 'invalid_request' | 'not_available' | 'ineligible' | 'stale_identity' | 'presentation_busy'
    | 'tongo_active' | 'draw_in_progress' | 'selection_failed' | 'storage_failure' | 'read_required';
    message: string };
type Failure = Extract<LineLotIpcResult, { ok: false }>;

type LotRequest = { sender: unknown; senderFrame: unknown };
type LotStore = {
  loadLineLotResult(): LineLotSnapshot | null;
  resolveLineLot(expected: unknown, result: unknown): LineLotSnapshot;
};
type Registrar = {
  handle(channel: string, handler: (event: LotRequest, ...args: unknown[]) => LineLotIpcResult): void;
};
type Ports = {
  authorize(event: LotRequest): void;
  select?(winnerCount: number): LineLotResult;
  busy?(): boolean;
  tongoPlaying?(): boolean;
};
type Identity = { eventId: string; auditSequence: number; presentationId: string };

const fail = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });
const invalid = () => fail('invalid_request', 'Invalid lot request.');
const copy = (snapshot: LineLotSnapshot): LineLotSnapshot => structuredClone(snapshot);
const KEYS = ['auditSequence', 'eventId', 'presentationId'];
const stale = () => fail('stale_identity', 'The lot changed. Read it again.');
const celebrating = () => fail('presentation_busy', 'Wait for the line celebration to finish first.');

// Untrusted renderer input: a plain object with exactly three own enumerable data properties, read once.
function parseExpected(value: unknown): Identity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(own).length !== KEYS.length || Object.keys(own).sort().join() !== KEYS.join() ||
      Object.values(own).some((d) => !('value' in d) || !d.enumerable)) return null;
  const { eventId, auditSequence, presentationId } = Object.fromEntries(KEYS.map((k) => [k, own[k].value]));
  if (typeof eventId !== 'string' || eventId === '' || typeof presentationId !== 'string' || presentationId === '' ||
      typeof auditSequence !== 'number' || !Number.isSafeInteger(auditSequence) || auditSequence < 1) return null;
  return { eventId, auditSequence, presentationId };
}

const matches = (s: LineLotSnapshot, id: Identity): boolean =>
  s.eventId === id.eventId && s.auditSequence === id.auditSequence && s.presentation.id === id.presentationId;

// Operator-only manual lot draw. Main selects once and the store commits atomically; any failure rereads the
// store and never selects again. Nothing here starts a celebration or publishes to the public window.
export function registerLineLotIpc(registrar: Registrar, store: LotStore, ports: Ports): void {
  let drawing = false;
  // Set when an uncertain write could not be confirmed by a strict reread; only a successful read clears it.
  let readRequired = false;
  const mustRead = () => fail('read_required', 'Could not confirm the lot. Read the lot state before doing anything else.');

  registrar.handle(LINE_LOT_CHANNELS.read, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return invalid();
    try {
      const snapshot = store.loadLineLotResult();
      if (snapshot === null) return fail('not_available', 'No first-line lot is available.');
      const detached = copy(snapshot);
      if (!drawing) readRequired = false;
      return { ok: true, kind: 'current', snapshot: detached };
    } catch { return fail('storage_failure', 'Could not read the lot state. Try again.'); }
  });

  registrar.handle(LINE_LOT_CHANNELS.draw, (event, ...args) => {
    ports.authorize(event);
    const expected = args.length === 1 ? parseExpected(args[0]) : null;
    if (expected === null) return invalid();
    if (drawing) return fail('draw_in_progress', 'A lot draw is already in progress.');
    if (readRequired) return mustRead();
    drawing = true;
    try {
      if (ports.tongoPlaying?.()) return fail('tongo_active', 'Wait for Tongo to finish, then try again.');
      if (ports.busy?.()) return celebrating();
      let current: LineLotSnapshot | null;
      try { current = store.loadLineLotResult(); }
      catch { return fail('storage_failure', 'Could not read the lot state. Try again.'); }
      if (current === null) return fail('not_available', 'No first-line lot is available.');
      if (!matches(current, expected)) return stale();
      if (current.fact.resolution === 'resolved') return { ok: true, kind: 'current', snapshot: copy(current) };
      if (current.presentation.status !== 'completed') return celebrating();
      if (current.lot === '' || current.winnerCount < 2 || current.fact.origin !== 'none' ||
          current.fact.resolution !== 'pending') return fail('ineligible', 'This lot cannot be drawn.');

      let pick: LineLotResult;
      try {
        const chosen = (ports.select ?? drawLineLotParticipant)(current.winnerCount);
        pick = { participantNumber: chosen.participantNumber, colorId: chosen.colorId };
      } catch { return fail('selection_failed', 'Could not draw the lot. Try again.'); }

      try {
        const written = store.resolveLineLot({ ...expected }, { ...pick });
        const fact = written.fact;
        if (matches(written, expected) && fact.origin === 'numbered_v1' &&
            fact.participantNumber === pick.participantNumber && fact.colorId === pick.colorId) {
          return { ok: true, kind: 'committed', snapshot: copy(written) };
        }
      } catch { /* The acknowledgement is uncertain: reread below; never select again. */ }
      try {
        const reread = store.loadLineLotResult();
        if (reread === null || !matches(reread, expected)) return stale();
        return { ok: true, kind: 'recovered', snapshot: copy(reread) };
      } catch { readRequired = true; return mustRead(); }
    } finally { drawing = false; }
  });
}
