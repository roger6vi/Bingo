import type { EventSnapshot } from './event-core';
import type { EventPrizes } from './event-prizes';
import type { StoredLineAward } from './event-store';
import type { LotResolution } from './line-award';
import type { GamePhase } from './game-phase';
import type { ThemeId } from './theme';
import type { TongoPresentation } from './tongo-ipc';

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

export const PUBLIC_EVENT_CHANNEL = 'public:event-state';
export const PUBLIC_THEME_CHANNEL = 'public:theme';
export const PUBLIC_META_CHANNEL = 'public:event-meta';
export const PUBLIC_PRESENTATION_CHANNEL = 'public:presentation';
export const PUBLIC_PRIZES_CHANNEL = 'public:event-prizes';
export const PUBLIC_LINE_AWARD_CHANNEL = 'public:line-award';

// The active event's committed name, date, and place; null when it cannot be read.
export type PublicEventMeta = { readonly name: string; readonly date: string; readonly place: string } | null;
// The active event's committed prizes; null when they cannot be read.
export type PublicEventPrizes = EventPrizes | null;
// The active event's committed first-line award as static state; null when absent or unreadable. It carries no
// presentation identity or timing, so it can never start, resume, or imply a finished celebration.
export type PublicLineAward = {
  readonly eventId: string; readonly winnerCount: number; readonly totalCents: number; readonly shareCents: number;
  readonly remainderCents: number; readonly lot: string; readonly lotResolution: LotResolution;
} | null;
type CommittedLineAward = Pick<StoredLineAward, 'eventId' | 'award'> | null;
type Payload = PublicEventResult | ThemeId | PublicEventMeta | PublicEventPrizes | PublicLineAward | TongoPresentation;

export type PublicEventResult =
  | { ok: true; snapshot: PhaseSnapshot; eventChanged?: true }
  | { ok: false; code: 'event_unavailable' | 'storage_failure'; message: string };

type Store = { load(): PhaseSnapshot | null };
type Target = {
  isDestroyed(): boolean;
  send(channel: string, result: Payload): void;
};

const success = (snapshot: PhaseSnapshot): PublicEventResult => ({
  ok: true, snapshot: {
    calledNumbers: [...snapshot.calledNumbers], phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt,
  },
});

export function createPublicEventDelivery(
  store: Store, committedTheme?: () => ThemeId, committedMeta?: () => PublicEventMeta,
  committedPrizes?: () => PublicEventPrizes, committedLineAward?: () => CommittedLineAward,
) {
  let current: Target | null = null;

  function send(target: Target, result: Payload, channel = PUBLIC_EVENT_CHANNEL): void {
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

  function loadMeta(): PublicEventMeta {
    try {
      const meta = committedMeta?.() ?? null;
      return meta === null ? null : { name: meta.name, date: meta.date, place: meta.place };
    } catch { return null; }
  }

  function loadPrizes(): PublicEventPrizes {
    try {
      const prizes = committedPrizes?.() ?? null;
      return prizes === null ? null : { line: { ...prizes.line }, bingo: { ...prizes.bingo } };
    } catch { return null; }
  }

  function loadLineAward(): PublicLineAward {
    try {
      const stored = committedLineAward?.() ?? null;
      if (stored === null) return null;
      const { winnerCount, totalCents, shareCents, remainderCents, lot, lotResolution } = stored.award;
      return { eventId: stored.eventId, winnerCount, totalCents, shareCents, remainderCents, lot, lotResolution };
    } catch { return null; }
  }

  // Sends the metadata unless the target was replaced or closed; reports whether it is still current.
  function sendMeta(target: Target): boolean {
    if (committedMeta !== undefined) send(target, loadMeta(), PUBLIC_META_CHANNEL);
    return current === target;
  }

  function sendPrizes(target: Target): boolean {
    if (committedPrizes !== undefined) send(target, loadPrizes(), PUBLIC_PRIZES_CHANNEL);
    return current === target;
  }

  function sendLineAward(target: Target): boolean {
    if (committedLineAward !== undefined) send(target, loadLineAward(), PUBLIC_LINE_AWARD_CHANNEL);
    return current === target;
  }

  return {
    attachAfterLoad(target: Target): void {
      if (target.isDestroyed()) return;
      current = target;
      // Theme first, so the page is revealed in the committed theme.
      if (committedTheme !== undefined) send(target, committedTheme(), PUBLIC_THEME_CHANNEL);
      if (current !== target || !sendMeta(target) || !sendPrizes(target) || !sendLineAward(target)) return;
      const result = loadResult();
      // A reentrant load may have replaced or closed this target.
      if (current === target) send(target, result);
    },
    detachIfCurrent(target: Target): void {
      if (current === target) current = null;
    },
    publishCommitted(snapshot: PhaseSnapshot): void {
      const target = current;
      if (target === null || !sendLineAward(target)) return;
      send(target, success(snapshot));
    },
    publishTheme(theme: ThemeId): void {
      if (current !== null) send(current, theme, PUBLIC_THEME_CHANNEL);
    },
    // After the active event's name, date, or place commit.
    publishMeta(): void {
      if (current !== null) sendMeta(current);
    },
    // After the active event's prizes commit.
    publishPrizes(): void {
      if (current !== null) sendPrizes(current);
    },
    // Transient and never resent on attach, so a reloaded or reopened window cannot replay it.
    // Reports whether the current window accepted it.
    publishPresentation(presentation: TongoPresentation): boolean {
      const target = current;
      if (target === null) return false;
      send(target, presentation, PUBLIC_PRESENTATION_CHANNEL);
      return current === target;
    },
    // After the active event changes, resend its theme, metadata, prizes, and committed state in reveal order.
    publishActive(theme: ThemeId): void {
      const target = current;
      if (target === null) return;
      send(target, theme, PUBLIC_THEME_CHANNEL);
      if (current !== target || !sendMeta(target) || !sendPrizes(target) || !sendLineAward(target)) return;
      const result = loadResult();
      // A different event's history is not a continuation of the one on screen.
      if (current === target) send(target, result.ok ? { ...result, eventChanged: true } : result);
    },
  };
}
