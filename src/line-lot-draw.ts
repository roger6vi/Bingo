import { randomBytes } from 'node:crypto';
import { participantColor, type LineLotResult } from './line-lot-contract.ts';

export type LineLotEntropy = (size: number) => Uint8Array;

const BLOCK_BYTES = 7; // 56 bits; the 3 high bits are discarded to leave 53.
const HIGH_BITS_MASK = 0x1f;
const SPACE = 2n ** 53n;

function readCandidate(block: unknown): bigint {
  if (!(block instanceof Uint8Array)) {
    throw new TypeError('Entropy block must be a Uint8Array');
  }
  if (block.length !== BLOCK_BYTES) {
    throw new RangeError(`Entropy block must be exactly ${BLOCK_BYTES} bytes`);
  }
  let candidate = BigInt(block[0] & HIGH_BITS_MASK);
  for (let i = 1; i < BLOCK_BYTES; i++) {
    candidate = (candidate << 8n) | BigInt(block[i]);
  }
  return candidate;
}

/** Uniformly choose a participant number in 1..winnerCount by rejection sampling.
 * Uses fixed memory: each draw asks for one 7-byte block, and a candidate at or
 * above the largest multiple of the count below 2^53 is discarded to avoid
 * modulo bias. Color is derived only from the participant number.
 * Invalid counts fail before entropy is requested; entropy errors and malformed
 * blocks propagate without producing a winner.
 */
export function drawLineLotParticipant(
  winnerCount: unknown,
  entropy: LineLotEntropy = randomBytes,
): LineLotResult {
  if (typeof winnerCount !== 'number' || !Number.isSafeInteger(winnerCount) || winnerCount < 1) {
    throw new TypeError('winnerCount must be a positive safe integer');
  }
  const count = BigInt(winnerCount);
  const limit = SPACE - (SPACE % count);
  for (;;) {
    const candidate = readCandidate(entropy(BLOCK_BYTES));
    if (candidate >= limit) continue;
    const participantNumber = Number((candidate % count) + 1n);
    return Object.freeze({ participantNumber, colorId: participantColor(participantNumber).id });
  }
}
