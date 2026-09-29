import type { Prize } from './event-prizes';

// A first line validated outside the app: only the winner count and whether the prize's one
// indivisible lot still needs the shared manual tie draw (#61). No claimant data is ever stored.
export const MAX_LINE_WINNERS = 99;
export const LOT_DRAW_STATES = Object.freeze(['none', 'pending', 'resolved'] as const);

// 'none': nothing to draw (one winner, or no lot); 'pending': several winners share one lot.
export type LotDrawState = (typeof LOT_DRAW_STATES)[number];
export type LineAward = { readonly winners: number; readonly lotDraw: LotDrawState };

export const validWinners = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LINE_WINNERS;
export const validLotDraw = (value: unknown): value is LotDrawState =>
  typeof value === 'string' && (LOT_DRAW_STATES as readonly string[]).includes(value);

export function planLineAward(prize: Prize, winners: number): LineAward {
  if (!validWinners(winners)) throw new RangeError('Invalid winner count');
  return Object.freeze({ winners, lotDraw: winners > 1 && prize.lot !== '' ? 'pending' : 'none' });
}

// Money is divided directly between every winner in whole cents; the remainder is never randomized.
export function lineShare(prize: Prize, winners: number): { readonly cents: number; readonly remainderCents: number } {
  if (!validWinners(winners)) throw new RangeError('Invalid winner count');
  const total = prize.amount * 100;
  return Object.freeze({ cents: Math.floor(total / winners), remainderCents: total % winners });
}
