/** Palette v1 is persisted-contract data: never reorder or rename its IDs.
 * Labels are English defaults; presentation may translate them separately.
 */
export const LINE_LOT_PALETTE = Object.freeze({
  version: 1 as const,
  colors: Object.freeze([
    Object.freeze({ id: 'red', label: 'Red' } as const),
    Object.freeze({ id: 'blue', label: 'Blue' } as const),
    Object.freeze({ id: 'green', label: 'Green' } as const),
    Object.freeze({ id: 'yellow', label: 'Yellow' } as const),
    Object.freeze({ id: 'purple', label: 'Purple' } as const),
    Object.freeze({ id: 'orange', label: 'Orange' } as const),
  ]),
});

export type LineLotColor = (typeof LINE_LOT_PALETTE.colors)[number];
export type LineLotResult = Readonly<{
  participantNumber: number;
  colorId: LineLotColor['id'];
}>;
export type LineLotResolution =
  | Readonly<{ resolution: 'resolved'; result: LineLotResult }>
  | Readonly<{ resolution: 'pending' | 'not_required'; result: null }>;

function requirePositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

/** O(1), with no participant-sized allocation or count cap.
 * Colors repeat; participant number AND color identify the winner.
 */
export function participantColor(participantNumber: unknown): LineLotColor {
  requirePositiveSafeInteger(participantNumber, 'participantNumber');
  return LINE_LOT_PALETTE.colors[(participantNumber - 1) % LINE_LOT_PALETTE.colors.length];
}

/** Validate untrusted persisted fields, throwing on any inconsistent state.
 * The only canonical absent result is explicit null: missing/undefined fails.
 * Unknown resolutions fail closed. Extra result fields are discarded, and
 * returned values are detached and frozen so later input mutation is harmless.
 * This validates field invariants, not whether a draw was authorized or needed.
 */
export function parseLineLotResolution(
  winnerCount: unknown,
  resolution: unknown,
  result: unknown,
): LineLotResolution {
  requirePositiveSafeInteger(winnerCount, 'winnerCount');
  if (resolution === 'pending' || resolution === 'not_required') {
    if (result !== null) {
      throw new TypeError(`${resolution} result must be explicit null`);
    }
    return Object.freeze({ resolution, result: null });
  }
  if (resolution !== 'resolved') {
    throw new TypeError('Unknown line lot resolution');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new TypeError('Resolved result must be a participant/color object');
  }

  const candidate = result as Record<string, unknown>;
  const participantNumber = candidate.participantNumber;
  requirePositiveSafeInteger(participantNumber, 'participantNumber');
  if (participantNumber > winnerCount) {
    throw new RangeError('participantNumber must not exceed winnerCount');
  }
  const colorId = participantColor(participantNumber).id;
  if (candidate.colorId !== colorId) {
    throw new TypeError('Result colorId must match the participant mapping');
  }
  return Object.freeze({
    resolution,
    result: Object.freeze({ participantNumber, colorId }),
  });
}
