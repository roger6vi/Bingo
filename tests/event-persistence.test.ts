import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeCurrentEvent } from '../src/event-persistence.ts';

type Event = { calledNumbers: readonly number[] };

function store(initial: Event | null, failure?: 'load' | 'create') {
  const calls: string[] = [];
  const existing = {
    load(): Event | null {
      calls.push('load');
      if (failure === 'load') throw new Error('load failed');
      return initial;
    },
    create(): Event {
      calls.push('create');
      if (failure === 'create') throw new Error('create failed');
      return { calledNumbers: [] };
    },
    close(): void { calls.push('close'); },
  };
  return { existing, calls };
}

test('startup loads an existing current event without creating or closing it', () => {
  const fixture = store({ calledNumbers: [90, 1] });
  const initialized = initializeCurrentEvent(fixture.existing);
  assert.equal(initialized.store, fixture.existing);
  assert.deepEqual(initialized.event.calledNumbers, [90, 1]);
  assert.deepEqual(fixture.calls, ['load']);
});

test('startup explicitly creates a missing event exactly once', () => {
  const fixture = store(null);
  const initialized = initializeCurrentEvent(fixture.existing);
  assert.equal(initialized.store, fixture.existing);
  assert.deepEqual(initialized.event.calledNumbers, []);
  assert.deepEqual(fixture.calls, ['load', 'create']);
});

test('load failure closes the store, rethrows, and never creates', () => {
  const fixture = store(null, 'load');
  assert.throws(() => initializeCurrentEvent(fixture.existing), /load failed/);
  assert.deepEqual(fixture.calls, ['load', 'close']);
});

test('create failure closes the store and rethrows', () => {
  const fixture = store(null, 'create');
  assert.throws(() => initializeCurrentEvent(fixture.existing), /create failed/);
  assert.deepEqual(fixture.calls, ['load', 'create', 'close']);
});
