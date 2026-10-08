import type { EventSnapshot } from './event-core';
import type { EventPrizes } from './event-prizes';
import type { LineLotSnapshot, StoredLineAward } from './event-store';
import { parseLineLotResolution } from './line-lot-contract.ts';
import type { LotResolution } from './line-award';
import type { GamePhase } from './game-phase';
import type { ThemeId } from './theme';
import type { TongoPresentation } from './tongo-ipc';
import type { LinePresentationSignal } from './line-presentation';
import type { LineLotSignal } from './line-lot-presentation.ts';

type PhaseSnapshot = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

export const PUBLIC_EVENT_CHANNEL = 'public:event-state';
export const PUBLIC_THEME_CHANNEL = 'public:theme';
export const PUBLIC_META_CHANNEL = 'public:event-meta';
export const PUBLIC_PRESENTATION_CHANNEL = 'public:presentation';
export const PUBLIC_PRIZES_CHANNEL = 'public:event-prizes';
export const PUBLIC_LINE_AWARD_CHANNEL = 'public:line-award';
export const PUBLIC_LINE_LOT_CHANNEL = 'public:line-lot';
// Renderer -> main, the only send of the public window: the line overlay has actually started rendering.
export const PUBLIC_LINE_RECEIPT_CHANNEL = 'public:line-presentation-started';

// The active event's committed name, date, and place; null when it cannot be read.
export type PublicEventMeta = { readonly name: string; readonly date: string; readonly place: string } | null;
// The active event's committed prizes; null when they cannot be read.
export type PublicEventPrizes = EventPrizes | null;
// The active event's committed first-line award as static state; null when absent or unreadable. It carries no
// presentation identity or timing, so it can never start, resume, or imply a finished celebration.
export type PublicLineAward = {
  readonly eventId: string; readonly winnerCount: number; readonly totalCents: number; readonly shareCents: number;
  readonly remainderCents: number; readonly lot: string; readonly lotResolution: LotResolution;
  // The strict stored winner fact; present only when a strict lot loader is wired. Never inferred from arithmetic.
  readonly lotResult?: PublicLineLotResult;
} | null;
export type PublicLineLotResult =
  | { readonly origin: 'none'; readonly resolution: 'not_required' | 'pending' }
  | { readonly origin: 'legacy_v8'; readonly resolution: 'resolved'; readonly winner: 'unknown' }
  | { readonly origin: 'numbered_v1'; readonly resolution: 'resolved'; readonly paletteVersion: 1;
    readonly participantNumber: number; readonly colorId: string };
type CommittedLineAward = Pick<StoredLineAward, 'eventId' | 'award' | 'presentation'> | null;
type CommittedLineLot = Pick<LineLotSnapshot, 'eventId' | 'winnerCount' | 'lot' | 'presentation' | 'fact'> | null;
type Payload = PublicEventResult | ThemeId | PublicEventMeta | PublicEventPrizes | PublicLineAward | TongoPresentation
  | LinePresentationSignal | LineLotSignal;

export type PublicEventResult =
  | { ok: true; snapshot: PhaseSnapshot; eventChanged?: true }
  | { ok: false; code: 'event_unavailable' | 'storage_failure'; message: string };

type Store = { load(): PhaseSnapshot | null };
type Target = {
  isDestroyed(): boolean;
  send(channel: string, result: Payload): void;
  readonly mainFrame?: { readonly url: string } | null;
};

const success = (snapshot: PhaseSnapshot): PublicEventResult => ({
  ok: true, snapshot: {
    calledNumbers: [...snapshot.calledNumbers], phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt,
  },
});

// Copies the strict fact only when it matches the award's event, count, lot, presentation and resolution.
function strictLotResult(stored: NonNullable<CommittedLineAward>, snap: CommittedLineLot): PublicLineLotResult | null {
  if (snap === null || snap.eventId !== stored.eventId || snap.winnerCount !== stored.award.winnerCount ||
      snap.lot !== stored.award.lot || snap.presentation.id !== stored.presentation.id) return null;
  const fact = snap.fact;
  if (fact.resolution !== stored.award.lotResolution) return null;
  if (fact.origin === 'none') {
    return parseLineLotResolution(snap.winnerCount, fact.resolution, null).resolution === fact.resolution
      ? { origin: 'none', resolution: fact.resolution } : null;
  }
  if (fact.origin === 'legacy_v8') return fact.resolution === 'resolved' && fact.winner === 'unknown' ? { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' } : null;
  if (fact.origin !== 'numbered_v1' || fact.resolution !== 'resolved' || fact.paletteVersion !== 1 ||
      snap.lot === '' || snap.winnerCount < 2) return null;
  const parsed = parseLineLotResolution(snap.winnerCount, 'resolved',
    { participantNumber: fact.participantNumber, colorId: fact.colorId });
  return parsed.resolution === 'resolved'
    ? { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, ...parsed.result } : null;
}

export function createPublicEventDelivery(
  store: Store, committedTheme?: () => ThemeId, committedMeta?: () => PublicEventMeta,
  committedPrizes?: () => PublicEventPrizes, committedLineAward?: () => CommittedLineAward,
  committedLineLot?: () => CommittedLineLot,
) {
  let current: Target | null = null;
  // The one line signal whose receipt may still arrive: the exact window and main frame it was sent to.
  // Bumped whenever the attached document changes (attach or navigation), so a reattach of the same window and
  // frame during a static publication is still seen as a different document.
  let generation = 0;
  // Bumped on every active-event publication, before any callback runs, so a pending lot signal is cancelled even
  // when the event went away and back to the same current facts.
  let activeEpoch = 0;
  let lineBinding: { id: string; target: Target; frame: { readonly url: string } } | null = null;

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
      const award = { eventId: stored.eventId, winnerCount, totalCents, shareCents, remainderCents, lot, lotResolution };
      if (committedLineLot === undefined) return award;
      // Strict facts must describe the very same award; anything else clears it rather than show a stale winner.
      const lotResult = strictLotResult(stored, committedLineLot());
      return lotResult === null ? null : { ...award, lotResult };
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
      generation++;
      // Theme first, so the page is revealed in the committed theme.
      if (committedTheme !== undefined) send(target, committedTheme(), PUBLIC_THEME_CHANNEL);
      if (current !== target || !sendMeta(target) || !sendPrizes(target) || !sendLineAward(target)) return;
      const result = loadResult();
      // A reentrant load may have replaced or closed this target.
      if (current === target) send(target, result);
    },
    detachIfCurrent(target: Target): void {
      if (current === target) current = null;
      if (lineBinding?.target === target) lineBinding = null;
    },
    // The owning window's main frame began navigating (reload, same URL included). The frame object and URL may
    // survive it, so identity alone cannot tell documents apart: detach now, which voids any pending receipt and
    // keeps every send away from the loading page, and let the finished load re-attach static state only. The
    // coordinator's already-running deadline is not owned here and is untouched. Other windows are ignored.
    navigationStarted(target: Target): void {
      if (current !== target) return;
      current = null;
      generation++;
      lineBinding = null;
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
    // Static only: resends the strict award for the one authorized event after its lot result was verified. It
    // sends nothing when the window, event, or strict fact does not line up, so a stale page is never cleared, and
    // it never touches presentation channels, receipt bindings, or history.
    refreshLineAward(eventId: string): boolean {
      const target = current;
      if (target === null || committedLineAward === undefined) return false;
      const award = loadLineAward();
      if (award === null || award.eventId !== eventId) return false;
      send(target, award, PUBLIC_LINE_AWARD_CHANNEL);
      return current === target;
    },
    // Transient and never resent on attach, so a reloaded or reopened window cannot replay it.
    // Reports whether the current window accepted it.
    publishPresentation(presentation: TongoPresentation | LinePresentationSignal): boolean {
      const target = current;
      if (target === null) return false;
      if (presentation.kind !== 'line') {
        send(target, presentation, PUBLIC_PRESENTATION_CHANNEL);
        return current === target;
      }
      // A line signal is receipted only by the frame that is sent it, so capture that frame first. A window whose
      // frame cannot be read is not a delivery target, and any earlier binding is superseded either way.
      lineBinding = null;
      let frame: Target['mainFrame'];
      try { frame = target.mainFrame; } catch { return false; }
      send(target, presentation, PUBLIC_PRESENTATION_CHANNEL);
      if (current !== target) return false;
      if (frame !== undefined && frame !== null) lineBinding = { id: presentation.id, target, frame };
      return true;
    },
    // The manual lot result: its own transient channel, never the presentation or receipt path and never resent on
    // attach. The window, main frame and exact page URL are captured before the static award and history refresh;
    // all three and the attached document must be unchanged afterwards or the signal is dropped, never retried.
    publishLineLot(signal: LineLotSignal, expectedPublicUrl: string): boolean {
      const target = current;
      const epoch = generation;
      const active = activeEpoch;
      if (target === null) return false;
      let frame: { readonly url: string } | null | undefined;
      const live = (): boolean => {
        try {
          return current === target && generation === epoch && activeEpoch === active && !target.isDestroyed() &&
            target.mainFrame === frame && frame != null && frame.url === expectedPublicUrl;
        } catch { return false; }
      };
      try { frame = target.mainFrame; } catch { return false; }
      if (!live() || !sendLineAward(target) || !live()) return false;
      const result = loadResult();
      if (!live()) return false;
      send(target, result);
      if (!live()) return false;
      send(target, { id: signal.id, participantNumber: signal.participantNumber, colorId: signal.colorId }, PUBLIC_LINE_LOT_CHANNEL);
      return current === target;
    },
    // Authorizes one start receipt: the id must be the bound signal's, from the same window and the very frame it
    // was sent to, which must still be that window's current main frame at the exact page URL. Rejections keep
    // the binding; an accepted receipt consumes it, so the same signal can never be receipted twice.
    acceptLineReceipt(event: { sender: unknown; senderFrame?: unknown }, id: unknown, expectedUrl: string): boolean {
      const bound = lineBinding;
      try {
        if (bound === null || id !== bound.id || current !== bound.target || event.sender !== bound.target ||
            bound.target.isDestroyed() || event.senderFrame !== bound.frame || bound.target.mainFrame !== bound.frame ||
            bound.frame.url !== expectedUrl) return false;
      } catch { return false; }
      lineBinding = null;
      return true;
    },
    // After the active event changes, resend its theme, metadata, prizes, and committed state in reveal order.
    publishActive(theme: ThemeId): void {
      activeEpoch++;
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
