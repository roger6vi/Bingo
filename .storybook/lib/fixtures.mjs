// In-memory data for stories. Deterministic so stories, screenshots and a11y runs are reproducible.

/** A fixed shuffled draw order of 1–90 (Fisher–Yates over a small LCG). */
export const DRAW_ORDER = (() => {
  const numbers = Array.from({ length: 90 }, (_, index) => index + 1);
  let seed = 20260928;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let index = numbers.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [numbers[index], numbers[swap]] = [numbers[swap], numbers[index]];
  }
  return Object.freeze(numbers);
})();

export const draws = (count) => DRAW_ORDER.slice(0, count);

export const EVENTS = Object.freeze([
  { id: 'evt-primavera', name: 'Bingo solidario de primavera', date: '2026-10-03', place: 'Casal del barrio', active: true },
  { id: 'evt-sanroque', name: 'Fiestas de San Roque', date: '2026-08-16', place: 'Plaza Mayor', active: false },
  { id: 'evt-mayores', name: 'Tarde de bingo — Asociación de mayores', date: '2026-11-14', place: 'Centro cívico Norte', active: false },
  { id: 'evt-navidad', name: 'Bingo benéfico de Navidad', date: '2026-12-19', place: 'Polideportivo municipal', active: false },
]);

export const ACTIVE_EVENT = EVENTS[0];

export const LONG_EVENT = Object.freeze({
  id: 'evt-long', active: true, date: '2027-01-30',
  name: 'Gran bingo intergeneracional de la Asociación Cultural y Recreativa del Barrio de San Martín',
  place: 'Salón de actos del Centro Cultural Municipal Josefina Aldecoa, planta segunda',
});

export const PHASE_LABELS = Object.freeze({
  drawing: 'Drawing', checking_line: 'Checking line', line_declared: 'Line declared',
  checking_bingo: 'Checking bingo', bingo_declared: 'Bingo declared', finished: 'Finished',
});
