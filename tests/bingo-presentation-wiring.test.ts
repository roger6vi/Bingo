import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPresentationWiring } from '../src/presentation-wiring.ts';
import type { StoredLineAward } from '../src/event-store.ts';

type Status = 'pending' | 'started' | 'failed' | 'completed' | 'interrupted';
const award = (id: string, status: Status = 'pending', startedAt: number | null = null) =>
  ({ presentation: { id, status, startedAt, deadlineAt: startedAt === null ? null : startedAt + 4000 } }) as unknown as StoredLineAward;

// Line and Bingo store doubles over one call log: stale ids and invalid transitions throw, like the real store.
function harness() {
  const calls: string[] = [];
  const current: Record<'line' | 'bingo', StoredLineAward> = { line: award('L1', 'failed'), bingo: award('B1') };
  // Re-entrant callbacks: `hooks[event]` runs once, synchronously, inside the matching store step, publish or notify.
  const hooks: Record<string, () => void> = {};
  const fire = (event: string) => { const hook = hooks[event]; delete hooks[event]; hook?.(); };
  const step = (kind: 'line' | 'bingo', name: string, id: string, from: Status, to: Status, next = id, at: number | null = null) => {
    calls.push(`${kind}:${name}:${id}`);
    fire(`${kind}:${name}:${id}`);
    const row = current[kind].presentation;
    if (row.id !== id || row.status !== from) throw new Error('Invalid presentation transition');
    current[kind] = award(next, to, at);
    return current[kind];
  };
  const complete = (kind: 'line' | 'bingo', id: string, now: number) => step(kind, 'complete', id, 'started', 'completed', id,
    current[kind].presentation.startedAt);
  const store = {
    startLinePresentation: (id: string, at: number) => step('line', 'start', id, 'pending', 'started', id, at),
    failLinePresentation: (id: string) => step('line', 'fail', id, 'pending', 'failed'),
    retryLinePresentation: (id: string) => step('line', 'retry', id, 'failed', 'pending', `${id}r`),
    replayLinePresentation: (id: string) => step('line', 'replay', id, 'interrupted', 'pending', `${id}p`),
    completeLinePresentation: (id: string, now: number) => complete('line', id, now),
    startBingoPresentation: (id: string, at: number) => step('bingo', 'start', id, 'pending', 'started', id, at),
    failBingoPresentation: (id: string) => step('bingo', 'fail', id, 'pending', 'failed'),
    completeBingoPresentation: (id: string, now: number) => complete('bingo', id, now),
  };
  let clock = 1000;
  let handle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const published: string[] = [];
  const notified: string[] = [];
  const accepted: string[] = [];
  const authorized = { sender: 'public' };
  const wiring = createPresentationWiring(store, {
    now: () => clock,
    schedule: (fn, ms) => { timers.set(++handle, { at: clock + ms, fn }); return handle; },
    cancel: (value) => { timers.delete(value as number); },
    publish: (signal) => {
      published.push(`${signal.kind}:${signal.id}:${signal.durationMs}`);
      fire(`publish:${signal.kind}:${signal.id}`);
      return true;
    },
    notifyLine: (value) => { notified.push(`line:${value?.presentation.status ?? null}`); fire(`notify:${notified.at(-1)}`); },
    notifyBingo: (value) => { notified.push(`bingo:${value?.presentation.status ?? null}`); fire(`notify:${notified.at(-1)}`); },
    acceptLineReceipt: (event, id) => { accepted.push(`line:${id}`); return event === authorized; },
    acceptBingoReceipt: (event, id) => { accepted.push(`bingo:${id}`); return event === authorized; },
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
  return { wiring, store, current, calls, published, notified, accepted, authorized, advance, hooks };
}

test('construction begins nothing: no publish, store transition, notification or busy slot', () => {
  const h = harness();
  assert.deepEqual([h.published, h.calls, h.notified, h.wiring.busy()], [[], [], [], false]);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1'), false);
  assert.deepEqual(h.calls, []);
});

test('Bingo receipts are authorized by the Bingo delivery port and routed only to the Bingo coordinator', () => {
  const h = harness();
  h.wiring.bingo.begin(h.current.bingo);
  assert.deepEqual(h.published, ['bingo:B1:4000']);
  assert.equal(h.wiring.busy(), true);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 42), false);
  assert.equal(h.wiring.bingoReceipt({ sender: 'stale' }, 'B1'), false);
  assert.equal(h.wiring.lineReceipt(h.authorized, 'B1'), false);
  assert.deepEqual([h.accepted, h.calls], [['bingo:B1', 'line:B1'], []]);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1'), true);
  assert.deepEqual(h.calls, ['bingo:start:B1']);
  h.advance(4000);
  assert.deepEqual([h.calls, h.notified, h.wiring.busy()], [['bingo:start:B1', 'bingo:complete:B1'],
    ['bingo:started', 'bingo:completed'], false]);
});

test('an active Bingo keeps Line from publishing and blocks manual Line paths before any store mutation', () => {
  const h = harness();
  h.wiring.bingo.begin(h.current.bingo);
  assert.throws(() => h.wiring.line.retry('L1'), /busy/);
  h.current.line = award('L2', 'interrupted');
  assert.throws(() => h.wiring.line.repeat('L2'), /busy/);
  assert.deepEqual(h.calls, []);
  h.current.line = award('L3');
  h.wiring.line.begin(h.current.line);
  assert.deepEqual([h.published, h.calls], [['bingo:B1:4000'], ['line:fail:L3']]);
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L3'), false);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1'), true);
  assert.deepEqual(h.calls, ['line:fail:L3', 'bingo:start:B1']);
});

test('an active Line keeps Bingo from publishing; its own run and manual paths behave as before', () => {
  const h = harness();
  h.wiring.line.retry('L1');
  assert.deepEqual([h.published, h.calls, h.wiring.busy()], [['line:L1r:4000'], ['line:retry:L1'], true]);
  assert.throws(() => h.wiring.line.retry('L1r'), /busy/);
  h.wiring.bingo.begin(h.current.bingo);
  assert.deepEqual([h.published, h.calls], [['line:L1r:4000'], ['line:retry:L1', 'bingo:fail:B1']]);
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L1r'), true);
  h.advance(3999);
  assert.equal(h.wiring.busy(), true);
  h.advance(1);
  assert.equal(h.wiring.busy(), false);
  assert.deepEqual(h.calls.slice(2), ['line:start:L1r', 'line:complete:L1r']);
  // Once the line finished, a fresh Bingo award may publish again.
  h.current.bingo = award('B2');
  h.wiring.bingo.begin(h.current.bingo);
  assert.deepEqual(h.published, ['line:L1r:4000', 'bingo:B2:4000']);
});

test('a competing begin from inside the publisher never publishes the other kind, in both directions', () => {
  const h = harness();
  h.current.line = award('L3');
  h.hooks['publish:line:L3'] = () => h.wiring.bingo.begin(h.current.bingo);
  h.wiring.line.begin(h.current.line);
  assert.deepEqual([h.published, h.calls], [['line:L3:4000'], ['bingo:fail:B1']]);
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L3'), true);
  const g = harness();
  g.current.line = award('L3');
  g.hooks['publish:bingo:B1'] = () => g.wiring.line.begin(g.current.line);
  g.wiring.bingo.begin(g.current.bingo);
  assert.deepEqual([g.published, g.calls], [['bingo:B1:4000'], ['line:fail:L3']]);
  assert.equal(g.wiring.bingoReceipt(g.authorized, 'B1'), true);
});

test('a competing begin or manual retry inside receipt store and notify callbacks leaves the original run whole', () => {
  // Outcomes are recorded, not asserted, inside the callbacks: a throw there would look like a store refusal.
  const outcomes: string[] = [];
  const attempt = (name: string, action: () => unknown) => {
    try { outcomes.push(`${name}:${String(action())}`); } catch { outcomes.push(`${name}:refused`); }
  };
  const h = harness();
  h.wiring.line.retry('L1');
  const lineCompetes = (bingoId: string) => () => {
    h.current.bingo = award(bingoId);
    h.wiring.bingo.begin(h.current.bingo);
    attempt('retry', () => h.wiring.line.retry('L1r'));
    attempt('receipt', () => h.wiring.lineReceipt(h.authorized, 'L1r'));
  };
  h.hooks['line:start:L1r'] = lineCompetes('B2');
  h.hooks['notify:line:started'] = lineCompetes('B3');
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L1r'), true);
  h.advance(4000);
  assert.deepEqual([h.published, h.calls, h.notified, h.wiring.busy()], [['line:L1r:4000'],
    ['line:retry:L1', 'line:start:L1r', 'bingo:fail:B2', 'bingo:fail:B3', 'line:complete:L1r'],
    ['line:pending', 'bingo:failed', 'line:started', 'bingo:failed', 'line:completed'], false]);
  const g = harness();
  g.wiring.bingo.begin(g.current.bingo);
  const bingoCompetes = (lineId: string) => () => {
    g.current.line = award(lineId);
    g.wiring.line.begin(g.current.line);
    attempt('retry', () => g.wiring.line.retry(lineId));
    attempt('receipt', () => g.wiring.bingoReceipt(g.authorized, 'B1'));
  };
  g.hooks['bingo:start:B1'] = bingoCompetes('L4');
  g.hooks['notify:bingo:started'] = bingoCompetes('L5');
  assert.equal(g.wiring.bingoReceipt(g.authorized, 'B1'), true);
  g.advance(4000);
  assert.deepEqual([g.published, g.calls, g.wiring.busy()], [['bingo:B1:4000'],
    ['bingo:start:B1', 'line:fail:L4', 'line:fail:L5', 'bingo:complete:B1'], false]);
  assert.deepEqual(outcomes, Array(4).fill(['retry:refused', 'receipt:false']).flat());
});

test('ownership is released after undelivered, refused, timed-out and completed runs', () => {
  const h = harness();
  h.current.line = award('L3');
  h.hooks['publish:line:L3'] = () => { throw new Error('send failed'); };
  h.wiring.line.begin(h.current.line);
  assert.deepEqual([h.calls, h.wiring.busy()], [['line:fail:L3'], false]);
  h.hooks['bingo:start:B1'] = () => { throw new Error('start refused'); };
  h.wiring.bingo.begin(h.current.bingo);
  assert.equal(h.wiring.bingoReceipt(h.authorized, 'B1'), false);
  assert.deepEqual([h.calls.slice(1), h.wiring.busy()], [['bingo:start:B1', 'bingo:fail:B1'], false]);
  h.wiring.line.retry('L3');
  h.advance(2000);
  assert.deepEqual([h.calls.slice(3), h.wiring.busy()], [['line:retry:L3', 'line:fail:L3r'], false]);
  h.hooks['notify:line:started'] = () => { throw new Error('operator gone'); };
  h.wiring.line.retry('L3r');
  assert.equal(h.wiring.lineReceipt(h.authorized, 'L3rr'), true);
  h.advance(4000);
  h.current.bingo = award('B2');
  h.wiring.bingo.begin(h.current.bingo);
  assert.deepEqual(h.published, ['line:L3:4000', 'bingo:B1:4000', 'line:L3r:4000', 'line:L3rr:4000', 'bingo:B2:4000']);
  assert.deepEqual(h.calls.slice(5), ['line:retry:L3r', 'line:start:L3rr', 'line:complete:L3rr']);
});

test('main registers the Bingo receipt channel through the wiring and never begins Bingo itself', () => {
  // Structural supplement only: Electron main cannot load under node:test, so the factory tests above carry behavior.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /createPresentationWiring\(/);
  assert.match(main, /ipcMain\.on\(PUBLIC_BINGO_RECEIPT_CHANNEL,[^)]*\)\s*=>\s*\{?\s*presentations\.bingoReceipt\(/);
  assert.match(main, /acceptBingoReceipt\(event, id, publicUrl\)/);
  assert.doesNotMatch(main, /bingo\.begin\(|createBingoPresentationCoordinator/);
});
