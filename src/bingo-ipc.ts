import { randomUUID } from 'node:crypto';
import type { BingoDeclarationBaseline, StoredBingoAward } from './event-store';

// Setup only: declaration, confirmation and manual presentation routes arrive separately and are not registered here.
export const BINGO_CHANNELS = Object.freeze({
  begin: 'bingo:begin',
  read: 'bingo:read',
  cancel: 'bingo:cancel',
});

// What the dialog may see of the main-owned session; the complete baseline itself never leaves main.
export type BingoSetupView = {
  sessionId: string;
  eventId: string;
  calledNumbers: number[];
  bingoPrize: { amount: number; lot: string };
};

// `state` separates committed facts (declared/none) from the transient setup and its lifecycle (cancelled).
export type BingoResult =
  | { ok: true; state: 'setup'; session: BingoSetupView }
  | { ok: true; state: 'declared'; award: StoredBingoAward }
  | { ok: true; state: 'none' }
  | { ok: true; state: 'cancelled' }
  | { ok: false; code: 'invalid_request' | 'not_available' | 'setup_active' | 'stale_session' | 'storage_failure'
    | 'tongo_active' | 'presentation_busy'; message: string };

type BingoRequest = { sender: unknown; senderFrame: unknown };
// Read-only store surface: this module never writes persistence.
type BingoStore = {
  loadBingoAward(): StoredBingoAward | null;
  loadBingoDeclarationBaseline(): BingoDeclarationBaseline;
};
type Registrar = {
  handle(channel: string, handler: (event: BingoRequest, ...args: unknown[]) => BingoResult): void;
};
type Ports = {
  authorize(event: BingoRequest): void;
  // Shared guards: no Bingo setup next to Tongo, a running presentation or another open setup (the first line).
  tongoPlaying?(): boolean;
  presentationBusy?(): boolean;
  otherSetupActive?(): boolean;
};
type Session = { id: string; eventId: string; frame: unknown; baseline: BingoDeclarationBaseline };

const failure = (code: Exclude<BingoResult, { ok: true }>['code'], message: string): BingoResult =>
  ({ ok: false, code, message });
const invalid = () => failure('invalid_request', 'Invalid Bingo request.');
const stale = () => failure('stale_session', 'This Bingo setup is no longer current. Reopen it.');
const unreadable = () => failure('storage_failure', 'Could not read the Bingo state. Try again.');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
const notEligible = (error: unknown) => (error as { code?: unknown } | null)?.code === 'bingo_not_eligible';

// A deep, frozen private copy so neither the store's object nor any caller can change what main holds.
const copyBaseline = (b: BingoDeclarationBaseline): BingoDeclarationBaseline => Object.freeze({
  eventId: b.eventId, calledNumbers: Object.freeze([...b.calledNumbers]), phase: b.phase,
  lastTransitionAt: b.lastTransitionAt, auditSequence: b.auditSequence,
  bingoPrize: Object.freeze({ amount: b.bingoPrize.amount, lot: b.bingoPrize.lot }),
  line: Object.freeze({ auditSequence: b.line.auditSequence, presentationId: b.line.presentationId,
    lotResolution: b.line.lotResolution }),
});
const sameBaseline = (a: BingoDeclarationBaseline, b: BingoDeclarationBaseline): boolean =>
  a.eventId === b.eventId && a.phase === b.phase && a.lastTransitionAt === b.lastTransitionAt &&
  a.auditSequence === b.auditSequence && a.bingoPrize.amount === b.bingoPrize.amount &&
  a.bingoPrize.lot === b.bingoPrize.lot && a.line.auditSequence === b.line.auditSequence &&
  a.line.presentationId === b.line.presentationId && a.line.lotResolution === b.line.lotResolution &&
  a.calledNumbers.length === b.calledNumbers.length && a.calledNumbers.every((n, i) => b.calledNumbers[i] === n);
const viewOf = (session: Session): BingoSetupView => ({ sessionId: session.id, eventId: session.eventId,
  calledNumbers: [...session.baseline.calledNumbers], bingoPrize: { ...session.baseline.bingoPrize } });

// Main owns one transient Bingo setup session. It is never persisted: the renderer only holds an opaque id, a reload
// keeps the session, and only the frame that explicitly adopted it through read may cancel it.
export function registerBingoIpc(registrar: Registrar, store: BingoStore, ports: Ports) {
  let session: Session | null = null;

  registrar.handle(BINGO_CHANNELS.begin, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return invalid();
    if (ports.tongoPlaying?.()) return failure('tongo_active', 'Wait for Tongo to finish, then try again.');
    if (ports.presentationBusy?.()) return failure('presentation_busy', 'Wait for the celebration to finish first.');
    if (session !== null) return failure('setup_active', 'A Bingo setup is already open. Reopen it to continue.');
    if (ports.otherSetupActive?.()) return failure('setup_active', 'Another setup is open. Close it first.');
    let baseline: BingoDeclarationBaseline;
    try { baseline = copyBaseline(store.loadBingoDeclarationBaseline()); }
    catch (error) {
      // Only the store's typed refusal is "not eligible"; corrupt or unreadable storage never looks like it.
      return notEligible(error) ? failure('not_available', 'The Bingo cannot be declared now.') : unreadable();
    }
    session = { id: randomUUID(), eventId: baseline.eventId, frame: event.senderFrame, baseline };
    return { ok: true, state: 'setup', session: viewOf(session) };
  });

  // Recovery after a reload: a committed award wins over any session; an open session is revalidated against the
  // authoritative baseline and only then adopted by the current authorized frame. A failed read adopts nothing.
  registrar.handle(BINGO_CHANNELS.read, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return invalid();
    let award: StoredBingoAward | null;
    try { award = store.loadBingoAward(); }
    catch { return unreadable(); }
    if (award !== null) {
      session = null;
      return { ok: true, state: 'declared', award: structuredClone(award) };
    }
    if (session === null) return { ok: true, state: 'none' };
    let current: BingoDeclarationBaseline;
    try { current = store.loadBingoDeclarationBaseline(); }
    catch (error) {
      if (!notEligible(error)) return unreadable();
      session = null;
      return stale();
    }
    // Another event or any committed change since begin: the setup is dropped, never silently carried over.
    if (!sameBaseline(session.baseline, current)) {
      session = null;
      return stale();
    }
    session.frame = event.senderFrame;
    return { ok: true, state: 'setup', session: viewOf(session) };
  });

  registrar.handle(BINGO_CHANNELS.cancel, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 2 || !text(args[0]) || !text(args[1])) return invalid();
    if (session === null || session.id !== args[0] || session.eventId !== args[1] ||
        session.frame !== event.senderFrame) return stale();
    session = null;
    return { ok: true, state: 'cancelled' };
  });

  return { active: (): boolean => session !== null };
}
