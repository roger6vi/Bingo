import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent, drawManual, drawDigital, type EventSnapshot } from '../src/event-core.ts';

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
