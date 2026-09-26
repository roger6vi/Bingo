import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicController } from '../src/public-controller.mjs';

type State = { loaded: boolean; calledNumbers: number[]; latest: number | null; count: number;
  remaining: number; stale: boolean; error: string | null };
const success = (calledNumbers: unknown) => ({ ok: true, snapshot: { calledNumbers } });
function fixture() {
  const renders: State[] = [];
  let listener: ((result: unknown) => void) | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const controller = createPublicController({ subscribe: (callback: (result: unknown) => void) => {
    subscriptions++;
    listener = callback;
    return () => { unsubscriptions++; listener = undefined; };
  } }, { render: (state: State) => { renders.push(structuredClone(state)); } });
  return { controller, renders, send: (result: unknown) => { assert.ok(listener); listener(result); },
    subscriptions: () => subscriptions, unsubscriptions: () => unsubscriptions,
    last: () => renders.at(-1)! };
}

test('renders waiting before subscribing once, then bootstraps empty and ordered full history', () => {
  const f = fixture();
  assert.deepEqual(f.renders, [{ loaded: false, calledNumbers: [], latest: null, count: 0,
    remaining: 90, stale: false, error: null }]);
  assert.equal(f.subscriptions(), 1);
  f.send(success([]));
  assert.deepEqual(f.last(), { loaded: true, calledNumbers: [], latest: null, count: 0,
    remaining: 90, stale: false, error: null });
  f.send(success([90, 3, 1]));
  assert.deepEqual(f.last(), { loaded: true, calledNumbers: [90, 3, 1], latest: 1, count: 3,
    remaining: 87, stale: false, error: null });
});

test('accepts identical histories and multi-number catch-up appends, never deriving latest from other fields', () => {
  const f = fixture();
  f.send({ ok: true, snapshot: { calledNumbers: [2], latest: 85 } });
  f.send(success([2]));
  f.send({ ok: true, snapshot: { calledNumbers: [2, 7, 9], latest: 88 } });
  assert.deepEqual(f.last().calledNumbers, [2, 7, 9]);
  assert.equal(f.last().latest, 9);
  assert.equal(f.last().error, null);
  assert.equal(f.renders.length, 4);
});

test('a sparse bootstrap cannot establish a loaded draw and recovers with dense history', () => {
  const f = fixture();
  const sparse: number[] = [];
  sparse.length = 2;
  sparse[1] = 7;
  assert.equal(Object.hasOwn(sparse, 0), false);
  f.send(success(sparse));
  assert.deepEqual(f.last(), { loaded: false, calledNumbers: [], latest: null, count: 0,
    remaining: 90, stale: false, error: 'Invalid public event update.' });
  f.send(success([7]));
  assert.deepEqual(f.last(), { loaded: true, calledNumbers: [7], latest: 7, count: 1,
    remaining: 89, stale: false, error: null });
});

test('sparse post-bootstrap append holes preserve the accepted draw until dense recovery', () => {
  const f = fixture();
  f.send(success([4, 8]));
  const sparse = [4, 8];
  sparse.length = 4;
  sparse[3] = 7;
  assert.equal(Object.hasOwn(sparse, 2), false);
  f.send(success(sparse));
  assert.deepEqual(f.last(), { loaded: true, calledNumbers: [4, 8], latest: 8, count: 2,
    remaining: 88, stale: true, error: 'Invalid public event update.' });
  f.send(success([4, 8, 6, 7]));
  assert.deepEqual(f.last(), { loaded: true, calledNumbers: [4, 8, 6, 7], latest: 7, count: 4,
    remaining: 86, stale: false, error: null });
});

test('rejects malformed results and histories without replacing an accepted snapshot', () => {
  const invalid: unknown[] = [null, [], 'text', 2, {}, { ok: false }, { ok: 1 },
    { ok: true }, { ok: true, snapshot: null }, { ok: true, snapshot: [] },
    success(null), success('1,2'), success([1, 1]), success([0]), success([91]),
    success([-1]), success([1.5]), success([NaN]), success([Infinity]), success([-Infinity]),
    success([new Number(1)]), success([1, '2']), success([1, undefined]),
    success(Array.from({ length: 91 }, (_, i) => i + 1))];
  const f = fixture();
  f.send(success([4, 8, 12]));
  for (const value of invalid) {
    f.send(value);
    assert.deepEqual(f.last().calledNumbers, [4, 8, 12]);
    assert.equal(f.last().latest, 12);
    assert.equal(f.last().count, 3);
    assert.equal(f.last().stale, true);
    assert.equal(f.last().error, 'Invalid public event update.');
  }
  f.send(success([4, 8, 12]));
  assert.equal(f.last().stale, false);
  assert.equal(f.last().error, null);
});

test('rejects truncation, reorder, divergent prefix and rewrites, then recovers by append', () => {
  const f = fixture();
  f.send(success([10, 20, 30]));
  for (const history of [[], [10, 20], [20, 10, 30], [10, 25, 30],
    [10, 20, 31, 40], [10, 20, 30, 30]]) {
    f.send(success(history));
    assert.deepEqual(f.last().calledNumbers, [10, 20, 30]);
    assert.equal(f.last().latest, 30);
    assert.equal(f.last().stale, true);
  }
  f.send(success([10, 20, 30, 40, 50]));
  assert.deepEqual(f.last().calledNumbers, [10, 20, 30, 40, 50]);
  assert.equal(f.last().latest, 50);
  assert.equal(f.last().stale, false);
});

test('before bootstrap invalid data cannot establish authority; valid failures use local text and recover', () => {
  const f = fixture();
  f.send(success([1, 1]));
  assert.equal(f.last().loaded, false);
  assert.equal(f.last().stale, false);
  assert.equal(f.last().error, 'Invalid public event update.');
  for (const code of ['event_unavailable', 'storage_failure']) {
    f.send({ ok: false, code, message: '<script>untrusted</script>' });
    assert.equal(f.last().loaded, false);
    assert.equal(f.last().stale, false);
    assert.equal(f.last().error?.includes('untrusted'), false);
  }
  f.send(success([90]));
  f.send({ ok: false, code: 'storage_failure', message: 'private detail' });
  assert.equal(f.last().loaded, true);
  assert.equal(f.last().stale, true);
  assert.deepEqual(f.last().calledNumbers, [90]);
  assert.equal(f.last().error?.includes('private detail'), false);
  f.send({ ok: false, code: 'other', message: 'bad' });
  assert.equal(f.last().error, 'Invalid public event update.');
  f.send({ ok: false, code: 'event_unavailable', message: 42 });
  assert.equal(f.last().error, 'Invalid public event update.');
  f.send(success([90]));
  assert.equal(f.last().stale, false);
  assert.equal(f.last().error, null);
});

test('copies input and view state, and cleanup unsubscribes exactly once', () => {
  const f = fixture();
  const history = [5];
  f.send(success(history));
  history.push(6);
  assert.deepEqual(f.last().calledNumbers, [5]);
  const rendered = f.renders.at(-1)!;
  rendered.calledNumbers.push(7);
  f.send(success([5, 8]));
  assert.deepEqual(f.last().calledNumbers, [5, 8]);
  f.controller.cleanup();
  f.controller.cleanup();
  assert.equal(f.unsubscriptions(), 1);
  assert.equal(f.subscriptions(), 1);
});

test('accepts all 90 unique calls but rejects overlength and duplicate full-history updates', () => {
  const f = fixture();
  const full = Array.from({ length: 90 }, (_, index) => index + 1);
  f.send(success(full));
  assert.equal(f.last().count, 90);
  assert.equal(f.last().remaining, 0);
  assert.equal(f.last().latest, 90);
  f.send(success([...full, 91]));
  assert.equal(f.last().count, 90);
  assert.equal(f.last().stale, true);
  f.send(success(full));
  assert.equal(f.last().stale, false);
});

test('a mutating view cannot modify controller history or future prefix decisions', () => {
  let receive!: (result: unknown) => void;
  const states: State[] = [];
  createPublicController({ subscribe: (callback: (result: unknown) => void) => {
    receive = callback;
    return () => {};
  } }, { render: (state: State) => {
    states.push(structuredClone(state));
    state.calledNumbers.push(89);
  } });
  receive(success([5]));
  receive(success([5, 6]));
  assert.deepEqual(states.at(-1)?.calledNumbers, [5, 6]);
  assert.equal(states.at(-1)?.latest, 6);
  assert.equal(states.at(-1)?.stale, false);
});
