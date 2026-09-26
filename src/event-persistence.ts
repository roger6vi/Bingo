import type { EventSnapshot } from './event-core';

export interface CurrentEventStore {
  load(): EventSnapshot | null;
  create(): EventSnapshot;
  close(): void;
}

export function initializeCurrentEvent<T extends CurrentEventStore>(store: T): { store: T; event: EventSnapshot } {
  try {
    const event = store.load() ?? store.create();
    return { store, event };
  } catch (error) {
    try { store.close(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
}
