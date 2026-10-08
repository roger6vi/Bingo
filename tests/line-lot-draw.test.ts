import assert from 'node:assert/strict';
import test from 'node:test';
import { participantColor } from '../src/line-lot-contract.ts';
import { drawLineLotParticipant } from '../src/line-lot-draw.ts';

const max = Number.MAX_SAFE_INTEGER;
const space = 2n ** 53n;

/** Encode a 53-bit candidate in 7 big-endian bytes; `noise` fills the 3 discarded high bits. */
function block(candidate: bigint, noise = 0): Uint8Array {
  const out = new Uint8Array(7);
  let rest = candidate;
  for (let i = 6; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  out[0] = (out[0] & 0x1f) | ((noise & 7) << 5);
  return out;
}

function scripted(blocks: unknown[]) {
  const sizes: number[] = [];
  let calls = 0;
  const entropy = (size: number) => {
    sizes.push(size);
    if (calls >= blocks.length) throw new Error('entropy exhausted');
    return blocks[calls++] as Uint8Array;
  };
  return { entropy, sizes, calls: () => calls };
}

test('count 1 always selects participant 1 with its mapped color', () => {
  for (const c of [0n, 12345n, space - 1n]) {
    const s = scripted([block(c)]);
    const result = drawLineLotParticipant(1, s.entropy);
    assert.deepEqual(result, { participantNumber: 1, colorId: 'red' });
    assert.equal(s.calls(), 1);
  }
});

test('candidate endpoints map to 1 and count', () => {
  assert.equal(drawLineLotParticipant(7, scripted([block(0n)]).entropy).participantNumber, 1);
  assert.equal(drawLineLotParticipant(7, scripted([block(6n)]).entropy).participantNumber, 7);
  assert.equal(drawLineLotParticipant(2, scripted([block(1n)]).entropy).participantNumber, 2);
});

test('the three high bits of the first byte are masked off', () => {
  const noisy = scripted([block(5n, 7)]);
  assert.equal(drawLineLotParticipant(1000, noisy.entropy).participantNumber, 6);
  assert.equal(drawLineLotParticipant(max, scripted([Uint8Array.of(0xe0, 0, 0, 0, 0, 0, 0)]).entropy).participantNumber, 1);
  assert.equal(drawLineLotParticipant(2, scripted([Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)]).entropy).participantNumber, 2);
});

test('count 3 rejects candidates at or above the unbiased limit, then accepts', () => {
  const limit = space - (space % 3n);
  assert.equal(limit, space - 2n);
  const s = scripted([block(limit), block(space - 1n, 7), block(1n)]);
  const result = drawLineLotParticipant(3, s.entropy);
  assert.equal(result.participantNumber, 2);
  assert.equal(s.calls(), 3);
  assert.equal(drawLineLotParticipant(3, scripted([block(limit - 1n)]).entropy).participantNumber, Number((limit - 1n) % 3n) + 1);
});

test('count 7 boundary around limit 2^53 - 4', () => {
  const limit = space - (space % 7n);
  assert.equal(limit, space - 4n);
  assert.equal(drawLineLotParticipant(7, scripted([block(limit - 1n)]).entropy).participantNumber, Number((limit - 1n) % 7n) + 1);
  const s = scripted([block(limit), block(space - 1n), block(8n)]);
  assert.equal(drawLineLotParticipant(7, s.entropy).participantNumber, 2);
  assert.equal(s.calls(), 3);
});

test('MAX_SAFE_INTEGER boundary: only candidate 2^53-1 is rejected', () => {
  const s = scripted([block(space - 1n), block(space - 2n)]);
  const result = drawLineLotParticipant(max, s.entropy);
  assert.equal(result.participantNumber, max);
  assert.equal(s.calls(), 2);
  assert.equal(drawLineLotParticipant(max, scripted([block(0n)]).entropy).participantNumber, 1);
});

test('colors repeat while participant number remains distinct', () => {
  const a = drawLineLotParticipant(20, scripted([block(0n)]).entropy);
  const b = drawLineLotParticipant(20, scripted([block(6n)]).entropy);
  assert.equal(a.colorId, b.colorId);
  assert.notEqual(a.participantNumber, b.participantNumber);
  for (const c of [0n, 5n, 6n, 19n]) {
    const r = drawLineLotParticipant(20, scripted([block(c)]).entropy);
    assert.equal(r.colorId, participantColor(r.participantNumber).id);
    assert.ok(r.participantNumber >= 1 && r.participantNumber <= 20);
  }
});

test('returned result is frozen and has exactly number and color', () => {
  const r = drawLineLotParticipant(3, scripted([block(0n)]).entropy);
  assert.ok(Object.isFrozen(r));
  assert.deepEqual(Object.keys(r).sort(), ['colorId', 'participantNumber']);
});

test('invalid counts are rejected before any entropy request', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, max + 1, '3', null, undefined, 3n, true]) {
    const s = scripted([block(0n)]);
    assert.throws(() => drawLineLotParticipant(bad as number, s.entropy), TypeError);
    assert.equal(s.calls(), 0);
    assert.deepEqual(s.sizes, []);
  }
});

test('entropy exceptions propagate without a winner', () => {
  const boom = new Error('entropy down');
  assert.throws(() => drawLineLotParticipant(5, () => { throw boom; }), boom);
  const s = scripted([block(space - 1n)]); // rejected for count max, then exhausted
  assert.throws(() => drawLineLotParticipant(max, s.entropy), /entropy exhausted/);
});

test('malformed entropy blocks fail closed without padding or truncation', () => {
  const bad: unknown[] = [
    undefined, null, [0, 0, 0, 0, 0, 0, 0], new ArrayBuffer(7), new DataView(new ArrayBuffer(7)),
    new Uint16Array(7),
  ];
  for (const b of bad) {
    assert.throws(() => drawLineLotParticipant(5, scripted([b]).entropy), TypeError);
  }
  for (const n of [0, 6, 8, 32]) {
    assert.throws(() => drawLineLotParticipant(5, scripted([new Uint8Array(n)]).entropy), RangeError);
  }
});

test('malformed block during a rejection retry also fails closed', () => {
  const s = scripted([block(space - 1n), new Uint8Array(6)]);
  assert.throws(() => drawLineLotParticipant(max, s.entropy), RangeError);
});

test('every entropy request is exactly 7 bytes and no count-sized allocation occurs', () => {
  const s = scripted([block(space - 1n), block(space - 2n)]);
  drawLineLotParticipant(max, s.entropy);
  assert.deepEqual(s.sizes, [7, 7]);
});

test('default crypto entropy returns a participant within range', () => {
  for (const count of [1, 6, max]) {
    const r = drawLineLotParticipant(count);
    assert.ok(Number.isSafeInteger(r.participantNumber));
    assert.ok(r.participantNumber >= 1 && r.participantNumber <= count);
    assert.equal(r.colorId, participantColor(r.participantNumber).id);
  }
});
