import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINE_LOT_PALETTE,
  participantColor,
  parseLineLotResolution,
} from '../src/line-lot-contract.ts';

const max = Number.MAX_SAFE_INTEGER;
const invalidIntegers = [0, -1, 1.5, NaN, Infinity, -Infinity, max + 1, '1', null, undefined, true, 1n];

function resultFor(participantNumber: number) {
  return { participantNumber, colorId: participantColor(participantNumber).id };
}

test('palette v1 has stable English IDs and labels and is deeply immutable', () => {
  assert.equal(LINE_LOT_PALETTE.version, 1);
  assert.deepEqual(LINE_LOT_PALETTE.colors, [
    { id: 'red', label: 'Red' },
    { id: 'blue', label: 'Blue' },
    { id: 'green', label: 'Green' },
    { id: 'yellow', label: 'Yellow' },
    { id: 'purple', label: 'Purple' },
    { id: 'orange', label: 'Orange' },
  ]);
  assert.ok(Object.isFrozen(LINE_LOT_PALETTE));
  assert.ok(Object.isFrozen(LINE_LOT_PALETTE.colors));
  for (const color of LINE_LOT_PALETTE.colors) assert.ok(Object.isFrozen(color));
  assert.throws(() => { LINE_LOT_PALETTE.colors[0].label = 'Changed'; }, TypeError);
});

test('participant mapping is one-based, deterministic and permits repeated colors', () => {
  const size = LINE_LOT_PALETTE.colors.length;
  for (let number = 1; number <= size * 2; number++) {
    assert.equal(participantColor(number), LINE_LOT_PALETTE.colors[(number - 1) % size]);
    assert.equal(participantColor(number), participantColor(number));
  }
  assert.equal(participantColor(1), participantColor(size + 1));
  const first = parseLineLotResolution(size + 1, 'resolved', resultFor(1));
  const repeated = parseLineLotResolution(size + 1, 'resolved', resultFor(size + 1));
  assert.notDeepEqual(first.result, repeated.result);
  assert.equal(first.result?.colorId, repeated.result?.colorId);
});

test('maximum safe integer works without allocating participants or imposing a cap', () => {
  assert.equal(participantColor(max), LINE_LOT_PALETTE.colors[(max - 1) % LINE_LOT_PALETTE.colors.length]);
  assert.deepEqual(parseLineLotResolution(max, 'resolved', resultFor(max)), {
    resolution: 'resolved', result: resultFor(max),
  });
  assert.equal(parseLineLotResolution(max, 'pending', null).result, null);
});

test('participant numbers reject unsafe integers and other types', () => {
  for (const value of invalidIntegers) {
    assert.throws(() => participantColor(value), /positive safe integer/);
  }
});

test('winner count is checked in every state, even without a result', () => {
  for (const winnerCount of invalidIntegers) {
    for (const state of ['pending', 'not_required', 'resolved']) {
      assert.throws(() => parseLineLotResolution(winnerCount, state, state === 'resolved' ? resultFor(1) : null),
        /winnerCount.*positive safe integer/);
    }
  }
});

test('resolved results must contain a positive safe participant within the winner count', () => {
  for (const participantNumber of [...invalidIntegers, 3]) {
    assert.throws(() => parseLineLotResolution(2, 'resolved', { participantNumber, colorId: 'red' }));
  }
  assert.deepEqual(parseLineLotResolution(2, 'resolved', resultFor(2)).result, resultFor(2));
});

test('result color must match the stable mapping exactly', () => {
  for (const colorId of ['blue', 'Red', 'unknown', '', 1, null, undefined, {}, ['red']]) {
    assert.throws(() => parseLineLotResolution(2, 'resolved', { participantNumber: 1, colorId }), /colorId/);
  }
});

test('resolved rejects null, missing, malformed and array results', () => {
  const malformed = [null, undefined, false, 1, 'red', [], [resultFor(1)], {},
    { participantNumber: 1 }, { colorId: 'red' }, { number: 1, color: 'red' }];
  for (const result of malformed) {
    assert.throws(() => parseLineLotResolution(2, 'resolved', result));
  }
});

test('pending and not_required have exactly one no-result representation: explicit null', () => {
  for (const state of ['pending', 'not_required']) {
    const canonical = parseLineLotResolution(2, state, null);
    assert.deepEqual(canonical, { resolution: state, result: null });
    assert.ok(Object.isFrozen(canonical));
    for (const result of [undefined, {}, [], false, resultFor(1)]) {
      assert.throws(() => parseLineLotResolution(2, state, result), /null/);
    }
  }
});

test('unknown resolution states fail closed', () => {
  for (const state of ['RESOLVED', '', 'unknown', null, undefined, 0, {}, ['pending']]) {
    assert.throws(() => parseLineLotResolution(2, state, null), /resolution/);
    assert.throws(() => parseLineLotResolution(2, state, resultFor(1)), /resolution/);
  }
});

test('canonical resolved values are detached and frozen, with no untrusted extra fields', () => {
  const input = { ...resultFor(1), extra: { mutable: true } };
  const canonical = parseLineLotResolution(2, 'resolved', input);
  assert.notEqual(canonical.result, input);
  assert.deepEqual(canonical, { resolution: 'resolved', result: resultFor(1) });
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.result));
  input.participantNumber = 2;
  input.colorId = 'blue';
  input.extra.mutable = false;
  assert.deepEqual(canonical.result, resultFor(1));
  assert.throws(() => { (canonical.result as { participantNumber: number }).participantNumber = 2; }, TypeError);
});

test('canonicalization remains consistent when parsed again', () => {
  for (const state of ['pending', 'not_required', 'resolved']) {
    const first = parseLineLotResolution(1, state, state === 'resolved' ? resultFor(1) : null);
    const second = parseLineLotResolution(1, first.resolution, first.result);
    assert.deepEqual(second, first);
    assert.notEqual(second, first);
    if (first.result) assert.notEqual(second.result, first.result);
  }
});
