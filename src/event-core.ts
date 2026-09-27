import type { GamePhase } from './game-phase';

export interface EventSnapshot {
  readonly calledNumbers: readonly number[];
}

function assertEventDrawAllowed(event: EventSnapshot): void {
  if ('phase' in event) {
    const phase = event.phase as GamePhase;
    if (phase !== 'drawing' && phase !== 'line_declared') {
      throw new Error(`Draw not allowed in phase ${phase}`);
    }
  }
}

export function createEvent(): EventSnapshot {
  return { calledNumbers: [] };
}

export function drawManual<T extends EventSnapshot>(event: T, number: number): Omit<T, 'calledNumbers'> & EventSnapshot {
  assertEventDrawAllowed(event);
  if (!Number.isInteger(number) || number < 1 || number > 90) {
    throw new RangeError('Invalid number: expected an integer from 1 to 90');
  }
  if (event.calledNumbers.length === 90) {
    throw new Error('Event exhausted: all numbers have been called');
  }
  if (event.calledNumbers.includes(number)) {
    throw new Error(`Number ${number} already called`);
  }
  return { ...event, calledNumbers: [...event.calledNumbers, number] };
}

export function drawDigital<T extends EventSnapshot>(event: T, random: () => number): Omit<T, 'calledNumbers'> & EventSnapshot {
  assertEventDrawAllowed(event);
  if (event.calledNumbers.length === 90) {
    throw new Error('Event exhausted: all numbers have been called');
  }
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Invalid random value: expected a finite value in [0, 1)');
  }
  const called = new Set(event.calledNumbers);
  const remaining = Array.from({ length: 90 }, (_, index) => index + 1)
    .filter((number) => !called.has(number));
  return drawManual(event, remaining[Math.floor(value * remaining.length)]);
}
