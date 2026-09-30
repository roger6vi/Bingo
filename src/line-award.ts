// Pure first-line award rules. Amounts are integer cents; no storage, UI or identities.
export const MAX_PRIZE_EUROS = 100_000;
export const MAX_LOT_LENGTH = 120;

export type LotResolution = 'not_required' | 'pending' | 'resolved';

export interface LineAwardInput {
  readonly winnerCount: number;
  readonly prizeEuros: number;
  readonly lot: string;
}

export interface LineAward {
  readonly winnerCount: number;
  readonly totalCents: number;
  readonly shareCents: number;
  /** Cents left after equal shares; never assigned automatically. */
  readonly remainderCents: number;
  readonly lot: string;
  readonly lotResolution: LotResolution;
}

export function createLineAward(input: LineAwardInput): LineAward {
  const { winnerCount, prizeEuros, lot } = input;
  if (!Number.isSafeInteger(winnerCount) || winnerCount < 1) {
    throw new Error('Winner count must be a positive safe integer');
  }
  if (!Number.isInteger(prizeEuros) || prizeEuros < 0 || prizeEuros > MAX_PRIZE_EUROS) {
    throw new Error(`Prize must be an integer between 0 and ${MAX_PRIZE_EUROS} EUR`);
  }
  if (typeof lot !== 'string' || lot.trim().length > MAX_LOT_LENGTH) {
    throw new Error(`Lot must be text of at most ${MAX_LOT_LENGTH} characters`);
  }
  const totalCents = prizeEuros * 100;
  const remainderCents = totalCents % winnerCount;
  const trimmed = lot.trim();
  return Object.freeze({
    winnerCount,
    totalCents,
    shareCents: Math.floor(totalCents / winnerCount),
    remainderCents,
    lot: trimmed,
    // Only a lot shared by two or more winners needs the manual tie (#61); cash never does.
    lotResolution: trimmed !== '' && winnerCount >= 2 ? 'pending' : 'not_required',
  });
}

// Presentation is independent of lot resolution.
export type LinePresentationStatus = 'pending' | 'started' | 'failed' | 'completed';

export interface LinePresentationState {
  readonly status: LinePresentationStatus;
}

const presentationTransitions = {
  pending: { start: 'started', fail: 'failed' },
  started: { complete: 'completed' },
  failed: { retry: 'pending' },
  completed: {},
} as const satisfies Record<LinePresentationStatus, Record<string, LinePresentationStatus>>;

export type LinePresentationIntent = {
  [S in LinePresentationStatus]: keyof (typeof presentationTransitions)[S];
}[LinePresentationStatus];

export function createLinePresentation(): LinePresentationState {
  return Object.freeze({ status: 'pending' });
}

export function transitionLinePresentation(
  state: LinePresentationState, intent: LinePresentationIntent,
): LinePresentationState {
  const next = (presentationTransitions[state.status] as
    Partial<Record<LinePresentationIntent, LinePresentationStatus>>)[intent];
  if (next === undefined) {
    throw new Error(`Invalid presentation transition: ${state.status} via ${intent}`);
  }
  return Object.freeze({ status: next });
}

/** Drawing unlocks on completed presentation alone; a pending lot does not block it. */
export function canResumeDrawing(presentation: LinePresentationState): boolean {
  return presentation.status === 'completed';
}

/**
 * Bingo eligibility needs a completed presentation and an explicitly settled lot
 * (`not_required` or `resolved`); unknown values fail closed. Cash remainder never blocks.
 */
export function isLineDeliveryResolved(
  award: Pick<LineAward, 'lotResolution'>, presentation: LinePresentationState,
): boolean {
  const lotSettled = award.lotResolution === 'not_required' || award.lotResolution === 'resolved';
  return presentation.status === 'completed' && lotSettled;
}
