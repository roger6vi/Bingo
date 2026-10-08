import assert from 'node:assert/strict';
import test from 'node:test';
import { createBingoAward } from '../src/bingo-award.ts';
import { createLineAward } from '../src/line-award.ts';

const base = { winnerCount: 1, prizeEuros: 50, lot: '' };

test('defaults to a single winner share with no remainder or lot', () => {
  const award = createBingoAward(base);
  assert.deepEqual(award, {
    winnerCount: 1, totalCents: 5000, shareCents: 5000, remainderCents: 0, lot: '',
    lotResolution: 'not_required',
  });
  assert.ok(Object.isFrozen(award));
});

test('splits integer cents with an explicit unallocated remainder', () => {
  const award = createBingoAward({ winnerCount: 3, prizeEuros: 10, lot: '' });
  assert.equal(award.shareCents, 333);
  assert.equal(award.remainderCents, 1);
  assert.equal(award.shareCents * 3 + award.remainderCents, award.totalCents);
  assert.equal(createBingoAward({ ...base, winnerCount: 250 }).shareCents, 20);
  assert.equal(createBingoAward({ ...base, prizeEuros: 0 }).totalCents, 0);
  assert.equal(createBingoAward({ ...base, prizeEuros: 100000 }).totalCents, 10_000_000);
});

test('accepts large safe counts and rejects non-positive, fractional or unsafe counts', () => {
  assert.equal(createBingoAward({ ...base, winnerCount: 1000 }).winnerCount, 1000);
  for (const winnerCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2' as never]) {
    assert.throws(() => createBingoAward({ ...base, winnerCount }), /winner/i);
  }
});

test('rejects invalid prizes and lots', () => {
  for (const prizeEuros of [-1, 100001, 1.5, NaN, Infinity, '5' as never]) {
    assert.throws(() => createBingoAward({ ...base, prizeEuros }), /prize/i);
  }
  assert.throws(() => createBingoAward({ ...base, lot: 5 as never }), /lot/i);
  assert.throws(() => createBingoAward({ ...base, lot: 'x'.repeat(121) }), /lot/i);
});

test('trims lot; only a non-blank lot with two or more winners is pending', () => {
  assert.equal(createBingoAward({ ...base, lot: '  Basket  ' }).lot, 'Basket');
  assert.equal(createBingoAward({ ...base, lot: 'L' }).lotResolution, 'not_required');
  assert.equal(createBingoAward({ ...base, winnerCount: 2, lot: '   ' }).lotResolution, 'not_required');
  assert.equal(createBingoAward({ ...base, winnerCount: 2, lot: ' L ' }).lotResolution, 'pending');
  assert.equal(createBingoAward({ ...base, winnerCount: 2, prizeEuros: 0, lot: 'L' }).lotResolution, 'pending');
});

test('is identity-free and copy-safe: extra identity fields are never carried over', () => {
  const input = { winnerCount: 2, prizeEuros: 5, lot: 'A', name: 'Ana', cardId: 7, winners: ['x'] };
  const award = createBingoAward(input);
  assert.deepEqual(Object.keys(award).sort(),
    ['lot', 'lotResolution', 'remainderCents', 'shareCents', 'totalCents', 'winnerCount']);
  input.winnerCount = 9;
  assert.equal(award.winnerCount, 2);
  assert.throws(() => { (award as { lot: string }).lot = 'C'; }, TypeError);
});

test('reuses line award arithmetic exactly', () => {
  for (const winnerCount of [1, 2, 3, 7]) {
    const input = { winnerCount, prizeEuros: 13, lot: 'L' };
    assert.deepEqual(createBingoAward(input), createLineAward(input));
  }
});
