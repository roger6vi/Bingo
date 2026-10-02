import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLineAward, createLinePresentation, transitionLinePresentation,
  canResumeDrawing, isLineDeliveryResolved,
  type LinePresentationIntent, type LinePresentationStatus,
} from '../src/line-award.ts';

const base = { winnerCount: 1, prizeEuros: 10, lot: '' };

test('splits total cents by floor share and explicit unallocated remainder', () => {
  const award = createLineAward({ winnerCount: 3, prizeEuros: 10, lot: 'Hamper' });
  assert.deepEqual(award, {
    winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: 'Hamper',
    lotResolution: 'pending',
  });
  assert.equal(createLineAward({ winnerCount: 2, prizeEuros: 0, lot: 'L' }).lotResolution, 'pending');
  assert.ok(Object.isFrozen(award));
});

test('accepts winner counts beyond the 90 balls and zero or max prizes', () => {
  assert.equal(createLineAward({ ...base, winnerCount: 250 }).shareCents, 4);
  const zero = createLineAward({ ...base, prizeEuros: 0 });
  assert.equal(zero.totalCents, 0);
  assert.equal(zero.lotResolution, 'not_required');
  assert.equal(createLineAward({ ...base, prizeEuros: 0, lot: 'L' }).lotResolution, 'not_required');
  assert.equal(createLineAward({ ...base, prizeEuros: 100000 }).totalCents, 10_000_000);
  assert.equal(createLineAward({ ...base, winnerCount: 1 }).remainderCents, 0);
});

test('trims lot and rejects over 120 characters', () => {
  assert.equal(createLineAward({ ...base, lot: '  Basket  ' }).lot, 'Basket');
  assert.equal(createLineAward({ ...base, lot: ` ${'x'.repeat(120)} ` }).lot.length, 120);
  assert.throws(() => createLineAward({ ...base, lot: 'x'.repeat(121) }), /lot/i);
});

test('rejects invalid winner counts, prizes and lots', () => {
  for (const winnerCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2' as never]) {
    assert.throws(() => createLineAward({ ...base, winnerCount }), /winner/i);
  }
  for (const prizeEuros of [-1, 100001, 1.5, NaN, Infinity, '5' as never]) {
    assert.throws(() => createLineAward({ ...base, prizeEuros }), /prize/i);
  }
  assert.throws(() => createLineAward({ ...base, lot: 5 as never }), /lot/i);
});

test('frozen award is copy-safe against later input mutation', () => {
  const input = { winnerCount: 2, prizeEuros: 5, lot: 'A' };
  const award = createLineAward(input);
  input.winnerCount = 9; input.lot = 'B';
  assert.equal(award.winnerCount, 2);
  assert.equal(award.lot, 'A');
  assert.throws(() => { (award as { lot: string }).lot = 'C'; }, TypeError);
});

test('only a non-empty lot with two or more winners is a pending tie', () => {
  assert.equal(createLineAward({ ...base, lot: 'L' }).lotResolution, 'not_required');
  assert.equal(createLineAward({ winnerCount: 2, prizeEuros: 10, lot: 'L' }).lotResolution, 'pending');
  assert.equal(createLineAward({ winnerCount: 2, prizeEuros: 10, lot: '   ' }).lotResolution, 'not_required');
});

test('cash remainder is unallocated but never a tie nor a bingo blocker', () => {
  const award = createLineAward({ winnerCount: 3, prizeEuros: 10, lot: '' });
  assert.equal(award.remainderCents, 1);
  assert.equal(award.lotResolution, 'not_required');
  assert.equal(isLineDeliveryResolved(award, { status: 'completed' }), true);
});

const legal: readonly [LinePresentationStatus, LinePresentationIntent, LinePresentationStatus][] = [
  ['pending', 'start', 'started'],
  ['pending', 'fail', 'failed'],
  ['failed', 'retry', 'pending'],
  ['started', 'complete', 'completed'],
  ['started', 'interrupt', 'interrupted'],
];

test('presentation transitions follow the approved graph and stay immutable', () => {
  const initial = createLinePresentation();
  assert.deepEqual(initial, { status: 'pending' });
  for (const [from, intent, to] of legal) {
    const state = Object.freeze({ status: from });
    const result = transitionLinePresentation(state, intent);
    assert.deepEqual(result, { status: to });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(state, { status: from });
  }
});

test('all other presentation combinations reject, including failure after start', () => {
  const statuses: LinePresentationStatus[] = ['pending', 'started', 'failed', 'completed', 'interrupted'];
  const intents: LinePresentationIntent[] = ['start', 'fail', 'retry', 'complete', 'interrupt'];
  for (const status of statuses) for (const intent of intents) {
    if (legal.some(([f, i]) => f === status && i === intent)) continue;
    assert.throws(() => transitionLinePresentation({ status }, intent), /invalid presentation/i);
  }
});

test('drawing resumes once presentation completes even with a pending lot', () => {
  const award = createLineAward({ ...base, winnerCount: 2, lot: 'L' });
  assert.equal(award.lotResolution, 'pending');
  for (const status of ['pending', 'started', 'failed', 'interrupted'] as const) {
    assert.equal(canResumeDrawing({ status }), false);
  }
  assert.equal(canResumeDrawing({ status: 'completed' }), true);
  assert.equal(isLineDeliveryResolved(award, { status: 'completed' }), false);
  assert.equal(isLineDeliveryResolved({ ...award, lotResolution: 'resolved' }, { status: 'completed' }), true);
  assert.equal(isLineDeliveryResolved({ ...award, lotResolution: 'resolved' }, { status: 'started' }), false);
  // An interrupted run is neither complete nor resolved, whatever the lot says.
  assert.equal(isLineDeliveryResolved({ ...award, lotResolution: 'resolved' }, { status: 'interrupted' }), false);
  assert.equal(isLineDeliveryResolved({ lotResolution: 'not_required' }, { status: 'interrupted' }), false);
});

test('an interrupted presentation is terminal in this graph: it cannot complete, restart or fail', () => {
  assert.deepEqual(transitionLinePresentation({ status: 'started' }, 'interrupt'), { status: 'interrupted' });
  for (const intent of ['start', 'fail', 'retry', 'complete', 'interrupt'] as const) {
    assert.throws(() => transitionLinePresentation({ status: 'interrupted' }, intent), /invalid presentation/i, intent);
  }
  for (const status of ['pending', 'failed', 'completed'] as const) {
    assert.throws(() => transitionLinePresentation({ status }, 'interrupt'), /invalid presentation/i, status);
  }
});

test('delivery is unresolved for missing or unknown lot resolution values', () => {
  const done = { status: 'completed' } as const;
  for (const lotResolution of ['not_required', 'resolved'] as const) {
    assert.equal(isLineDeliveryResolved({ lotResolution }, done), true);
  }
  for (const lotResolution of [undefined, null, '', 'Pending', 'other', 0] as const) {
    assert.equal(isLineDeliveryResolved({ lotResolution } as never, done), false);
  }
  assert.equal(isLineDeliveryResolved({} as never, done), false);
  assert.equal(isLineDeliveryResolved({ lotResolution: 'resolved' }, { status: 'bogus' } as never), false);
});

test('the maximum safe winner count is valid with zero share and bounded remainder', () => {
  const award = createLineAward({ winnerCount: Number.MAX_SAFE_INTEGER, prizeEuros: 10, lot: 'L' });
  assert.equal(award.winnerCount, Number.MAX_SAFE_INTEGER);
  assert.equal(award.shareCents, 0);
  assert.equal(award.remainderCents, award.totalCents);
  assert.equal(award.lotResolution, 'pending');
});
