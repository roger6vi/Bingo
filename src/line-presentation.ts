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

export interface LinePresentationPorts {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Returns false when the signal could not be delivered to any renderer. */
  publish(signal: LinePresentationSignal): boolean;
  /** Called with the award read back after every store result. */
  notify(award: StoredLineAward | null): void;
  ackTimeoutMs?: number;
}

export interface LinePresentationCoordinator {
  begin(award: StoredLineAward): void;
  receiptStarted(id: string): boolean;
  /** Manual paths: store refusals and a busy coordinator throw; nothing is published or notified on a throw. */
  retry(id: string): void;
  repeat(id: string): void;
  busy(): boolean;
}

export function createLinePresentationCoordinator(
  store: LinePresentationStore, ports: LinePresentationPorts,
): LinePresentationCoordinator {
  const ackTimeoutMs = ports.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const attempted = new Set<string>();
  // At most one run owns the coordinator; every callback checks it still owns the state before touching it.
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
    active = null;
    let now: number;
    try { now = ports.now(); } catch { safeNotify(null); return; }
    if (now < deadlineAt) { armCompletion(id, deadlineAt); return; }
    try {
      safeNotify(store.completeLinePresentation(id, now));
    } catch (error) {
      // Matches the store's 'Line presentation deadline not reached' refusal: reschedule for the remainder.
      // Any other error stops the run after one notification.
      if (error instanceof Error && /deadline not reached/i.test(error.message)) { armCompletion(id, deadlineAt); return; }
      safeNotify(null);
    }
  }

  function begin(award: StoredLineAward): void {
    const { id, status } = award.presentation;
    if (status !== 'pending' || attempted.has(id)) return;
    attempted.add(id);
    // Another run owns the renderer: never overwrite it. The new award fails and the operator retries later.
    if (active !== null) { failStored(id); return; }
    let delivered = false;
    try { delivered = ports.publish({ kind: 'line', id, durationMs: LINE_PRESENTATION_SIGNAL_MS }); } catch { /* undelivered */ }
    if (!delivered) { failStored(id); return; }
    try {
      active = { phase: 'awaiting', id, timer: ports.schedule(() => onAckTimeout(id), ackTimeoutMs) };
    } catch {
      failStored(id);
    }
  }

  function receiptStarted(id: string): boolean {
    if (!owns('awaiting', id)) return false;
    safeCancel(active?.timer);
    active = null;
    // A refused start (bad clock, stale row) must not strand the pending row: fail it for the manual retry path.
    let started: StoredLineAward | null = null;
    try { started = store.startLinePresentation(id, ports.now()); } catch { /* handled below */ }
    if (started === null) { failStored(id); return false; }
    safeNotify(started);
    if (started.presentation.deadlineAt === null) return true;
    armCompletion(id, started.presentation.deadlineAt);
    return true;
  }

  function manual(step: (id: string) => StoredLineAward, id: string): void {
    if (active !== null) throw new Error('Line presentation is busy');
    const next = step(id);
    safeNotify(next);
    begin(next);
  }

  return {
    begin,
    receiptStarted,
    retry: (id) => manual((value) => store.retryLinePresentation(value), id),
    repeat: (id) => manual((value) => store.replayLinePresentation(value), id),
    busy: () => active !== null,
  };
}
