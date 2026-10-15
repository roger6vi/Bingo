import type { StoredLineAward } from './event-store.ts';

// Pure orchestration of one line presentation run: publish, wait for the renderer's start receipt, complete at the
// persisted deadline. No Electron, clock or timer is touched directly; everything arrives through ports. Nothing
// here retries or replays by itself, and no window concept exists, so only completion ever clears a running timer.
export const LINE_PRESENTATION_SIGNAL_MS = 4000;
const DEFAULT_ACK_TIMEOUT_MS = 2000;

export interface LinePresentationSignal {
  readonly kind: 'line';
  readonly id: string;
  readonly durationMs: typeof LINE_PRESENTATION_SIGNAL_MS;
}

export interface LinePresentationStore {
  startLinePresentation(id: string, startedAt: number): StoredLineAward;
  failLinePresentation(id: string): StoredLineAward;
  retryLinePresentation(id: string): StoredLineAward;
  replayLinePresentation(id: string): StoredLineAward;
  completeLinePresentation(id: string, now: number): StoredLineAward;
}

export interface PresentationPorts<Signal> {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Returns false when the signal could not be delivered to any renderer. */
  publish(signal: Signal): boolean;
  /** Called with the award read back after every store result. */
  notify(award: StoredLineAward | null): void;
  ackTimeoutMs?: number;
}
export type LinePresentationPorts = PresentationPorts<LinePresentationSignal>;

// Bingo reuses the same run over its own store methods and signal kind. Only an explicit fresh declaration may call
// begin: reads, hydration, restart, attach and event selection never do. Manual retry (failed) and replay
// (interrupted) follow the line's: the store validates and rotates the id, then the fresh id runs once.
export interface BingoPresentationSignal {
  readonly kind: 'bingo';
  readonly id: string;
  readonly durationMs: typeof LINE_PRESENTATION_SIGNAL_MS;
}
export interface BingoPresentationStore {
  startBingoPresentation(id: string, startedAt: number): StoredLineAward;
  failBingoPresentation(id: string): StoredLineAward;
  retryBingoPresentation(id: string): StoredLineAward;
  replayBingoPresentation(id: string): StoredLineAward;
  completeBingoPresentation(id: string, now: number): StoredLineAward;
}
export interface BingoPresentationCoordinator {
  begin(award: StoredLineAward): void;
  receiptStarted(id: string): boolean;
  /** Manual paths: store refusals and a busy coordinator throw; nothing is published or notified on a throw. */
  retry(id: string): void;
  repeat(id: string): void;
  busy(): boolean;
}
type RunSteps = Pick<LinePresentationStore, 'startLinePresentation' | 'failLinePresentation' | 'completeLinePresentation'>;

export interface LinePresentationCoordinator {
  begin(award: StoredLineAward): void;
  receiptStarted(id: string): boolean;
  /** Manual paths: store refusals and a busy coordinator throw; nothing is published or notified on a throw. */
  retry(id: string): void;
  repeat(id: string): void;
  busy(): boolean;
}

export function createBingoPresentationCoordinator(
  store: BingoPresentationStore, ports: PresentationPorts<BingoPresentationSignal>,
): BingoPresentationCoordinator {
  const run = createRun('bingo', {
    startLinePresentation: (id, at) => store.startBingoPresentation(id, at),
    failLinePresentation: (id) => store.failBingoPresentation(id),
    completeLinePresentation: (id, now) => store.completeBingoPresentation(id, now),
  }, ports);
  const manual = manualStep(run, 'Bingo');
  return {
    begin: run.begin, receiptStarted: run.receiptStarted, busy: run.busy,
    retry: (id) => manual((value) => store.retryBingoPresentation(value), id),
    repeat: (id) => manual((value) => store.replayBingoPresentation(value), id),
  };
}

export function createLinePresentationCoordinator(
  store: LinePresentationStore, ports: LinePresentationPorts,
): LinePresentationCoordinator {
  const run = createRun('line', store, ports);
  const manual = manualStep(run, 'Line');
  return {
    begin: run.begin, receiptStarted: run.receiptStarted, busy: run.busy,
    retry: (id) => manual((value) => store.retryLinePresentation(value), id),
    repeat: (id) => manual((value) => store.replayLinePresentation(value), id),
  };
}

// The shared manual mechanism: refuse while busy, let the store validate and rotate the id, report it, run it once.
function manualStep(run: ReturnType<typeof createRun>, label: 'Line' | 'Bingo') {
  return (step: (id: string) => StoredLineAward, id: string): void => {
    if (run.busy()) throw new Error(`${label} presentation is busy`);
    const next = step(id);
    run.notify(next);
    run.begin(next);
  };
}

function createRun<Kind extends 'line' | 'bingo'>(
  kind: Kind, store: RunSteps, ports: PresentationPorts<{ kind: Kind; id: string; durationMs: typeof LINE_PRESENTATION_SIGNAL_MS }>,
) {
  const ackTimeoutMs = ports.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const attempted = new Set<string>();
  // At most one run owns the coordinator; every callback checks it still owns the state before touching it.
  // The slot is reserved before any external call (publish, store, notify) and held until the run is terminal, so a
  // re-entrant callback can never start another run, of this kind or, through the shared wiring, the other one.
  let active: { phase: 'awaiting' | 'running'; id: string; timer: unknown } | null = null;

  // Async paths must never throw: a failing store or port is contained and reported as `null`.
  const guarded = (action: () => StoredLineAward): StoredLineAward | null => {
    try { return action(); } catch { return null; }
  };
  const safeNotify = (value: StoredLineAward | null): void => {
    try { ports.notify(value); } catch { /* the owner's failure must not break the run */ }
  };
  const safeCancel = (handle: unknown): void => {
    try { ports.cancel(handle); } catch { /* the timer is already dropped from our state */ }
  };
  const owns = (phase: 'awaiting' | 'running', id: string): boolean => active?.phase === phase && active.id === id;

  // Moves a pending award to failed (the manual retry path); null when even that is refused.
  function failStored(id: string): void {
    safeNotify(guarded(() => store.failLinePresentation(id)));
  }

  function onAckTimeout(id: string): void {
    if (!owns('awaiting', id)) return;
    active = null;
    failStored(id);
  }

  function armCompletion(id: string, deadlineAt: number): void {
    try {
      const timer = ports.schedule(() => complete(id, deadlineAt), Math.max(0, deadlineAt - ports.now()));
      active = { phase: 'running', id, timer };
    } catch {
      // A started row cannot fail; stop owning it and let the owner re-read (startup interruption handles the rest).
      active = null;
      safeNotify(null);
    }
  }

  function complete(id: string, deadlineAt: number): void {
    if (!owns('running', id)) return;
    // Still owned (no timer) while the clock and store run; released only once the run is over.
    active = { phase: 'running', id, timer: null };
    let now: number;
    try { now = ports.now(); } catch { active = null; safeNotify(null); return; }
    if (now < deadlineAt) { armCompletion(id, deadlineAt); return; }
    let completed: StoredLineAward;
    try {
      completed = store.completeLinePresentation(id, now);
    } catch (error) {
      // Matches the store's 'Line presentation deadline not reached' refusal: reschedule for the remainder.
      // Any other error stops the run after one notification.
      if (error instanceof Error && /deadline not reached/i.test(error.message)) { armCompletion(id, deadlineAt); return; }
      active = null;
      safeNotify(null);
      return;
    }
    active = null;
    safeNotify(completed);
  }

  function begin(award: StoredLineAward): void {
    const { id, status } = award.presentation;
    if (status !== 'pending' || attempted.has(id)) return;
    attempted.add(id);
    // Another run owns the renderer: never overwrite it. The new award fails and the operator retries later.
    if (active !== null) { failStored(id); return; }
    active = { phase: 'awaiting', id, timer: null };
    let delivered = false;
    try { delivered = ports.publish({ kind, id, durationMs: LINE_PRESENTATION_SIGNAL_MS }); } catch { /* undelivered */ }
    if (delivered && owns('awaiting', id)) {
      try {
        const timer = ports.schedule(() => onAckTimeout(id), ackTimeoutMs);
        if (owns('awaiting', id)) active = { phase: 'awaiting', id, timer };
        return;
      } catch { /* fails below */ }
    }
    if (!owns('awaiting', id)) return;
    active = null;
    failStored(id);
  }

  function receiptStarted(id: string): boolean {
    if (!owns('awaiting', id)) return false;
    safeCancel(active?.timer);
    // Kept as a running run without a timer across the start, its notification and the rearm.
    active = { phase: 'running', id, timer: null };
    // A refused start (bad clock, stale row) must not strand the pending row: fail it for the manual retry path.
    let started: StoredLineAward | null = null;
    try { started = store.startLinePresentation(id, ports.now()); } catch { /* handled below */ }
    if (started === null) { active = null; failStored(id); return false; }
    safeNotify(started);
    if (started.presentation.deadlineAt === null) { active = null; return true; }
    armCompletion(id, started.presentation.deadlineAt);
    return true;
  }

  return { begin, receiptStarted, busy: () => active !== null, notify: safeNotify };
}
