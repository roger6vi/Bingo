import type { EventSnapshot } from './event-core';
import type { GamePhase } from './game-phase';
import type { ThemeId } from './theme';

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

export const PUBLIC_EVENT_CHANNEL = 'public:event-state';
export const PUBLIC_THEME_CHANNEL = 'public:theme';

export type PublicEventResult =
  | { ok: true; snapshot: PhaseSnapshot; eventChanged?: true }
  | { ok: false; code: 'event_unavailable' | 'storage_failure'; message: string };

type Store = { load(): PhaseSnapshot | null };
type Target = {
  isDestroyed(): boolean;
  send(channel: string, result: PublicEventResult | ThemeId): void;
};

const success = (snapshot: PhaseSnapshot): PublicEventResult => ({
  ok: true, snapshot: {
    calledNumbers: [...snapshot.calledNumbers], phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt,
  },
});

export function createPublicEventDelivery(store: Store, committedTheme?: () => ThemeId) {
  let current: Target | null = null;

  function send(target: Target, result: PublicEventResult | ThemeId, channel = PUBLIC_EVENT_CHANNEL): void {
    try {
      if (target.isDestroyed()) {
        if (current === target) current = null;
        return;
      }
      target.send(channel, result);
    } catch {
      if (current === target) current = null;
    }
  }

  function loadResult(): PublicEventResult {
    try {
      const snapshot = store.load();
      return snapshot === null
        ? { ok: false, code: 'event_unavailable', message: 'No current event is available.' }
        : success(snapshot);
    } catch {
      return { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' };
    }
  }

  return {
    attachAfterLoad(target: Target): void {
      if (target.isDestroyed()) return;
      current = target;
      // Theme first, so the page is revealed in the committed theme.
      if (committedTheme !== undefined) send(target, committedTheme(), PUBLIC_THEME_CHANNEL);
      if (current !== target) return;
      const result = loadResult();
      // A reentrant load may have replaced or closed this target.
      if (current === target) send(target, result);
    },
    detachIfCurrent(target: Target): void {
      if (current === target) current = null;
    },
    publishCommitted(snapshot: PhaseSnapshot): void {
      if (current !== null) send(current, success(snapshot));
    },
    publishTheme(theme: ThemeId): void {
      if (current !== null) send(current, theme, PUBLIC_THEME_CHANNEL);
    },
    // After the active event changes, resend its theme and committed state in reveal order.
    publishActive(theme: ThemeId): void {
      const target = current;
      if (target === null) return;
      send(target, theme, PUBLIC_THEME_CHANNEL);
      if (current !== target) return;
      const result = loadResult();
      // A different event's history is not a continuation of the one on screen.
      if (current === target) send(target, result.ok ? { ...result, eventChanged: true } : result);
    },
  };
}
