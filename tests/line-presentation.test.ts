import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createLinePresentationCoordinator, type LinePresentationSignal } from '../src/line-presentation.ts';
import { createEventStore, type StoredLineAward } from '../src/event-store.ts';

type Status = 'pending' | 'started' | 'failed' | 'completed' | 'interrupted';
const award = (id: string, status: Status = 'pending', startedAt: number | null = null) =>
  ({ presentation: { id, status, startedAt, deadlineAt: startedAt === null ? null : startedAt + 4000 } }) as unknown as StoredLineAward;

// In-memory store double following the real contract: stale ids and bad sources throw, completion needs the deadline.
function fakeStore(initial: StoredLineAward) {
  let current = initial;
  let counter = 0;
  const calls: string[] = [];
  const step = (name: string, id: string, from: Status, to: Status, rotate: boolean, startedAt: number | null = null) => {
    calls.push(`${name}:${id}`);
    if (current.presentation.id !== id) throw new Error('Line presentation is not the current one');
    if (current.presentation.status !== from) throw new Error(`Invalid presentation transition: ${current.presentation.status}`);
    current = award(rotate ? `new-${++counter}` : id, to, startedAt);
    return current;
  };
  return {
    calls,
    get current() { return current; },
    set(next: StoredLineAward) { current = next; },
    throwOnStart: false,
    startLinePresentation(id: string, at: number) {
      if (this.throwOnStart) { calls.push(`start:${id}`); throw new Error('start refused'); }
      return step('start', id, 'pending', 'started', false, at);
    },
    failLinePresentation: (id: string) => step('fail', id, 'pending', 'failed', false),
    retryLinePresentation: (id: string) => step('retry', id, 'failed', 'pending', true),
    replayLinePresentation: (id: string) => step('replay', id, 'interrupted', 'pending', true),
    completeLinePresentation(id: string, at: number) {
      calls.push(`complete:${id}`);
      if (current.presentation.id !== id || current.presentation.status !== 'started') throw new Error('Invalid presentation transition');
      if (at < (current.presentation.deadlineAt as number)) throw new Error('Line presentation deadline not reached');
      current = award(id, 'completed', current.presentation.startedAt);
      return current;
    },
  };
}

function harness(initial = award('a'), options: { publish?: boolean; ackTimeoutMs?: number } = {},
    overrides: Record<string, unknown> = {}, store: Parameters<typeof createLinePresentationCoordinator>[0] & { current: StoredLineAward } = fakeStore(initial) as never) {
  let clock = 1000;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const published: LinePresentationSignal[] = [];
  const notified: Array<StoredLineAward | null> = [];
  const coordinator = createLinePresentationCoordinator(store, {
    now: () => clock,
    schedule: (fn: () => void, ms: number) => { timers.set(++nextHandle, { at: clock + ms, fn }); return nextHandle; },
    cancel: (handle: unknown) => { timers.delete(handle as number); },
    publish: (signal: LinePresentationSignal) => { published.push(signal); return options.publish ?? true; },
    notify: (value: StoredLineAward | null) => { notified.push(value); },
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
    ...overrides,
  } as never);
  // Advances the fake clock, firing due timers in order.
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].fn();
    }
    clock = target;
  };
  return { store, coordinator, published, notified, advance, timers, now: () => clock };
}

test('begin publishes one 4 s signal and ignores a second begin for the same id', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.coordinator.begin(h.store.current);
  assert.deepEqual(h.published, [{ kind: 'line', id: 'a', durationMs: 4000 }]);
  assert.equal(h.timers.size, 1);
  assert.equal(h.coordinator.busy(), true);
});

test('begin ignores awards that are not pending', () => {
  for (const status of ['started', 'failed', 'completed', 'interrupted'] as const) {
    const h = harness(award('a', status, 1000));
    h.coordinator.begin(h.store.current);
    assert.equal(h.published.length, 0, status);
    assert.equal(h.coordinator.busy(), false, status);
  }
});

test('a failed publish fails the presentation at once and notifies', () => {
  const h = harness(award('a'), { publish: false });
  h.coordinator.begin(h.store.current);
  assert.equal(h.store.current.presentation.status, 'failed');
  assert.deepEqual(h.notified.map((n) => n?.presentation.status), ['failed']);
  assert.equal(h.coordinator.busy(), false);
  assert.equal(h.timers.size, 0);
  h.coordinator.begin(h.store.current);
  assert.equal(h.published.length, 1, 'no auto-retry');
});

test('a missing receipt fails after the ack timeout and a late receipt is ignored', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.advance(1999);
  assert.equal(h.store.current.presentation.status, 'pending');
  assert.equal(h.coordinator.busy(), true);
  h.advance(1);
  assert.equal(h.store.current.presentation.status, 'failed');
  assert.equal(h.coordinator.busy(), false);
  assert.equal(h.coordinator.receiptStarted('a'), false);
  assert.equal(h.store.current.presentation.status, 'failed');
  h.advance(60_000);
  assert.equal(h.published.length, 1, 'no auto-retry');
  assert.equal(h.notified.length, 1);
});

test('ackTimeoutMs is configurable', () => {
  const h = harness(award('a'), { ackTimeoutMs: 500 });
  h.coordinator.begin(h.store.current);
  h.advance(500);
  assert.equal(h.store.current.presentation.status, 'failed');
});

test('wrong, unawaited and repeated receipts are ignored', () => {
  const h = harness();
  assert.equal(h.coordinator.receiptStarted('a'), false, 'nothing awaited');
  h.coordinator.begin(h.store.current);
  assert.equal(h.coordinator.receiptStarted('other'), false);
  assert.equal(h.store.current.presentation.status, 'pending');
  assert.equal(h.coordinator.receiptStarted('a'), true);
  assert.equal(h.coordinator.receiptStarted('a'), false, 'already running');
  assert.deepEqual(h.store.calls, ['start:a']);
});

test('an accepted receipt starts the run and completion happens exactly at the deadline', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.advance(300);
  assert.equal(h.coordinator.receiptStarted('a'), true);
  assert.deepEqual(h.store.current.presentation, { id: 'a', status: 'started', startedAt: 1300, deadlineAt: 5300 });
  assert.equal(h.coordinator.busy(), true);
  h.advance(3999);
  assert.equal(h.store.current.presentation.status, 'started');
  h.advance(1);
  assert.equal(h.store.current.presentation.status, 'completed');
  assert.equal(h.coordinator.busy(), false);
  assert.deepEqual(h.notified.map((n) => n?.presentation.status), ['started', 'completed']);
  h.advance(10_000);
  assert.equal(h.timers.size, 0);
});

test('the ack timer is cancelled by the receipt so the run is never failed afterwards', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.coordinator.receiptStarted('a');
  h.advance(2500);
  assert.equal(h.store.current.presentation.status, 'started');
  assert.ok(!h.store.calls.includes('fail:a'));
});

test('a completion fired before the deadline reschedules for the remaining time', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.coordinator.receiptStarted('a');
  // Simulate a timer that fires early: run the pending timer 1 s too soon by moving only the stored clock back.
  const [handle, timer] = [...h.timers.entries()][0];
  h.timers.delete(handle);
  h.advance(3000);
  timer.fn();
  assert.equal(h.store.current.presentation.status, 'started');
  assert.equal(h.coordinator.busy(), true);
  assert.equal(h.timers.size, 1);
  h.advance(999);
  assert.equal(h.store.current.presentation.status, 'started');
  h.advance(1);
  assert.equal(h.store.current.presentation.status, 'completed');
});

test('another completion error notifies and stops without rescheduling', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.coordinator.receiptStarted('a');
  h.store.set(award('a', 'interrupted', 1000));
  h.advance(4000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.coordinator.busy(), false);
  assert.equal(h.notified.at(-1), null, 'one null notification so the owner re-reads the store');
});

test('retry gives a new id and a full 4 s run; repeat does the same from interrupted', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  h.advance(2000);
  assert.equal(h.store.current.presentation.status, 'failed');
  const published = h.published.length;
  h.coordinator.retry('a');
  assert.equal(h.published.length, published + 1);
  assert.deepEqual(h.published.at(-1), { kind: 'line', id: 'new-1', durationMs: 4000 });
  assert.equal(h.coordinator.receiptStarted('a'), false, 'old id');
  assert.equal(h.coordinator.receiptStarted('new-1'), true);
  h.advance(4000);
  assert.equal(h.store.current.presentation.status, 'completed');

  const r = harness(award('i', 'interrupted', 1000));
  r.coordinator.begin(r.store.current);
  assert.equal(r.published.length, 0, 'interrupted never auto-replays');
  r.coordinator.repeat('i');
  assert.deepEqual(r.published, [{ kind: 'line', id: 'new-1', durationMs: 4000 }]);
  assert.equal(r.coordinator.receiptStarted('i'), false);
  assert.equal(r.coordinator.receiptStarted('new-1'), true);
  r.advance(4000);
  assert.equal(r.store.current.presentation.status, 'completed');
  assert.equal(r.coordinator.busy(), false);
});

test('error contract: manual store refusals throw, notify nothing and publish nothing', () => {
  const h = harness();
  const notified = h.notified.length;
  assert.throws(() => h.coordinator.retry('a'), /transition|presentation/i, 'pending cannot retry');
  assert.throws(() => h.coordinator.repeat('a'), /transition|presentation/i, 'pending cannot replay');
  assert.throws(() => h.coordinator.retry('stale'), /current/i);
  assert.equal(h.published.length, 0);
  assert.equal(h.notified.length, notified);
  assert.equal(h.coordinator.busy(), false);
});

test('retry and repeat are refused while a run is busy', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  assert.throws(() => h.coordinator.retry('a'), /busy/i);
  assert.throws(() => h.coordinator.repeat('a'), /busy/i);
  assert.ok(!h.store.calls.includes('retry:a'));
});

// ---- verifier regressions ----
const fixtures: string[] = [];
after(() => { for (const directory of fixtures) fs.rmSync(directory, { recursive: true, force: true }); });

test('a refused start fails the pending award so the operator can retry, and busy() is false', () => {
  const h = harness();
  (h.store as unknown as { throwOnStart: boolean }).throwOnStart = true;
  h.coordinator.begin(h.store.current);
  assert.equal(h.coordinator.receiptStarted('a'), false);
  assert.equal(h.store.current.presentation.status, 'failed');
  assert.equal(h.coordinator.busy(), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.notified.at(-1)?.presentation.status, 'failed');
  (h.store as unknown as { throwOnStart: boolean }).throwOnStart = false;
  h.coordinator.retry('a');
  assert.equal(h.coordinator.receiptStarted('new-1'), true);
});

test('a refused start whose fail also throws notifies null and leaves nothing running', () => {
  const h = harness();
  h.coordinator.begin(h.store.current);
  (h.store as unknown as { throwOnStart: boolean }).throwOnStart = true;
  h.store.failLinePresentation = () => { throw new Error('fail refused'); };
  assert.equal(h.coordinator.receiptStarted('a'), false);
  assert.equal(h.notified.at(-1), null);
  assert.equal(h.coordinator.busy(), false);
});

test('the real store rejects an invalid receipt clock and the award ends failed, not pending', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-line-presentation-'));
  fixtures.push(directory);
  const store = createEventStore(join(directory, 'event.sqlite'));
  try {
    const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    store.updateEventPrizes(event.id, { line: { amount: 10, lot: '' }, bingo: { amount: 0, lot: '' } });
    const declared = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 3, '2025-01-01T00:00:01.000Z');
    const h = harness(declared, {}, { now: () => 1.5 }, store as never);
    h.coordinator.begin(declared);
    assert.equal(h.coordinator.receiptStarted(declared.presentation.id), false);
    assert.equal(store.loadLineAward()?.presentation.status, 'failed');
    assert.equal(h.coordinator.busy(), false);
    assert.equal(h.notified.at(-1)?.presentation.status, 'failed');
  } finally { store.close(); }
});

test('a throwing notify never escapes the ack timeout, the receipt or the completion callback', () => {
  const boom = () => { throw new Error('notify boom'); };
  const ack = harness(award('a'), {}, { notify: boom });
  ack.coordinator.begin(ack.store.current);
  assert.doesNotThrow(() => ack.advance(2000));
  assert.equal(ack.store.current.presentation.status, 'failed');
  assert.equal(ack.coordinator.busy(), false);

  const receipt = harness(award('a'), {}, { notify: boom });
  receipt.coordinator.begin(receipt.store.current);
  assert.doesNotThrow(() => receipt.coordinator.receiptStarted('a'));
  assert.equal(receipt.store.current.presentation.status, 'started');
  assert.doesNotThrow(() => receipt.advance(4000));
  assert.equal(receipt.store.current.presentation.status, 'completed');
  assert.equal(receipt.coordinator.busy(), false);

  const refused = harness(award('a'), { publish: false }, { notify: boom });
  assert.doesNotThrow(() => refused.coordinator.begin(refused.store.current));
  assert.equal(refused.store.current.presentation.status, 'failed');
});

test('a throwing schedule while arming the ack timer fails the presentation instead of stranding it', () => {
  const h = harness(award('a'), {}, { schedule: () => { throw new Error('schedule boom'); } });
  assert.doesNotThrow(() => h.coordinator.begin(h.store.current));
  assert.equal(h.store.current.presentation.status, 'failed');
  assert.equal(h.coordinator.busy(), false);
  assert.equal(h.notified.at(-1)?.presentation.status, 'failed');
});

test('a throwing schedule or clock while arming completion notifies null and leaves busy() false', () => {
  let calls = 0;
  const schedule = (fn: () => void, _ms: number) => { if (++calls === 2) throw new Error('schedule boom'); return calls + fn.length * 0; };
  const h = harness(award('a'), {}, { schedule });
  h.coordinator.begin(h.store.current);
  assert.doesNotThrow(() => h.coordinator.receiptStarted('a'));
  assert.equal(h.notified.at(-1), null);
  assert.equal(h.coordinator.busy(), false);

  let clockCalls = 0;
  const g = harness(award('a'), {}, { now: () => { if (++clockCalls === 2) throw new Error('clock boom'); return 1000; } });
  g.coordinator.begin(g.store.current);
  assert.doesNotThrow(() => g.coordinator.receiptStarted('a'));
  assert.equal(g.store.current.presentation.status, 'started', 'a started row cannot fail; startup interruption owns it');
  assert.equal(g.notified.at(-1), null);
  assert.equal(g.coordinator.busy(), false);
});

test('a throwing cancel and a throwing clock in the completion callback are contained', () => {
  const h = harness(award('a'), {}, { cancel: () => { throw new Error('cancel boom'); } });
  h.coordinator.begin(h.store.current);
  assert.doesNotThrow(() => h.coordinator.receiptStarted('a'));
  assert.equal(h.store.current.presentation.status, 'started');

  let clockCalls = 0;
  const g = harness(award('a'), {}, { now: () => { if (++clockCalls === 3) throw new Error('clock boom'); return 1000; } });
  g.coordinator.begin(g.store.current);
  g.coordinator.receiptStarted('a');
  assert.doesNotThrow(() => g.advance(4000));
  assert.equal(g.coordinator.busy(), false);
  assert.equal(g.notified.at(-1), null);
});

test('begin for a different id while awaiting or running fails the new award and never overwrites the active run', () => {
  const second = award('b');
  for (const phase of ['awaiting', 'running'] as const) {
    const h = harness(award('a'));
    h.coordinator.begin(h.store.current);
    if (phase === 'running') h.coordinator.receiptStarted('a');
    const published = h.published.length;
    h.store.set(second);
    h.coordinator.begin(second);
    assert.equal(h.published.length, published, phase);
    assert.equal(h.store.current.presentation.status, 'failed', phase);
    assert.equal(h.store.current.presentation.id, 'b', phase);
    assert.equal(h.coordinator.busy(), true, phase);
    assert.equal(h.notified.at(-1)?.presentation.status, 'failed', phase);
    // The first run is untouched: its receipt (or deadline) is still honored.
    h.store.set(award('a', phase === 'running' ? 'started' : 'pending', phase === 'running' ? 1000 : null));
    if (phase === 'awaiting') {
      assert.equal(h.coordinator.receiptStarted('b'), false);
      assert.equal(h.coordinator.receiptStarted('a'), true);
    }
    h.advance(4000);
    assert.equal(h.store.current.presentation.status, 'completed', phase);
    assert.equal(h.coordinator.busy(), false, phase);
  }
});

test('a stale timer for an older id cannot clear a newer run', () => {
  const h = harness(award('a'));
  h.coordinator.begin(h.store.current);
  const [, staleAck] = [...h.timers.entries()][0];
  h.coordinator.receiptStarted('a');
  h.advance(4000);
  h.store.set(award('b'));
  h.coordinator.begin(h.store.current);
  assert.equal(h.coordinator.busy(), true);
  staleAck.fn();
  assert.equal(h.coordinator.busy(), true);
  assert.equal(h.store.current.presentation.status, 'pending', 'the stale ack timeout did not fail b');
  assert.equal(h.coordinator.receiptStarted('b'), true);
  h.advance(4000);
  assert.equal(h.store.current.presentation.status, 'completed');
});
