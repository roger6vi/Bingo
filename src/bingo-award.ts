// Pure Bingo award rules. Identity-free; share, remainder, lot and presentation semantics are the line ones.
import { createLineAward, type LineAward, type LineAwardInput } from './line-award.ts';

export type BingoAwardInput = LineAwardInput;
export type BingoAward = LineAward;

/**
 * Same validation and integer-cent split as the line award. Winner count is a positive safe integer;
 * a non-blank lot shared by two or more winners is `pending`, otherwise `not_required`.
 * Persisted line-delivery gating is storage's job; this function cannot know it.
 */
export function createBingoAward(input: BingoAwardInput): BingoAward {
  return createLineAward(input);
}
