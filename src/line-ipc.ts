import { randomUUID } from 'node:crypto';
import type { EventSnapshot } from './event-core';
import type { GamePhase } from './game-phase';
import type { LineDeclarationBaseline, StoredLineAward } from './event-store';

export const LINE_CHANNELS = Object.freeze({
  begin: 'line:begin',
  read: 'line:read',
  cancel: 'line:cancel',
  confirm: 'line:confirm',
});

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

// What the dialog may see of the main-owned session; the baseline itself never leaves main.
export type LineSetupView = {
  sessionId: string;
  eventId: string;
  calledNumbers: number[];
  linePrize: { amount: number; lot: string };
};

export type LineResult =
  | { ok: true; session: LineSetupView }
  | { ok: true; state: 'setup'; session: LineSetupView }
  | { ok: true; state: 'declared'; award: StoredLineAward }
  | { ok: true; state: 'none' }
  | { ok: true; award: StoredLineAward }
  | { ok: true }
  | { ok: false; code: 'invalid_request' | 'not_available' | 'setup_active' | 'stale_session' | 'storage_failure';
    message: string };

type LineRequest = { sender: unknown; senderFrame: unknown };
type LineStore = {
  load(): PhaseSnapshot | null;
  loadLineAward(): StoredLineAward | null;
  loadLineDeclarationBaseline(): LineDeclarationBaseline;
  declareLineDirectly(expected: unknown, winnerCount: unknown, transitionAt: unknown): StoredLineAward;
};
type Registrar = {
  handle(channel: string, handler: (event: LineRequest, ...args: unknown[]) => LineResult): void;
};
type Ports = {
  authorize(event: LineRequest): void;
  now(): Date;
  // Best-effort delivery of the committed ordinary state; never undoes the declaration.
  publish?(snapshot: PhaseSnapshot): void;
};
type Session = { id: string; eventId: string; frame: unknown; baseline: LineDeclarationBaseline };

const failure = (code: Exclude<LineResult, { ok: true }>['code'], message: string): LineResult =>
  ({ ok: false, code, message });
const invalid = () => failure('invalid_request', 'Invalid line request.');
const stale = () => failure('stale_session', 'This setup is no longer current. Reopen it.');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;

const viewOf = (session: Session): LineSetupView => ({ sessionId: session.id, eventId: session.eventId,
  calledNumbers: [...session.baseline.calledNumbers], linePrize: { ...session.baseline.linePrize } });
const awardCopy = (award: StoredLineAward): StoredLineAward => structuredClone(award);

// Main owns one transient setup session. It is never persisted: the renderer only holds an opaque id, a reload
// keeps the session, and only the frame that explicitly adopted it may cancel or confirm it.
export function registerLineIpc(registrar: Registrar, store: LineStore, ports: Ports) {
  let session: Session | null = null;
  let confirming = false;

  const owned = (event: LineRequest, id: unknown, eventId: unknown): boolean =>
    session !== null && session.id === id && session.eventId === eventId && session.frame === event.senderFrame;

  // Acknowledge only a committed award, then publish the ordinary committed state.
  function committed(award: StoredLineAward): LineResult {
    session = null;
    try {
      const snapshot = store.load();
      if (snapshot !== null) ports.publish?.(snapshot);
    } catch { /* Delivery is best effort after persistence commits. */ }
    return { ok: true, award: awardCopy(award) };
  }

  registrar.handle(LINE_CHANNELS.begin, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return invalid();
    if (session !== null) return failure('setup_active', 'A first-line setup is already open. Reopen it to continue.');
    let baseline: LineDeclarationBaseline;
    try { baseline = store.loadLineDeclarationBaseline(); }
    catch { return failure('not_available', 'The first line cannot be declared now.'); }
    session = { id: randomUUID(), eventId: baseline.eventId, frame: event.senderFrame, baseline };
    return { ok: true, session: viewOf(session) };
  });

  // Recovery after a reload or an uncertain acknowledgement: committed state wins over any session, and an
  // open session is adopted by the current authorized frame.
  registrar.handle(LINE_CHANNELS.read, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 0) return invalid();
    if (confirming) return failure('stale_session', 'A confirmation is in progress. Try again.');
    let award: StoredLineAward | null;
    try { award = store.loadLineAward(); }
    catch { return failure('storage_failure', 'Could not read the first-line state. Try again.'); }
    if (award !== null) {
      session = null;
      return { ok: true, state: 'declared', award: awardCopy(award) };
    }
    if (session === null) return { ok: true, state: 'none' };
    session.frame = event.senderFrame;
    return { ok: true, state: 'setup', session: viewOf(session) };
  });

  registrar.handle(LINE_CHANNELS.cancel, (event, ...args) => {
    ports.authorize(event);
    if (args.length !== 2 || !text(args[0]) || !text(args[1])) return invalid();
    if (confirming || !owned(event, args[0], args[1])) return stale();
    session = null;
    return { ok: true };
  });

  registrar.handle(LINE_CHANNELS.confirm, (event, ...args) => {
    ports.authorize(event);
    const count = args[2];
    if (args.length !== 3 || !text(args[0]) || !text(args[1]) ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return invalid();
    if (confirming || !owned(event, args[0], args[1])) return stale();
    const current = session as Session;
    let at: string;
    try {
      const now = ports.now().getTime();
      const head = current.baseline.lastTransitionAt === null ? null : Date.parse(current.baseline.lastTransitionAt);
      at = new Date(head !== null && now <= head ? head + 1 : now).toISOString();
    } catch { return failure('storage_failure', 'Could not read the clock. Try again.'); }
    confirming = true;
    try {
      // A copy: the store recompares it with the authoritative state, so the session stays untouched.
      const baseline = { ...current.baseline, calledNumbers: [...current.baseline.calledNumbers],
        linePrize: { ...current.baseline.linePrize } };
      return committed(store.declareLineDirectly(baseline, count, at));
    } catch {
      // The acknowledgement is uncertain: reread the committed state; never declare again.
      try {
        const award = store.loadLineAward();
        if (award !== null && award.eventId === current.eventId) return committed(award);
      } catch { /* Keep the session so read can recover it. */ }
      return failure('storage_failure',
        'Could not declare the line. Reopen the setup and check the state before trying again.');
    } finally { confirming = false; }
  });

  return { active: (): boolean => session !== null };
}
