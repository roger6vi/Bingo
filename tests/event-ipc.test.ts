import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEventIpc, EVENT_CHANNELS } from '../src/event-ipc.ts';
import { drawManual, drawDigital, type EventSnapshot } from '../src/event-core.ts';

const rules = { drawManual, drawDigital };
type StoredSnapshot = EventSnapshot & { phase: 'drawing' | 'line_declared'; lastTransitionAt: string | null };
const initialSnapshot = (calledNumbers: number[]): StoredSnapshot =>
  ({ calledNumbers, phase: 'drawing', lastTransitionAt: null });

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;

function fixture(initial: readonly number[] | null = [90, 1], random = () => 0,
  notify?: (snapshot: EventSnapshot) => void, presenting?: () => boolean, setup?: () => boolean) {
  const sender = {}, frame = { url: 'file:///app/operator.html' }, other = {};
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let current: StoredSnapshot | null = initial === null ? null : initialSnapshot([...initial]);
  let failure: 'load' | 'update' | null = null;
  const store = {
    load(): StoredSnapshot | null {
      calls.push('load');
      if (failure === 'load') throw new Error('secret read detail');
      return current;
    },
    update(transition: (event: EventSnapshot) => EventSnapshot): StoredSnapshot {
      calls.push('update');
      if (current === null) throw new Error('missing event');
      const proposed = transition(current);
      if (failure === 'update') throw new Error('secret write detail');
      current = { ...current, ...proposed, calledNumbers: [...proposed.calledNumbers] };
      return { ...current, calledNumbers: [...current.calledNumbers] };
    },
  };
  registerEventIpc({ handle: (channel: string, handler: Handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, rules, random, sender, () => frame, frame.url, notify, presenting, setup);
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
  assert.deepEqual(result, { ok: true, snapshot: initialSnapshot([90, 1]) });
  assert.deepEqual(f.calls, ['load']);
  assert.notEqual((result as { snapshot: EventSnapshot }).snapshot.calledNumbers, f.snapshot());
});

test('manual and digital draws acknowledge only the committed returned snapshot', () => {
  const f = fixture([90, 1], () => { f.calls.push('random'); return 0; });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [45]), { ok: true, snapshot: initialSnapshot([90, 1, 45]) });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital), { ok: true, snapshot: initialSnapshot([90, 1, 45, 2]) });
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

test('navigation replaces the authorized frame but never grants another document access', () => {
  const sender = {};
  const expectedUrl = 'file:///app/operator.html';
  const initial = { url: 'about:blank' };
  const loaded = { url: expectedUrl };
  const unexpected = { url: 'file:///app/other.html' };
  let current: typeof initial | null = initial;
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  registerEventIpc({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    load: () => { calls.push('load'); return initialSnapshot([90, 1]); },
    update: (transition) => {
      calls.push('update');
      return { ...initialSnapshot([90, 1]), ...transition(initialSnapshot([90, 1])) };
    },
  }, rules, () => { calls.push('random'); return 0; }, sender, () => current, expectedUrl);
  const invoke = (channel: string, from: object, frame: object | null, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler({ sender: from, senderFrame: frame }, ...args);
  };
  current = loaded;
  assert.deepEqual(invoke(EVENT_CHANNELS.get, sender, loaded),
    { ok: true, snapshot: initialSnapshot([90, 1]) });
  assert.deepEqual(invoke(EVENT_CHANNELS.manual, sender, loaded, 2),
    { ok: true, snapshot: initialSnapshot([90, 1, 2]) });
  assert.deepEqual(invoke(EVENT_CHANNELS.digital, sender, loaded),
    { ok: true, snapshot: initialSnapshot([90, 1, 2]) });
  assert.deepEqual(calls, ['load', 'update', 'update', 'random']);
  calls.length = 0;
  for (const channel of Object.values(EVENT_CHANNELS)) {
    const args = channel === EVENT_CHANNELS.manual ? [2] : [];
    assert.throws(() => invoke(channel, sender, initial, ...args), /unauthorized/i);
    assert.throws(() => invoke(channel, {}, loaded, ...args), /unauthorized/i);
    assert.throws(() => invoke(channel, sender, null, ...args), /unauthorized/i);
    assert.throws(() => invoke(channel, sender, { url: expectedUrl }, ...args), /unauthorized/i);
  }
  current = unexpected;
  for (const channel of Object.values(EVENT_CHANNELS)) {
    const args = channel === EVENT_CHANNELS.manual ? [2] : [];
    assert.throws(() => invoke(channel, sender, unexpected, ...args), /unauthorized/i);
  }
  assert.deepEqual(calls, []);
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
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const bound = new Map<string, Handler>();
  registerEventIpc({ handle: (channel, handler) => { bound.set(channel, handler); } }, {
    load: () => null,
    update: (transition) => {
      assert.deepEqual(transition(initialSnapshot([1])), initialSnapshot([1, 2]));
      return { calledNumbers: [1, 2, 3], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' };
    },
  }, rules, () => 0, sender, () => frame, frame.url);
  assert.deepEqual(bound.get(EVENT_CHANNELS.manual)?.({ sender, senderFrame: frame }, 2),
    { ok: true, snapshot: { calledNumbers: [1, 2, 3], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
});

test('notification follows the committed return, not the proposal, and gets its own clone', () => {
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const committed = { calledNumbers: [1, 2, 3], phase: 'line_declared' as const, lastTransitionAt: '2026-01-01T00:00:00.000Z' };
  let received: EventSnapshot | undefined;
  registerEventIpc({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    load: () => null,
    update: (transition) => {
      order.push('transition');
      assert.deepEqual(transition(initialSnapshot([1])), initialSnapshot([1, 2]));
      order.push('commit');
      return committed;
    },
  }, rules, () => 0, sender, () => frame, frame.url, (snapshot) => {
    order.push('notify');
    received = snapshot;
  });
  const result = handlers.get(EVENT_CHANNELS.manual)?.({ sender, senderFrame: frame }, 2);
  assert.deepEqual(order, ['transition', 'commit', 'notify']);
  assert.deepEqual(received, committed);
  assert.notEqual(received, committed);
  assert.notEqual(received?.calledNumbers, committed.calledNumbers);
  assert.notEqual(received, (result as { snapshot: EventSnapshot }).snapshot);
  assert.deepEqual(result, { ok: true, snapshot: committed });
  assert.notEqual((result as { snapshot: EventSnapshot }).snapshot.calledNumbers, committed.calledNumbers);
});

test('notification never runs for invalid, unauthorized, domain or storage failures', () => {
  const notified: EventSnapshot[] = [];
  const f = fixture([1], () => NaN, (snapshot) => notified.push(snapshot));
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [0]), failure('invalid_request', 'Invalid event request.'));
  assert.throws(() => f.invoke(EVENT_CHANNELS.manual, [2], f.other), /unauthorized/i);
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [1]), failure('duplicate', 'That number has already been called.'));
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital), failure('invalid_draw', 'Could not draw a number. Reload and try again.'));
  f.setFailure('update');
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [2]), failure('storage_failure', 'Could not save the draw. Reload and try again.'));
  assert.deepEqual(f.invoke(EVENT_CHANNELS.get), { ok: true, snapshot: initialSnapshot([1]) });
  assert.deepEqual(notified, []);
  const full = fixture(Array.from({ length: 90 }, (_, i) => i + 1), () => 0,
    (snapshot) => notified.push(snapshot));
  assert.equal((full.invoke(EVENT_CHANNELS.digital) as { code: string }).code, 'exhausted');
  assert.deepEqual(notified, []);
});

test('notifier exceptions cannot reverse an acknowledged commit', () => {
  const f = fixture([1], () => 0, () => { throw new Error('display disconnected'); });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [2]),
    { ok: true, snapshot: initialSnapshot([1, 2]) });
  assert.deepEqual(f.snapshot(), [1, 2]);
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

test('draws are refused without touching store, randomness, or display while Tongo plays', () => {
  let playing = true;
  const notified: EventSnapshot[] = [];
  const f = fixture([1], () => { f.calls.push('random'); return 0; }, (snapshot) => notified.push(snapshot), () => playing);
  const busy = failure('presentation_active', 'Wait for Tongo to finish, then draw again.');
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [2]), busy);
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital), busy);
  assert.deepEqual(f.invoke(EVENT_CHANNELS.get), { ok: true, snapshot: initialSnapshot([1]) });
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [91]), failure('invalid_request', 'Invalid event request.'));
  assert.deepEqual([f.calls, notified, f.snapshot()], [['load'], [], [1]]);
  playing = false;
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [2]), { ok: true, snapshot: initialSnapshot([1, 2]) });
});

test('an open first-line setup refuses manual and digital draws before the store or randomness', () => {
  let open = true;
  const f = fixture([90, 1], () => { f.calls.push('random'); return 0; }, undefined, undefined, () => open);
  const refused = failure('line_setup_active', 'Finish or cancel the first-line setup, then draw again.');
  assert.deepEqual(f.invoke(EVENT_CHANNELS.manual, [45]), refused);
  assert.deepEqual(f.invoke(EVENT_CHANNELS.digital), refused);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.snapshot(), [90, 1]);
  // Reading stays available so a reloaded dialog can recover, and draws resume once setup closes.
  assert.equal((f.invoke(EVENT_CHANNELS.get) as { ok: boolean }).ok, true);
  open = false;
  assert.equal((f.invoke(EVENT_CHANNELS.manual, [45]) as { ok: boolean }).ok, true);
});
