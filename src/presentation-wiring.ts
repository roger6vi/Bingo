import type { StoredLineAward } from './event-store.ts';
import { createBingoPresentationCoordinator, createLinePresentationCoordinator, type BingoPresentationSignal,
  type BingoPresentationStore, type LinePresentationSignal, type LinePresentationStore } from './line-presentation.ts';

// Main's line and Bingo celebration wiring, free of Electron so it can be exercised directly. Each coordinator still
// owns its own active slot; this factory only makes the two kinds exclusive. A kind never publishes while the other
// one is active (its award then fails like any undelivered signal), and the manual line paths refuse before touching
// the store. Nothing here begins a Bingo: only an explicit fresh declaration may call `bingo.begin`.
export interface PresentationWiringPorts {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  publish(signal: LinePresentationSignal | BingoPresentationSignal): boolean;
  notifyLine(award: StoredLineAward | null): void;
  notifyBingo(award: StoredLineAward | null): void;
  /** The delivery's sender/frame/URL authorization for each kind's own receipt channel. */
  acceptLineReceipt(event: ReceiptEvent, id: string): boolean;
  acceptBingoReceipt(event: ReceiptEvent, id: string): boolean;
}
type ReceiptEvent = { sender: unknown; senderFrame?: unknown };

export function createPresentationWiring(store: LinePresentationStore & BingoPresentationStore, ports: PresentationWiringPorts) {
  const timers = { now: ports.now, schedule: ports.schedule, cancel: ports.cancel };
  const line = createLinePresentationCoordinator(store, { ...timers, notify: ports.notifyLine,
    publish: (signal) => !bingo.busy() && ports.publish(signal) });
  const bingo = createBingoPresentationCoordinator(store, { ...timers, notify: ports.notifyBingo,
    publish: (signal) => !line.busy() && ports.publish(signal) });
  // Same refusal as the line coordinator's own busy check: thrown before the store step, so nothing is mutated.
  const manual = (step: (id: string) => void) => (id: string): void => {
    if (bingo.busy()) throw new Error('Bingo presentation is busy');
    step(id);
  };
  return {
    line: { ...line, retry: manual(line.retry), repeat: manual(line.repeat) },
    bingo,
    // Any celebration on the public window: the shared guard for draws, Tongo, lot and event changes.
    busy: () => line.busy() || bingo.busy(),
    // Only a string id the delivery authorizes reaches the coordinator of that receipt's own kind.
    lineReceipt: (event: ReceiptEvent, id: unknown): boolean =>
      typeof id === 'string' && ports.acceptLineReceipt(event, id) && line.receiptStarted(id),
    bingoReceipt: (event: ReceiptEvent, id: unknown): boolean =>
      typeof id === 'string' && ports.acceptBingoReceipt(event, id) && bingo.receiptStarted(id),
  };
}
