import { randomUUID } from 'node:crypto';
import type { BingoDeclarationBaseline, LegacyBingoCheck, StoredBingoAward } from './event-store';

// Main-owned setup, declaration, bound recovery and explicit manual presentation actions.
export const BINGO_CHANNELS = Object.freeze({
  begin: 'bingo:begin',
  read: 'bingo:read',
  legacyRead: 'bingo:legacy-check:read',
  legacyCancel: 'bingo:legacy-check:cancel',
  cancel: 'bingo:cancel',
  confirm: 'bingo:confirm',
  retryPresentation: 'bingo:retry-presentation',
  repeatPresentation: 'bingo:repeat-presentation',
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
  | { ok: true; state: 'legacy_check'; check: LegacyBingoCheck }
  | { ok: true; state: 'none' }
  | { ok: true; state: 'cancelled' }
  | { ok: true; state: 'recovered' }
  | { ok: false; code: 'invalid_request' | 'not_available' | 'setup_active' | 'stale_session' | 'storage_failure'
    | 'tongo_active' | 'presentation_busy' | 'presentation_refused'; message: string };

type BingoRequest = { sender: unknown; senderFrame: unknown };
type BingoStore = {
  loadLegacyBingoCheck(): LegacyBingoCheck;
  cancelLegacyBingoCheck(expected: LegacyBingoCheck, at: string): unknown;
  confirmLegacyBingoCancel(expected: LegacyBingoCheck, at: string): 'recovered' | 'unchanged' | 'stale';
  loadBingoAward(): StoredBingoAward | null;
  loadBingoDeclarationBaseline(): BingoDeclarationBaseline;
  declareBingoDirectly(expected: BingoDeclarationBaseline, count: number, at: string): StoredBingoAward;
  confirmBingoDeclaration(expected: BingoDeclarationBaseline, count: number, at: string):
    { state: 'declared'; award: StoredBingoAward } | { state: 'unchanged' | 'stale' };
};
type Registrar = {
  handle(channel: string, handler: (event: BingoRequest, ...args: unknown[]) => BingoResult): void;
};
type Ports = {
  authorize(event: BingoRequest): void;
  now?(): Date;
  committed?(): void;
  recovered?(): void;
  retry?(presentationId: string): void | boolean;
  repeat?(presentationId: string): void | boolean;
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
const canonicalTime = (value: unknown): value is string => {
  if (!text(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

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
  let processing = false;
  let attempt: Readonly<{ sessionId: string; eventId: string; frame: unknown;
    baseline: BingoDeclarationBaseline; count: number; at: string }> | null = null;
  let legacyAttempt: Readonly<{ expected: LegacyBingoCheck; at: string }> | null = null;
  const legacyUncertain = () => failure('storage_failure',
    'Could not confirm legacy Bingo recovery. Check the state later.');
  const finishRecovery = (): BingoResult => {
    legacyAttempt = null;
    try { ports.recovered?.(); }
    catch { /* Notification cannot undo durable recovery or permit another write. */ }
    return { ok: true, state: 'recovered' };
  };
  const resolveLegacyAttempt = (): BingoResult => {
    const original = legacyAttempt;
    if (original === null) return stale();
    let confirmed: ReturnType<BingoStore['confirmLegacyBingoCancel']>;
    try { confirmed = store.confirmLegacyBingoCancel(original.expected, original.at); }
    catch { return legacyUncertain(); }
    if (confirmed === 'recovered') return finishRecovery();
    legacyAttempt = null;
    return confirmed === 'stale' ? stale() : legacyUncertain();
  };
  const uncertain = () => failure('storage_failure',
    'Could not confirm the Bingo declaration. Keep this setup open and check the state later.');

  const finish = (award: StoredBingoAward): BingoResult => {
    const result: BingoResult = { ok: true, state: 'declared', award: structuredClone(award) };
    session = null;
    attempt = null;
    try { ports.committed?.(); }
    catch { /* A notification failure cannot undo a durable declaration or authorize another write. */ }
    return result;
  };

  // Only this bound read can resolve uncertainty. It never loads a generic award or regenerates an attempt.
  const resolveAttempt = (reader?: BingoRequest): BingoResult => {
    const original = attempt;
    if (original === null || session === null) return stale();
    let confirmed: ReturnType<BingoStore['confirmBingoDeclaration']>;
    try {
      confirmed = store.confirmBingoDeclaration(original.baseline, original.count, original.at);
    } catch { return uncertain(); }
    if (confirmed.state === 'declared') return finish(confirmed.award);
    attempt = null;
    if (confirmed.state === 'stale') {
      session = null;
      return stale();
    }
    // An unchanged declaration is not success; only a later explicit confirm may try a new write.
    // An authorized read may adopt the retained setup only after this authoritative result.
    if (reader !== undefined) {
      session.frame = reader.senderFrame;
      return { ok: true, state: 'setup', session: viewOf(session) };
    }
    return uncertain();
  };

  // Hold the external setup lock through all synchronous work, including committed callbacks.
  const handle = (channel: string, handler: (event: BingoRequest, ...args: unknown[]) => BingoResult) => {
    registrar.handle(channel, (event, ...args) => {
      ports.authorize(event);
      if (processing) return failure('setup_active', 'A Bingo operation is already in progress.');
      // Only bound read may resolve an uncertain attempt; all mutations and playback stay blocked.
      if (attempt !== null && channel !== BINGO_CHANNELS.read) return uncertain();
      if (legacyAttempt !== null && channel !== BINGO_CHANNELS.legacyRead) return legacyUncertain();
      processing = true;
      try { return handler(event, ...args); }
      finally { processing = false; }
    });
  };

  handle(BINGO_CHANNELS.begin, (event, ...args) => {
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
  handle(BINGO_CHANNELS.read, (event, ...args) => {
    if (args.length !== 0) return invalid();
    if (attempt !== null) return resolveAttempt(event);
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

  // A retained attempt permits only bound confirmation; otherwise this is a read-only identity view.
  handle(BINGO_CHANNELS.legacyRead, (_event, ...args) => {
    if (args.length !== 0) return invalid();
    if (legacyAttempt !== null) return resolveLegacyAttempt();
    try {
      const check = store.loadLegacyBingoCheck();
      return { ok: true, state: 'legacy_check', check: {
        eventId: check.eventId, phase: check.phase, auditSequence: check.auditSequence,
        lastTransitionAt: check.lastTransitionAt,
      } };
    } catch (error) {
      return (error as { code?: unknown } | null)?.code === 'legacy_bingo_check_not_eligible'
        ? failure('not_available', 'There is no legacy Bingo check to recover.') : unreadable();
    }
  });

  handle(BINGO_CHANNELS.legacyCancel, (_event, ...args) => {
    const [eventId, auditSequence, lastTransitionAt] = args;
    if (args.length !== 3 || !text(eventId) || typeof auditSequence !== 'number' ||
        !Number.isSafeInteger(auditSequence) || auditSequence < 1 || !canonicalTime(lastTransitionAt)) return invalid();
    if (session !== null) return failure('setup_active', 'A Bingo setup is already open. Close it first.');
    if (ports.otherSetupActive?.()) return failure('setup_active', 'Another setup is open. Close it first.');
    if (ports.tongoPlaying?.()) return failure('tongo_active', 'Wait for Tongo to finish, then try again.');
    if (ports.presentationBusy?.()) return failure('presentation_busy', 'Wait for the celebration to finish first.');
    // Preflight precedes the clock; the transactional write still rechecks the complete identity atomically.
    let current: LegacyBingoCheck;
    try { current = store.loadLegacyBingoCheck(); }
    catch { return unreadable(); }
    if (current.eventId !== eventId || current.phase !== 'checking_bingo' ||
        current.auditSequence !== auditSequence || current.lastTransitionAt !== lastTransitionAt) return stale();
    let at: string;
    try {
      const now = (ports.now?.() ?? new Date()).getTime();
      const head = Date.parse(lastTransitionAt);
      if (!Number.isFinite(now)) throw new Error('Invalid clock');
      at = new Date(now <= head ? head + 1 : now).toISOString();
      if (Date.parse(at) <= head) throw new Error('Clock did not advance');
    } catch { return failure('storage_failure', 'Could not read the clock. Try again.'); }
    legacyAttempt = Object.freeze({ expected: Object.freeze({ eventId, phase: 'checking_bingo' as const,
      auditSequence, lastTransitionAt }), at });
    try { store.cancelLegacyBingoCheck(legacyAttempt.expected, legacyAttempt.at); }
    catch { return resolveLegacyAttempt(); }
    return finishRecovery();
  });

  handle(BINGO_CHANNELS.cancel, (event, ...args) => {
    if (args.length !== 2 || !text(args[0]) || !text(args[1])) return invalid();
    if (session === null || session.id !== args[0] || session.eventId !== args[1] ||
        session.frame !== event.senderFrame) return stale();
    session = null;
    return { ok: true, state: 'cancelled' };
  });

  handle(BINGO_CHANNELS.confirm, (event, ...args) => {
    const [id, count] = args;
    if (args.length !== 2 || !text(id) || typeof count !== 'number' ||
        !Number.isSafeInteger(count) || count < 1) return invalid();
    if (session === null || session.id !== id || session.frame !== event.senderFrame) return stale();
    if (ports.tongoPlaying?.()) return failure('tongo_active', 'Wait for Tongo to finish, then try again.');
    if (ports.presentationBusy?.()) return failure('presentation_busy', 'Wait for the celebration to finish first.');
    let current: BingoDeclarationBaseline;
    try { current = store.loadBingoDeclarationBaseline(); }
    catch (error) {
      if (!notEligible(error)) return unreadable();
      session = null;
      return stale();
    }
    if (!sameBaseline(session.baseline, current)) {
      session = null;
      return stale();
    }
    let at: string;
    try {
      const now = (ports.now?.() ?? new Date()).getTime();
      const head = Date.parse(session.baseline.lastTransitionAt);
      if (!Number.isFinite(now) || !Number.isFinite(head)) throw new Error('Invalid clock');
      at = new Date(now <= head ? head + 1 : now).toISOString();
    } catch { return failure('storage_failure', 'Could not read the clock. Try again.'); }
    attempt = Object.freeze({ sessionId: session.id, eventId: session.eventId, frame: session.frame,
      baseline: session.baseline, count, at });
    let award: StoredBingoAward;
    try { award = store.declareBingoDirectly(attempt.baseline, attempt.count, attempt.at); }
    catch { return resolveAttempt(); }
    return finish(award);
  });

  // The coordinator owns status validation, ID rotation, notification and fresh playback. IPC only dispatches
  // one explicit action, then reads the authoritative award; failed readback never permits a second action.
  const manual = (dispatch: (id: string) => void | boolean) => (_event: BingoRequest, ...args: unknown[]): BingoResult => {
    if (args.length !== 1 || !text(args[0])) return invalid();
    if (ports.tongoPlaying?.()) return failure('tongo_active', 'Wait for Tongo to finish, then try again.');
    if (ports.presentationBusy?.()) return failure('presentation_busy', 'Wait for the celebration to finish first.');
    try {
      if (dispatch(args[0]) === false) {
        return failure('presentation_refused', 'The Bingo presentation cannot be started now.');
      }
    } catch { return failure('storage_failure', 'Could not start the Bingo presentation. Try again.'); }
    try {
      const award = store.loadBingoAward();
      if (award !== null) return { ok: true, state: 'declared', award: structuredClone(award) };
    } catch { /* A successful action with unreadable state is not permission to replay it. */ }
    return unreadable();
  };
  // Resolve mutable ports at invocation time, not registration: main composition installs them later.
  handle(BINGO_CHANNELS.retryPresentation, manual(id => ports.retry ? ports.retry(id) : false));
  handle(BINGO_CHANNELS.repeatPresentation, manual(id => ports.repeat ? ports.repeat(id) : false));

  return { active: (): boolean => processing || session !== null || attempt !== null || legacyAttempt !== null };
}
