import type { EventSnapshot } from './event-core';

export const PUBLIC_EVENT_CHANNEL = 'public:event-state';

export type PublicEventResult =
  | { ok: true; snapshot: EventSnapshot }
  | { ok: false; code: 'event_unavailable' | 'storage_failure'; message: string };

type Store = { load(): EventSnapshot | null };
type Target = {
  isDestroyed(): boolean;
  send(channel: string, result: PublicEventResult): void;
};

const success = (snapshot: EventSnapshot): PublicEventResult =>
  ({ ok: true, snapshot: { calledNumbers: [...snapshot.calledNumbers] } });

export function createPublicEventDelivery(store: Store) {
  let current: Target | null = null;

  function send(target: Target, result: PublicEventResult): void {
    try {
      if (target.isDestroyed()) {
        if (current === target) current = null;
        return;
      }
      target.send(PUBLIC_EVENT_CHANNEL, result);
    } catch {
      if (current === target) current = null;
    }
  }

  return {
    attachAfterLoad(target: Target): void {
      if (target.isDestroyed()) return;
      current = target;
      let result: PublicEventResult;
      try {
        const snapshot = store.load();
        result = snapshot === null
          ? { ok: false, code: 'event_unavailable', message: 'No current event is available.' }
          : success(snapshot);
      } catch {
        result = { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' };
      }
      // A reentrant load may have replaced or closed this target.
      if (current === target) send(target, result);
    },
    detachIfCurrent(target: Target): void {
      if (current === target) current = null;
    },
    publishCommitted(snapshot: EventSnapshot): void {
      if (current !== null) send(current, success(snapshot));
    },
  };
}
