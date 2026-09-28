// Renderer copy of the prize rules in event-prizes.ts (renderer modules cannot import the main-process
// TypeScript): whole euros 0–100 000 (0 means no money) and one optional lot of up to 120 characters.
export const MAX_PRIZE_AMOUNT = 100_000;
export const MAX_PRIZE_LOT = 120;
export const PRIZE_LABELS = Object.freeze({ line: 'Línea', bingo: 'Bingo' });

const validPrize = (prize) => prize !== null && typeof prize === 'object' && Number.isInteger(prize.amount) &&
  prize.amount >= 0 && prize.amount <= MAX_PRIZE_AMOUNT && typeof prize.lot === 'string' &&
  prize.lot.length <= MAX_PRIZE_LOT && prize.lot === prize.lot.trim();

// Committed (or, in the simulator, drafted) prizes; anything else is shown as unavailable.
export function validPrizes(prizes) {
  return prizes !== null && typeof prizes === 'object' && validPrize(prizes.line) && validPrize(prizes.bingo);
}

// 1500 → "1.500 €", with fixed grouping so the display never depends on the host locale data.
export const formatEuros = (amount) => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;

