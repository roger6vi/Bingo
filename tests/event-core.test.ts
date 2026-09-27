import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent, drawManual, drawDigital, type EventSnapshot } from '../src/event-core.ts';
import { GAME_PHASES } from '../src/game-phase.ts';

function assertFailureUnchanged(event: EventSnapshot, action: () => unknown, error: RegExp) {
  const before = [...event.calledNumbers];
  const original = event.calledNumbers;
  assert.throws(action, error);
  assert.equal(event.calledNumbers, original);
  assert.deepEqual(event.calledNumbers, before);
}

test('a new event has no called numbers, and manual draws return ordered new snapshots', () => {
  const initial = createEvent();
  assert.deepEqual(initial.calledNumbers, []);
  const first = drawManual(initial, 90);
  const second = drawManual(first, 1);
  assert.deepEqual(initial.calledNumbers, []);
  assert.deepEqual(first.calledNumbers, [90]);
  assert.deepEqual(second.calledNumbers, [90, 1]);
  assert.notEqual(first, initial);
  assert.notEqual(second, first);
});

test('manual draws accept both boundaries and every integer in between', () => {
  let event = createEvent();
  for (let number = 1; number <= 90; number++) {
    event = drawManual(event, number);
  }
  assert.deepEqual(event.calledNumbers, Array.from({ length: 90 }, (_, index) => index + 1));
});

test('manual draws reject out-of-range and non-integer values without changing input', () => {
  const event = drawManual(createEvent(), 42);
  for (const number of [0, -1, 91, 1.5, NaN, Infinity, -Infinity]) {
    assertFailureUnchanged(event, () => drawManual(event, number), /invalid number/i);
  }
});

test('duplicate manual draws fail without changing input', () => {
  const event = drawManual(drawManual(createEvent(), 90), 1);
  for (const number of [90, 1]) {
    assertFailureUnchanged(event, () => drawManual(event, number), /already called/i);
  }
});

test('digital draws select deterministic indices among remaining numbers in ascending order', () => {
  const initial = drawManual(drawManual(createEvent(), 1), 90);
  const first = drawDigital(initial, () => 0);
  const second = drawDigital(first, () => 0.5);
  const last = drawDigital(second, () => 0.9999999999999999);
  assert.deepEqual(initial.calledNumbers, [1, 90]);
  assert.deepEqual(first.calledNumbers, [1, 90, 2]);
  assert.deepEqual(second.calledNumbers, [1, 90, 2, 46]);
  assert.deepEqual(last.calledNumbers, [1, 90, 2, 46, 89]);
});

test('repeated digital draws call every number exactly once and exhaust the event', () => {
  let event = createEvent();
  for (let count = 0; count < 90; count++) {
    const previous = event;
    event = drawDigital(event, () => 0.9999999999999999);
    assert.equal(previous.calledNumbers.length, count);
  }
  assert.deepEqual(event.calledNumbers, Array.from({ length: 90 }, (_, index) => 90 - index));
  assert.equal(new Set(event.calledNumbers).size, 90);
  assertFailureUnchanged(event, () => drawDigital(event, () => 0), /exhausted/i);
  assertFailureUnchanged(event, () => drawManual(event, 1), /exhausted/i);
});

test('manual and digital draws preserve additional snapshot fields and input identity', () => {
  const audit = Object.freeze([{ kind: 'previous_transition' }]);
  const initial = Object.freeze({ calledNumbers: Object.freeze([1]), phase: 'line_declared' as const, audit });
  const manual = drawManual(initial, 2);
  const digital = drawDigital(initial, () => 0);
  for (const result of [manual, digital]) {
    assert.deepEqual(result.calledNumbers, [1, 2]);
    assert.equal(result.phase, 'line_declared');
    assert.equal(result.audit, audit);
    assert.notEqual(result, initial);
    assert.notEqual(result.calledNumbers, initial.calledNumbers);
  }
  assert.deepEqual(initial.calledNumbers, [1]);
});

for (const phase of GAME_PHASES) {
  const allowed = phase === 'drawing' || phase === 'line_declared';
  for (const method of ['manual', 'digital'] as const) {
    test(`${method} draw ${allowed ? 'accepts' : 'rejects'} ${phase} directly`, () => {
      const audit = Object.freeze([{ kind: 'existing' }]);
      const snapshot = Object.freeze({ calledNumbers: Object.freeze([3]), phase, audit });
      let randomCalls = 0;
      const draw = () => method === 'manual'
        ? drawManual(snapshot, 4)
        : drawDigital(snapshot, () => { randomCalls++; return 0; });
      if (allowed) {
        const result = draw();
        assert.deepEqual(result.calledNumbers, method === 'manual' ? [3, 4] : [3, 1]);
        assert.equal(result.phase, phase);
        assert.equal(result.audit, audit);
        assert.notEqual(result, snapshot);
        assert.equal(randomCalls, method === 'digital' ? 1 : 0);
      } else {
        assert.throws(draw, /draw not allowed in phase/i);
        assert.equal(randomCalls, 0);
      }
      assert.deepEqual(snapshot, { calledNumbers: [3], phase, audit });
      assert.equal(snapshot.audit, audit);
    });
  }
}

test('phase-less snapshots retain both draw paths and their previous validation', () => {
  const snapshot = Object.freeze({ calledNumbers: Object.freeze([3]), tag: 'legacy' });
  assert.deepEqual(drawManual(snapshot, 4), { calledNumbers: [3, 4], tag: 'legacy' });
  assert.deepEqual(drawDigital(snapshot, () => 0), { calledNumbers: [3, 1], tag: 'legacy' });
  assertFailureUnchanged(snapshot, () => drawManual(snapshot, 0), /invalid number/i);
  assertFailureUnchanged(snapshot, () => drawDigital(snapshot, () => 1), /invalid random/i);
});

test('invalid injected random values fail without changing input', () => {
  const event = drawManual(createEvent(), 45);
  for (const value of [-0.01, 1, 2, NaN, Infinity, -Infinity]) {
    assertFailureUnchanged(event, () => drawDigital(event, () => value), /invalid random/i);
  }
});

test('a random source failure is propagated without changing input', () => {
  const event = drawManual(createEvent(), 45);
  assertFailureUnchanged(event, () => drawDigital(event, () => {
    throw new Error('random source failed');
  }), /random source failed/);
});
