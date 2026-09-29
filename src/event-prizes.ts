// Per-event Línea and Bingo prizes: whole euros (0 means no money) plus one optional indivisible lot.
// Shared by the store and the IPC boundary; the renderer keeps an aligned copy of these rules.
export const MAX_PRIZE_AMOUNT = 100_000;
export const MAX_PRIZE_LOT = 120;
export const PRIZE_KINDS = Object.freeze(['line', 'bingo'] as const);

export type Prize = { readonly amount: number; readonly lot: string };
export type EventPrizes = { readonly line: Prize; readonly bingo: Prize };

export const NO_PRIZES: EventPrizes = Object.freeze({
  line: Object.freeze({ amount: 0, lot: '' }), bingo: Object.freeze({ amount: 0, lot: '' }),
});

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join() === keys;

export const validAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PRIZE_AMOUNT;
export const validLot = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length <= MAX_PRIZE_LOT;

function normalizePrize(value: unknown): Prize | null {
  if (!plain(value) || !exactKeys(value, 'amount,lot') || !validAmount(value.amount) || !validLot(value.lot)) return null;
  return Object.freeze({ amount: value.amount, lot: value.lot.trim() });
}

// Accepts only plain { line: { amount, lot }, bingo: { amount, lot } } records; returns trimmed, frozen copies.
export function normalizePrizes(value: unknown): EventPrizes | null {
  if (!plain(value) || !exactKeys(value, 'bingo,line')) return null;
  const line = normalizePrize(value.line);
  const bingo = normalizePrize(value.bingo);
  return line === null || bingo === null ? null : Object.freeze({ line, bingo });
}
