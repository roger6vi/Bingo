import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresentationWiring } from '../src/presentation-wiring.ts';
import type { StoredLineAward } from '../src/event-store.ts';

type Status = 'pending' | 'started' | 'failed' | 'completed' | 'interrupted';
type Kind = 'line' | 'bingo';
const award = (id: string, status: Status = 'pending', startedAt: number | null = null) =>
  ({ presentation: { id, status, startedAt, deadlineAt: startedAt === null ? null : startedAt + 4000 } }) as unknown as StoredLineAward;

// BG05A: manual Bingo retry/replay through the shared wiring. Store doubles share one call log; stale ids and invalid
// transitions throw like the real store, and retry/replay rotate the id (`r`/`p` suffix).
function harness(line = award('L1', 'failed'), bingo = award('B1', 'failed')) {
  const calls: string[] = [];
  const current: Record<Kind, StoredLineAward> = { line, bingo };
  const step = (kind: Kind, name: string, id: string, from: Status, to: Status, next = id, at: number | null = null) => {
    calls.push(`${kind}:${name}:${id}`);
    const row = current[kind].presentation;
    if (row.id !== id) throw new Error('Presentation is not the current one');
    if (row.status !== from) throw new Error('Invalid presentation transition');
    current[kind] = award(next, to, at);
    return current[kind];
  };
  const steps = (kind: Kind) => ({
    start: (id: string, at: number) => step(kind, 'start', id, 'pending', 'started', id, at),
    fail: (id: string) => step(kind, 'fail', id, 'pending', 'failed'),
    retry: (id: string) => step(kind, 'retry', id, 'failed', 'pending', `${id}r`),
    replay: (id: string) => step(kind, 'replay', id, 'interrupted', 'pending', `${id}p`),
    complete: (id: string) => step(kind, 'complete', id, 'started', 'completed', id, current[kind].presentation.startedAt),
  });
  const l = steps('line');
  const b = steps('bingo');
  const store = {
    startLinePresentation: l.start, failLinePresentation: l.fail, retryLinePresentation: l.retry,
    replayLinePresentation: l.replay, completeLinePresentation: l.complete,
    startBingoPresentation: b.start, failBingoPresentation: b.fail, retryBingoPresentation: b.retry,
    replayBingoPresentation: b.replay, completeBingoPresentation: b.complete,
  };
  let clock = 1000;
  let handle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const published: string[] = [];
  const notified: string[] = [];
  const authorized = { sender: 'public' };
  const wiring = createPresentationWiring(store, {
    now: () => clock,
    schedule: (fn, ms) => { timers.set(++handle, { at: clock + ms, fn }); return handle; },
    cancel: (value) => { timers.delete(value as number); },
    publish: (signal) => { published.push(`${signal.kind}:${signal.id}`); return true; },
    notifyLine: (value) => { notified.push(`line:${value?.presentation.status ?? null}`); },
    notifyBingo: (value) => { notified.push(`bingo:${value?.presentation.status ?? null}`); },
    acceptLineReceipt: (event) => event === authorized,
    acceptBingoReceipt: (event) => event === authorized,
  });
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
  return { wiring, current, calls, published, notified, authorized, advance };
}

test('construction exposes Bingo retry/repeat inert: nothing is read, published, notified or begun', () => {
  const h = harness();
  assert.equal(typeof h.wiring.bingo.retry, 'function');
  assert.equal(typeof h.wiring.bingo.repeat, 'function');
  assert.deepEqual([h.calls, h.published, h.notified, h.wiring.busy()], [[], [], [], false]);
});

test('an awaiting or running Line refuses Bingo retry and repeat before any store mutation', () => {
  const h = harness(award('L1', 'failed'), award('B1', 'failed'));
  h.wiring.line.retry('L1');
  assert.throws(() => h.wiring.bingo.retry('B1'), /Line presentation is busy/);
  h.current.bingo = award('B2', 'interrupted', 500);
  assert.throws(() => h.wiring.bingo.repeat('B2'), /Line presentation is busy/);
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L1r'), true);
  assert.throws(() => h.wiring.bingo.repeat('B2'), /Line presentation is busy/);
  h.current.bingo = award('B1', 'failed');
  assert.throws(() => h.wiring.bingo.retry('B1'), /Line presentation is busy/);
  assert.deepEqual(h.calls, ['line:retry:L1', 'line:start:L1r']);
  assert.deepEqual(h.published, ['line:L1r']);
  assert.deepEqual(h.notified, ['line:pending', 'line:started']);
  h.advance(4000);
  assert.deepEqual([h.calls.at(-1), h.wiring.busy()], ['line:complete:L1r', false]);
  // The Line run finished whole; the same Bingo retry is now accepted.
  h.wiring.bingo.retry('B1');
  assert.deepEqual(h.published, ['line:L1r', 'bingo:B1r']);
});

test('an active Bingo still refuses Line manual paths and its own manual paths before the store', () => {
  const h = harness(award('L1', 'failed'), award('B1', 'failed'));
  h.wiring.bingo.retry('B1');
  assert.throws(() => h.wiring.line.retry('L1'), /Bingo presentation is busy/);
  h.current.line = award('L2', 'interrupted', 500);
  assert.throws(() => h.wiring.line.repeat('L2'), /Bingo presentation is busy/);
  assert.throws(() => h.wiring.bingo.retry('B1r'), /Bingo presentation is busy/);
  assert.throws(() => h.wiring.bingo.repeat('B1r'), /Bingo presentation is busy/);
  assert.deepEqual([h.calls, h.published], [['bingo:retry:B1'], ['bingo:B1r']]);
});

test('Bingo wrong-status and stale-id refusals come from the store and publish or notify nothing', () => {
  const h = harness(award('L1', 'failed'), award('B1'));
  assert.throws(() => h.wiring.bingo.retry('B1'), /transition/);
  assert.throws(() => h.wiring.bingo.repeat('B1'), /transition/);
  h.current.bingo = award('B1', 'failed');
  assert.throws(() => h.wiring.bingo.retry('B0'), /current/);
  assert.deepEqual(h.calls, ['bingo:retry:B1', 'bingo:replay:B1', 'bingo:retry:B0']);
  assert.deepEqual([h.published, h.notified, h.wiring.busy(), h.current.bingo.presentation.id], [[], [], false, 'B1']);
});

test('a Bingo retry runs once under the new id; the old receipt is rejected and Line is untouched', () => {
  const h = harness(award('L1', 'failed'), award('B1', 'failed'));
  h.wiring.bingo.retry('B1');
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1'), false, 'old receipt');
  assert.equal(h.wiring.lineReceipt(h.authorized, 'B1r'), false, 'wrong channel');
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1r'), true);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1r'), false, 'one receipt');
  h.advance(3999);
  assert.equal(h.current.bingo.presentation.status, 'started');
  h.advance(1);
  h.advance(8000);
  assert.deepEqual(h.calls, ['bingo:retry:B1', 'bingo:start:B1r', 'bingo:complete:B1r']);
  assert.deepEqual(h.published, ['bingo:B1r']);
  assert.deepEqual(h.notified, ['bingo:pending', 'bingo:started', 'bingo:completed']);
  assert.deepEqual([h.current.line.presentation, h.wiring.busy()], [award('L1', 'failed').presentation, false]);
});

test('a Bingo replay of an interrupted run fails once on a missing receipt, then may be retried', () => {
  const h = harness(award('L1', 'failed'), award('B1', 'interrupted', 500));
  h.wiring.bingo.repeat('B1');
  assert.deepEqual(h.published, ['bingo:B1p']);
  h.advance(2000);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1p'), false, 'late receipt');
  h.advance(4000);
  assert.deepEqual(h.calls, ['bingo:replay:B1', 'bingo:fail:B1p']);
  assert.deepEqual([h.notified, h.wiring.busy()], [['bingo:pending', 'bingo:failed'], false]);
  h.wiring.bingo.retry('B1p');
  assert.deepEqual(h.published, ['bingo:B1p', 'bingo:B1pr']);
});
