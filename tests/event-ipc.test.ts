import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEventIpc, EVENT_CHANNELS } from '../src/event-ipc.ts';
import { drawManual, drawDigital, type EventSnapshot } from '../src/event-core.ts';

const rules = { drawManual, drawDigital };

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;

function fixture(initial: readonly number[] | null = [90, 1], random = () => 0) {
  const sender = {}, frame = {}, other = {};
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let current: EventSnapshot | null = initial === null ? null : { calledNumbers: [...initial] };
  let failure: 'load' | 'update' | null = null;
  const store = {
    load(): EventSnapshot | null {
      calls.push('load');
      if (failure === 'load') throw new Error('secret read detail');
      return current;
    },
    update(transition: (event: EventSnapshot) => EventSnapshot): EventSnapshot {
      calls.push('update');
      if (current === null) throw new Error('missing event');
      const proposed = transition(current);
      if (failure === 'update') throw new Error('secret write detail');
      current = proposed;
      return { calledNumbers: [...proposed.calledNumbers] };
    },
  };
  registerEventIpc({ handle: (channel: string, handler: Handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, rules, random, sender, frame);
  const invoke = (channel: string, args: unknown[] = [], from = sender, fromFrame: object | null = frame) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler({ sender: from, senderFrame: fromFrame }, ...args);
  };
  return { invoke, calls, handlers, sender, frame, other, store,
    setFailure: (value: 'load' | 'update') => { failure = value; },
    snapshot: () => current?.calledNumbers };
}

const failure = (code: string, message: string) => ({ ok: false, code, message });

test('only three fixed channels are registered; get reads ordered persisted history and clones it', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], Object.values(EVENT_CHANNELS));
  const result = f.invoke(EVENT_CHANNELS.get);
  assert.deepEqual(result, { ok: true, snapshot: { calledNumbers: [90, 1] } });
  assert.deepEqual(f.calls, ['load']);
  assert.notEqual((result as { snapshot: EventSnapshot }).snapshot.calledNumbers, f.snapshot());
});

test('manual and digital draws acknowledge only the committed returned snapshot', () => {
  const f = fixture([90, 1], () => { f.calls.push('random'); return 0; });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [45]), { ok: true, snapshot: { calledNumbers: [90, 1, 45] } });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital), { ok: true, snapshot: { calledNumbers: [90, 1, 45, 2] } });
  assert.deepEqual(f.snapshot(), [90, 1, 45, 2]);
  assert.deepEqual(f.calls, ['update', 'update', 'random']);
});

test('wrong sender or wrong main frame rejects before touching store or randomness', () => {
  const f = fixture([1], () => { f.calls.push('random'); return 0; });
  for (const channel of Object.values(EVENT_CHANNELS)) {
    assert.throws(() => f.invoke(channel, channel === EVENT_CHANNELS.manual ? [2] : [], f.other), /unauthorized/i);
    assert.throws(() => f.invoke(channel, channel === EVENT_CHANNELS.manual ? [2] : [], f.sender, f.other), /unauthorized/i);
    assert.throws(() => f.invoke(channel, channel === EVENT_CHANNELS.manual ? [2] : [], f.sender, null), /unauthorized/i);
  }
  assert.deepEqual(f.calls, []);
});

test('exact argument counts and primitive integer bounds are checked before store access', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(EVENT_CHANNELS.get, [1]), failure('invalid_request', 'Invalid event request.'));
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital, [0]), failure('invalid_request', 'Invalid event request.'));
  for (const args of [[], [1, 2], [new Number(1)], ['1'], [null], [1.5], [0], [91], [NaN], [Infinity]]) {
    assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, args), failure('invalid_request', 'Invalid event request.'));
  }
  assert.deepEqual(f.calls, []);
});

test('absent current event and read errors have distinct stable serializable failures', () => {
  const absent = fixture(null);
  assert.deepEqual(absent.invoke(EVENT_CHANNELS.get), failure('event_unavailable', 'No current event is available.'));
  const broken = fixture();
  broken.setFailure('load');
  assert.deepEqual(broken.invoke(EVENT_CHANNELS.get), failure('storage_failure', 'Could not read the current event. Try again.'));
});

test('duplicate and exhausted draws return domain failures without acknowledging success', () => {
  const f = fixture([90, 1]);
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [90]), failure('duplicate', 'That number has already been called.'));
  assert.deepEqual(f.snapshot(), [90, 1]);
  const full = fixture(Array.from({ length: 90 }, (_, index) => index + 1));
  assert.deepEqual(full.invoke(EVENT_CHANNELS.digital), failure('exhausted', 'All numbers have been called.'));
  assert.deepEqual(full.invoke(EVENT_CHANNELS.manual, [1]), failure('exhausted', 'All numbers have been called.'));
  assert.deepEqual(full.calls, ['update', 'update']);
});

test('the successful response comes from the post-update return, not the proposed transition', () => {
  // A fake committed result differs from the proposed transition to enforce the boundary.
  const sender = {}, frame = {};
  const bound = new Map<string, Handler>();
  registerEventIpc({ handle: (channel, handler) => { bound.set(channel, handler); } }, {
    load: () => null,
    update: (transition) => {
      assert.deepEqual(transition({ calledNumbers: [1] }).calledNumbers, [1, 2]);
      return { calledNumbers: [1, 2, 3] };
    },
  }, rules, () => 0, sender, frame);
  assert.deepEqual(bound.get(EVENT_CHANNELS.manual)?.({ sender, senderFrame: frame }, 2),
    { ok: true, snapshot: { calledNumbers: [1, 2, 3] } });
});

test('a failed update never acknowledges a proposed snapshot or leaks storage details', () => {
  const f = fixture([90]);
  f.setFailure('update');
  const result = f.invoke(EVENT_CHANNELS.manual, [2]);
  assert.deepEqual(result, failure('storage_failure', 'Could not save the draw. Reload and try again.'));
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(f.snapshot(), [90]);
  assert.deepEqual(f.calls, ['update']);
});
