import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorController } from '../src/operator-controller.mjs';
import type { EventResult } from '../src/event-ipc.ts';

const time = '2026-01-01T00:00:00.000Z';
const success = (...calledNumbers: number[]): EventResult => ({ ok: true,
  snapshot: { calledNumbers, phase: 'drawing', lastTransitionAt: null } });
const phased = (phase: string, lastTransitionAt: unknown, calledNumbers: unknown) =>
  ({ ok: true, snapshot: { calledNumbers, phase, lastTransitionAt } }) as EventResult;
const failure = (message: string): EventResult => ({ ok: false, code: 'storage_failure', message });
function deferred() {
  let resolve!: (value: EventResult) => void;
  const promise = new Promise<EventResult>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const calls: string[] = [];
  const handlers: { manual?: (number: number) => void; digital?: () => void; reload?: () => void } = {};
  const renders: unknown[] = [];
  let cleared = 0;
  const responses: { get: () => Promise<EventResult>; manual: () => Promise<EventResult>; digital: () => Promise<EventResult> } = {
    get: async () => success(90, 1), manual: async () => success(90, 1, 45), digital: async () => success(90, 1, 45, 2),
  };
  const controller = createOperatorController({
    getCurrentEvent: () => { calls.push('get'); return responses.get(); },
    drawManual: (number) => { calls.push(`manual:${number}`); return responses.manual(); },
    drawDigital: () => { calls.push('digital'); return responses.digital(); },
  }, {
    bind: (callbacks) => { Object.assign(handlers, callbacks); },
    clearManual: () => { cleared++; },
    render: (state) => { renders.push(structuredClone(state)); },
  });
  return { controller, calls, handlers, renders, responses, cleared: () => cleared,
    last: () => renders.at(-1) as { calledNumbers: number[]; remaining: number; phase: string | null; stale: boolean; error: string | null;
      pending: boolean; manualDisabled: boolean; digitalDisabled: boolean; reloadDisabled: boolean } };
}

test('initial get renders persisted order, remaining count, and a non-stale state', async () => {
  const f = fixture();
  await f.controller.start();
  assert.deepEqual(f.calls, ['get']);
  assert.deepEqual(f.last(), { calledNumbers: [90, 1], remaining: 88, phase: 'drawing', stale: false, error: null,
    pending: false, manualDisabled: false, digitalDisabled: false, reloadDisabled: false,
    snapshot: { calledNumbers: [90, 1], phase: 'drawing', lastTransitionAt: null } });
  assert.equal(typeof f.handlers.reload, 'function');
});

test('the acknowledged snapshot for the simulator is absent before load and kept through failures', async () => {
  const f = fixture();
  f.responses.get = async () => failure('Could not read.');
  await f.controller.start();
  assert.equal((f.renders.at(-1) as { snapshot: unknown }).snapshot, null);
  f.responses.get = async () => phased('line_declared', time, [4, 5]);
  await f.controller.start();
  f.responses.digital = async () => failure('Write failed');
  f.handlers.digital?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((f.renders.at(-1) as { snapshot: unknown }).snapshot,
    { calledNumbers: [4, 5], phase: 'line_declared', lastTransitionAt: time });
});

test('manual and digital actions render only acknowledged IPC snapshots and clear manual only on success', async () => {
  const f = fixture();
  await f.controller.start();
  const manual = deferred();
  f.responses.manual = () => manual.promise;
  f.handlers.manual?.(45);
  assert.deepEqual(f.last().calledNumbers, [90, 1]);
  assert.equal(f.last().pending, true);
  assert.equal(f.cleared(), 0);
  manual.resolve(success(90, 1, 45));
  await manual.promise;
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1, 45]);
  assert.equal(f.cleared(), 1);
  const digital = deferred();
  f.responses.digital = () => digital.promise;
  f.handlers.digital?.();
  assert.deepEqual(f.last().calledNumbers, [90, 1, 45]);
  digital.resolve(success(90, 1, 45, 2));
  await digital.promise;
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1, 45, 2]);
  assert.deepEqual(f.calls, ['get', 'manual:45', 'digital']);
});

test('pending actions suppress all concurrent submissions and disable controls', async () => {
  const f = fixture();
  await f.controller.start();
  const waiting = deferred();
  f.responses.manual = () => waiting.promise;
  f.handlers.manual?.(45);
  assert.equal(f.last().manualDisabled, true);
  assert.equal(f.last().digitalDisabled, true);
  assert.equal(f.last().reloadDisabled, true);
  f.handlers.manual?.(45);
  f.handlers.digital?.();
  f.handlers.reload?.();
  assert.deepEqual(f.calls, ['get', 'manual:45']);
  waiting.resolve(success(90, 1, 45));
  await waiting.promise;
  await new Promise(setImmediate);
  assert.equal(f.last().pending, false);
});

test('expected IPC failure preserves acknowledged history, marks stale and displays returned message', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.manual = async () => failure('Could not save the draw. Reload and try again.');
  f.handlers.manual?.(45);
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1]);
  assert.equal(f.last().remaining, 88);
  assert.equal(f.last().stale, true);
  assert.equal(f.last().error, 'Could not save the draw. Reload and try again.');
  assert.equal(f.cleared(), 0);
  f.responses.get = async () => success(90, 1, 3);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1, 3]);
  assert.equal(f.last().remaining, 87);
  assert.equal(f.last().stale, false);
  assert.equal(f.last().error, null);
});

test('rejected IPC and failed reload preserve state with stable connection feedback', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.digital = async () => { throw new Error('secret transport detail'); };
  f.handlers.digital?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1]);
  assert.equal(f.last().stale, true);
  assert.equal(f.last().error, 'Could not connect to the event. Reload and try again.');
  f.responses.get = async () => failure('Could not read the current event. Try again.');
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [90, 1]);
  assert.equal(f.last().error, 'Could not read the current event. Try again.');
});

test('initial read failure keeps draws unavailable until a successful reload', async () => {
  const f = fixture();
  f.responses.get = async () => failure('No current event is available.');
  await f.controller.start();
  assert.deepEqual(f.last().calledNumbers, []);
  assert.equal(f.last().stale, true);
  assert.equal(f.last().error, 'No current event is available.');
  assert.equal(f.last().manualDisabled, true);
  assert.equal(f.last().digitalDisabled, true);
  assert.equal(f.last().reloadDisabled, false);
  f.handlers.digital?.();
  assert.deepEqual(f.calls, ['get']);
  f.responses.get = async () => success(7);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [7]);
  assert.equal(f.last().stale, false);
  assert.equal(f.last().manualDisabled, false);
});

test('phase snapshots can jump across missed transitions and preserve history on invalid or stale updates', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.get = async () => phased('bingo_declared', time, [90, 1, 45]);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.equal(f.last().phase, 'bingo_declared');
  assert.deepEqual(f.last().calledNumbers, [90, 1, 45]);
  const bad = [
    { calledNumbers: [90, 1, 45, 2], lastTransitionAt: time },
    { calledNumbers: [90, 1, 45, 2], phase: 'unknown', lastTransitionAt: time },
    { calledNumbers: [90, 1, 45, 2], phase: 'drawing', lastTransitionAt: null },
    { calledNumbers: [90, 1, 45, 2], phase: 'finished', lastTransitionAt: 'not-a-date' },
    { calledNumbers: [90, 1, 45, 2], phase: 'finished', lastTransitionAt: '2025-12-31T00:00:00.000Z' },
    { calledNumbers: [1, 90, 45, 2], phase: 'finished', lastTransitionAt: '2026-01-02T00:00:00.000Z' },
  ];
  for (const snapshot of bad) {
    f.responses.get = async () => ({ ok: true, snapshot }) as EventResult;
    f.handlers.reload?.();
    await new Promise(setImmediate);
    assert.equal(f.last().phase, 'bingo_declared');
    assert.deepEqual(f.last().calledNumbers, [90, 1, 45]);
    assert.equal(f.last().stale, true);
    assert.equal(f.last().error, 'Invalid event update. Reload and try again.');
  }
  f.responses.get = async () => phased('drawing', '2026-01-02T00:00:00.000Z', [90, 1, 45, 2]);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.equal(f.last().phase, 'drawing', 'a correction may return to drawing with a non-null timestamp');
  assert.deepEqual(f.last().calledNumbers, [90, 1, 45, 2]);
  assert.equal(f.last().error, null);
});

test('invalid bootstrap leaves phase unknown and controls disabled until a valid snapshot arrives', async () => {
  const f = fixture();
  f.responses.get = async () => phased('checking_line', null, []);
  await f.controller.start();
  assert.equal(f.last().phase, null);
  assert.equal(f.last().manualDisabled, true);
  assert.equal(f.last().stale, true);
  f.responses.get = async () => phased('checking_line', time, [7]);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.equal(f.last().phase, 'checking_line');
  assert.equal(f.last().stale, false);
});

test('exhaustion disables draws but still allows reload', async () => {
  const f = fixture();
  f.responses.get = async () => success(...Array.from({ length: 90 }, (_, i) => i + 1));
  await f.controller.start();
  assert.equal(f.last().remaining, 0);
  assert.equal(f.last().manualDisabled, true);
  assert.equal(f.last().digitalDisabled, true);
  assert.equal(f.last().reloadDisabled, false);
  f.handlers.manual?.(45);
  f.handlers.digital?.();
  assert.deepEqual(f.calls, ['get']);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['get', 'get']);
});

test('resync after an event switch replaces the old history instead of flagging it stale', async () => {
  const f = fixture();
  await f.controller.start();
  let release!: (value: EventResult) => void;
  f.responses.digital = () => new Promise((resolve) => { release = resolve; });
  f.handlers.digital!();
  f.responses.get = async () => success(7);
  const resync = f.controller.resync();
  release(success(90, 1, 2));
  await resync;
  assert.deepEqual(f.calls, ['get', 'digital', 'get']);
  assert.deepEqual([f.last().calledNumbers, f.last().stale, f.last().error], [[7], false, null]);
});

// First-line declaration: the controller drives the main-owned setup session and never invents state.
import { createLineController } from '../src/operator-controller.mjs';

const lineSession = { sessionId: 's1', eventId: 'e1', calledNumbers: [4, 9], linePrize: { amount: 10, lot: '' } };
const lineAward = { eventId: 'e1', award: { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: '',
  lotResolution: 'not_required' }, presentation: { id: 'p1', status: 'pending', startedAt: null, deadlineAt: null } };
const lineFailure = (code: string, message: string) => ({ ok: false, code, message });

type LineState = { mode: string; pending: boolean; error: string | null; countError: string | null; dialogOpen: boolean;
  session: typeof lineSession | null; award: typeof lineAward | null; drawBlocked: boolean; liveBlocked: boolean; refresh: string };
function lineFixture() {
  const calls: string[] = [];
  const renders: LineState[] = [];
  let refreshed = 0;
  let unsubscribed = 0;
  let subscribedAt = -1;
  let push: (value: unknown) => void = () => { throw new Error('not subscribed'); };
  const refresh = { ok: true };
  const replies: Record<string, () => Promise<unknown>> = {
    read: async () => ({ ok: true, state: 'none' }),
    begin: async () => ({ ok: true, session: lineSession }),
    cancel: async () => ({ ok: true }),
    confirm: async () => ({ ok: true, award: lineAward }),
    retry: async () => ({ ok: true, award: lineAward }),
    repeat: async () => ({ ok: true, award: lineAward }),
  };
  const controller = createLineController({
    readLineSetup: () => { calls.push('read'); return replies.read(); },
    beginLineSetup: () => { calls.push('begin'); return replies.begin(); },
    cancelLineSetup: (id: string, event: string) => { calls.push(`cancel:${id}:${event}`); return replies.cancel(); },
    confirmLine: (id: string, event: string, count: number) => { calls.push(`confirm:${id}:${event}:${count}`); return replies.confirm(); },
    retryLinePresentation: (id: string) => { calls.push(`retry:${id}`); return replies.retry(); },
    repeatLinePresentation: (id: string) => { calls.push(`repeat:${id}`); return replies.repeat(); },
    onLinePresentation: (callback: (value: unknown) => void) => {
      subscribedAt = calls.length;
      push = callback;
      return () => { unsubscribed++; };
    },
  }, { render: (state: LineState) => { renders.push(structuredClone(state)); } },
  { committed: async () => { refreshed++; return refresh.ok; } });
  return { controller, calls, replies, refresh, push: (value: unknown) => push(value), refreshed: () => refreshed,
    unsubscribed: () => unsubscribed, subscribedAt: () => subscribedAt, last: () => renders.at(-1) as LineState };
}

test('line recovery reads on start and never begins, cancels or confirms', async () => {
  const f = lineFixture();
  f.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await f.controller.start();
  assert.deepEqual(f.calls, ['read']);
  assert.deepEqual([f.last().mode, f.last().dialogOpen, f.last().session?.sessionId], ['setup', false, 's1']);
});

test('line recovery of a committed award shows it without refreshing as a new commit', async () => {
  const f = lineFixture();
  f.replies.read = async () => ({ ok: true, state: 'declared', award: lineAward });
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award?.award.winnerCount, f.refreshed()], ['declared', 3, 0]);
});

test('recovering an interrupted award keeps its old id and times, refreshes nothing and offers no action', async () => {
  const f = lineFixture();
  const interrupted = { ...lineAward, presentation: { id: 'old', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 } };
  f.replies.read = async () => ({ ok: true, state: 'declared', award: interrupted });
  await f.controller.start();
  assert.deepEqual(f.last().award?.presentation, interrupted.presentation);
  assert.deepEqual([f.last().mode, f.last().dialogOpen, f.refreshed(), f.calls], ['declared', false, 0, ['read']]);
  await f.controller.open();
  assert.deepEqual(f.calls, ['read', 'read'], 'a declared award only rereads; it never begins or confirms');
});

test('opening begins one setup and opens the dialog; confirming sends the explicit count once', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  assert.deepEqual([f.calls.join(), f.last().mode, f.last().dialogOpen], ['read,begin', 'setup', true]);
  await f.controller.confirm(' 3 ');
  assert.deepEqual(f.calls, ['read', 'begin', 'confirm:s1:e1:3']);
  assert.deepEqual([f.last().mode, f.last().dialogOpen, f.last().award?.award.shareCents, f.refreshed()], ['declared', false, 333, 1]);
});

test('cancelling writes through cancel only and returns to idle; a failed cancel asks to check', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  await f.controller.cancel();
  assert.deepEqual([f.calls.at(-1), f.last().mode, f.last().dialogOpen], ['cancel:s1:e1', 'idle', false]);
  await f.controller.open();
  f.replies.cancel = async () => lineFailure('stale_session', 'This setup is no longer current. Reopen it.');
  await f.controller.cancel();
  assert.deepEqual([f.last().mode, f.last().error], ['uncertain', 'This setup is no longer current. Reopen it.']);
});

test('invalid winner counts never reach main and keep the dialog open with an inline error', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  for (const bad of ['', '0', '-1', '1.5', 'abc', '1e3', '9007199254740993']) {
    await f.controller.confirm(bad);
    assert.equal(f.last().countError, 'Enter a whole number of winners, 1 or more.', bad);
    assert.deepEqual([f.last().mode, f.last().dialogOpen], ['setup', true]);
  }
  assert.deepEqual(f.calls, ['read', 'begin']);
  await f.controller.confirm('9007199254740991');
  assert.equal(f.calls.at(-1), 'confirm:s1:e1:9007199254740991');
});

test('an existing setup is adopted through read when begin reports it open', async () => {
  const f = lineFixture();
  await f.controller.start();
  f.replies.begin = async () => lineFailure('setup_active', 'A first-line setup is already open. Reopen it to continue.');
  f.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await f.controller.open();
  assert.deepEqual([f.calls.join(), f.last().mode, f.last().dialogOpen, f.last().error], ['read,begin,read', 'setup', true, null]);
});

test('a refused begin reports the main message and stays idle', async () => {
  const f = lineFixture();
  await f.controller.start();
  f.replies.begin = async () => lineFailure('not_available', 'The first line cannot be declared now.');
  await f.controller.open();
  assert.deepEqual([f.last().mode, f.last().dialogOpen, f.last().error], ['idle', false, 'The first line cannot be declared now.']);
});

test('a failed confirm becomes uncertain, never retries, and the next action only reads', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  f.replies.confirm = async () => lineFailure('storage_failure', 'Could not declare the line. Reopen the setup and check the state before trying again.');
  await f.controller.confirm('2');
  assert.deepEqual([f.last().mode, f.last().dialogOpen, f.last().award, f.refreshed()], ['uncertain', false, null, 0]);
  assert.equal(f.calls.filter((call) => call.startsWith('confirm')).length, 1);
  f.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await f.controller.open();
  assert.deepEqual([f.calls.slice(-1)[0], f.last().mode, f.last().dialogOpen], ['read', 'setup', true]);
  assert.equal(f.calls.filter((call) => call.startsWith('confirm')).length, 1, 'reading does not confirm again');
});

test('a thrown confirm or an unreadable acknowledgement is uncertain and recovered as committed by read', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  f.replies.confirm = async () => { throw new Error('ipc'); };
  await f.controller.confirm('1');
  assert.deepEqual([f.last().mode, f.last().error], ['uncertain', 'Could not connect to the first-line setup. Check the state and try again.']);
  f.replies.read = async () => ({ ok: true, state: 'declared', award: lineAward });
  await f.controller.open();
  assert.deepEqual([f.last().mode, f.refreshed(), f.calls.filter((call) => call === 'begin').length], ['declared', 1, 1]);
});

test('malformed main replies fail closed without exposing state', async () => {
  const f = lineFixture();
  f.replies.read = async () => ({ ok: true, state: 'declared', award: { eventId: 'e1', award: { winnerCount: 0 } } });
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award, f.last().error], ['uncertain', null,
    'Invalid first-line update. Check the state and try again.']);
});

test('only one line operation runs at a time', async () => {
  const f = lineFixture();
  await f.controller.start();
  let release!: (value: unknown) => void;
  f.replies.begin = () => new Promise((resolve) => { release = resolve; });
  const first = f.controller.open();
  const second = f.controller.open();
  assert.equal(f.last().pending, true);
  release({ ok: true, session: lineSession });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((call) => call === 'begin').length, 1);
});

test('the dialog is already closed in every render while a confirm or cancel is in flight', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  const seen: boolean[] = [];
  const confirming = f.controller.confirm('2');
  seen.push(f.last().pending && f.last().dialogOpen);
  await confirming;
  await f.controller.open();
  const cancelling = f.controller.cancel();
  seen.push(f.last().pending && f.last().dialogOpen);
  await cancelling;
  assert.deepEqual(seen, [false, false]);
});

// Presentation recovery: explicit retry/repeat, pushes, races and fail-closed validation.
const presentationOf = (status: string, id = 'p1') => ({ id, status,
  ...(status === 'pending' || status === 'failed' ? { startedAt: null, deadlineAt: null } : { startedAt: 1000, deadlineAt: 5000 }) });
const awardAt = (status: string, id = 'p1', eventId = 'e1') => ({ ...lineAward, eventId, presentation: presentationOf(status, id) });
const declaredReply = (value: unknown) => async () => ({ ok: true, state: 'declared', award: value });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function declaredFixture(status: string, id = 'p1') {
  const f = lineFixture();
  f.replies.read = declaredReply(awardAt(status, id));
  await f.controller.start();
  return f;
}

test('the push subscription exists before the first read and is released by dispose', async () => {
  const f = lineFixture();
  await f.controller.start();
  assert.deepEqual([f.subscribedAt(), f.calls], [0, ['read']]);
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(f.unsubscribed(), 1);
});

test('retry invokes only the exact failed id and repeat only the exact interrupted id', async () => {
  for (const [status, retry, repeat] of [['pending', false, false], ['started', false, false], ['completed', false, false],
    ['failed', true, false], ['interrupted', false, true]] as const) {
    const f = await declaredFixture(status);
    await f.controller.retry('p1');
    await f.controller.repeat('p1');
    await f.controller.retry('other');
    await f.controller.repeat('other');
    assert.deepEqual(f.calls.slice(1), [...(retry ? ['retry:p1'] : []), ...(repeat ? ['repeat:p1'] : [])], status);
  }
  const idle = lineFixture();
  await idle.controller.start();
  await idle.controller.retry('p1');
  assert.deepEqual(idle.calls, ['read']);
});

test('a retry or repeat result with a rotated id is adopted and the retired id can never come back', async () => {
  for (const [status, call] of [['failed', 'retry'], ['interrupted', 'repeat']] as const) {
    const f = await declaredFixture(status);
    f.replies[call] = async () => ({ ok: true, award: awardAt('pending', 'p2') });
    await (call === 'retry' ? f.controller.retry('p1') : f.controller.repeat('p1'));
    assert.deepEqual([f.last().award?.presentation.id, f.last().award?.presentation.status, f.last().mode], ['p2', 'pending', 'declared']);
    f.push(awardAt(status, 'p1'));
    assert.equal(f.last().award?.presentation.id, 'p2', 'a push of the retired id is ignored');
    f.replies.read = declaredReply(awardAt(status, 'p1'));
    await f.controller.start();
    assert.equal(f.last().award?.presentation.id, 'p2', 'a late read of the retired id is ignored');
  }
});

test('a double click sends one request and the second click does nothing', async () => {
  const f = await declaredFixture('failed');
  let release!: (value: unknown) => void;
  f.replies.retry = () => new Promise((resolve) => { release = resolve; });
  const first = f.controller.retry('p1');
  const second = f.controller.retry('p1');
  assert.equal(f.last().pending, true);
  release({ ok: true, award: awardAt('pending', 'p2') });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((call) => call.startsWith('retry')).length, 1);
  assert.equal(f.last().pending, false);
});

test('the action shares the lock with read, confirm and cancel', async () => {
  const f = await declaredFixture('interrupted');
  let release!: (value: unknown) => void;
  f.replies.repeat = () => new Promise((resolve) => { release = resolve; });
  const running = f.controller.repeat('p1');
  void f.controller.start();
  void f.controller.open();
  void f.controller.confirm('2');
  void f.controller.cancel();
  release({ ok: true, award: awardAt('pending', 'p2') });
  await running;
  assert.deepEqual(f.calls.slice(1), ['repeat:p1']);
});

test('pushes that arrive before the action response are kept and never overwritten by the older reply', async () => {
  const f = await declaredFixture('failed');
  let release!: (value: unknown) => void;
  f.replies.retry = () => new Promise((resolve) => { release = resolve; });
  const running = f.controller.retry('p1');
  f.push(awardAt('pending', 'p2'));
  f.push(awardAt('started', 'p2'));
  f.push(awardAt('completed', 'p2'));
  release({ ok: true, award: awardAt('pending', 'p2') });
  await running;
  await flush();
  assert.deepEqual([f.last().award?.presentation.id, f.last().award?.presentation.status, f.last().pending], ['p2', 'completed', false]);
  assert.equal(f.refreshed(), 1);
});

test('a read that answers older than a push for the same id does not regress it', async () => {
  const f = await declaredFixture('pending');
  let release!: (value: unknown) => void;
  f.replies.read = () => new Promise((resolve) => { release = resolve; });
  const reading = f.controller.start();
  f.push(awardAt('started'));
  release({ ok: true, state: 'declared', award: awardAt('pending') });
  await reading;
  assert.equal(f.last().award?.presentation.status, 'started');
});

test('a push for a new id outside any action is ignored, and a foreign event never changes the state', async () => {
  const f = await declaredFixture('pending');
  f.push(awardAt('completed', 'p9'));
  f.push(awardAt('completed', 'p1', 'zzz'));
  assert.deepEqual([f.last().award?.presentation.status, f.refreshed()], ['pending', 0]);
  f.push(awardAt('started'));
  assert.equal(f.last().award?.presentation.status, 'started');
});

test('a null or corrupt push fails closed with an explicit check and a read recovers', async () => {
  const corrupt: unknown[] = [null, 'x', { eventId: 'e1', award: lineAward.award, presentation: { id: 'p1', status: 'bogus', startedAt: null, deadlineAt: null } },
    { ...awardAt('completed'), presentation: { id: 'p1', status: 'completed', startedAt: 1000, deadlineAt: 4999 } },
    { ...awardAt('started'), presentation: { id: 'p1', status: 'started', startedAt: 1000.5, deadlineAt: 5000.5 } },
    { ...awardAt('pending'), presentation: { id: 'p1', status: 'pending', startedAt: 1000, deadlineAt: null } },
    { ...awardAt('pending'), presentation: { id: '', status: 'pending', startedAt: null, deadlineAt: null } },
    { ...awardAt('pending'), award: { ...lineAward.award, lotResolution: 'weird' } }];
  for (const value of corrupt) {
    const f = await declaredFixture('pending');
    f.push(value);
    assert.deepEqual([f.last().mode, f.last().award, f.last().drawBlocked, f.last().error],
      ['uncertain', null, true, 'Invalid first-line update. Check the state and try again.'], JSON.stringify(value));
    f.push(awardAt('completed'));
    assert.equal(f.last().mode, 'uncertain', 'only an explicit check leaves the uncertain state');
    f.replies.read = declaredReply(awardAt('completed'));
    await f.controller.open();
    assert.deepEqual([f.last().mode, f.last().award?.presentation.status], ['declared', 'completed']);
  }
});

test('an unknown action result or a refusal becomes uncertain and is never invoked again', async () => {
  for (const reply of [async () => { throw new Error('ipc'); }, async () => undefined, async () => ({ ok: true }),
    async () => ({ ok: true, award: awardAt('pending', 'p2', 'zzz') }),
    async () => ({ ok: false, code: 'presentation_busy', message: 'Wait for the line celebration to finish first.' })]) {
    const f = await declaredFixture('failed');
    f.replies.retry = reply;
    await f.controller.retry('p1');
    assert.deepEqual([f.last().mode, f.last().drawBlocked, f.last().award], ['uncertain', true, null]);
    await f.controller.retry('p1');
    assert.deepEqual(f.calls.filter((call) => call.startsWith('retry')), ['retry:p1']);
  }
});

test('the draw lock follows the known presentation: only a refreshed completed state unlocks', async () => {
  for (const [status, blocked, live] of [['pending', true, true], ['started', true, true], ['failed', true, false],
    ['interrupted', true, false], ['completed', false, false]] as const) {
    const f = await declaredFixture(status);
    await flush();
    assert.deepEqual([f.last().drawBlocked, f.last().liveBlocked], [blocked, live], status);
  }
  const idle = lineFixture();
  assert.equal(idle.last().drawBlocked, true, 'unknown is locked');
  await idle.controller.start();
  assert.equal(idle.last().drawBlocked, false);
  idle.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await idle.controller.start();
  assert.deepEqual([idle.last().drawBlocked, idle.last().liveBlocked], [true, true]);
});

test('a completed award with a tied lot still pending unlocks drawing after one refresh', async () => {
  const tied = { ...awardAt('completed'), award: { ...lineAward.award, winnerCount: 2, shareCents: 500, remainderCents: 0, lot: 'Jamón', lotResolution: 'pending' } };
  const f = lineFixture();
  f.replies.read = declaredReply(awardAt('pending'));
  await f.controller.start();
  f.push({ ...tied, presentation: presentationOf('started') });
  assert.equal(f.last().drawBlocked, true);
  f.push(tied);
  assert.deepEqual([f.last().drawBlocked, f.last().refresh], [true, 'pending']);
  await flush();
  assert.deepEqual([f.refreshed(), f.last().drawBlocked, f.last().refresh, f.last().award?.award.lotResolution], [1, false, 'none', 'pending']);
  f.push(tied);
  await flush();
  assert.equal(f.refreshed(), 1, 'the same completion does not refresh twice');
});

test('a failed required refresh keeps drawing blocked until an explicit retry succeeds', async () => {
  const f = await declaredFixture('started');
  f.refresh.ok = false;
  f.push(awardAt('completed'));
  await flush();
  assert.deepEqual([f.last().drawBlocked, f.last().refresh, f.refreshed()], [true, 'failed', 1]);
  await f.controller.retryRefresh();
  await flush();
  assert.deepEqual([f.last().drawBlocked, f.refreshed()], [true, 2]);
  f.refresh.ok = true;
  await f.controller.retryRefresh();
  await flush();
  assert.deepEqual([f.last().drawBlocked, f.last().refresh, f.refreshed()], [false, 'none', 3]);
});

test('a completion discovered by the first read after load also refreshes the event', async () => {
  const f = await declaredFixture('completed');
  await flush();
  assert.deepEqual([f.refreshed(), f.last().drawBlocked], [1, false]);
  await f.controller.start();
  await flush();
  assert.equal(f.refreshed(), 1, 'a later read of the same completion does not refresh again');
});

test('a stale read or a foreign push after the active event changed never becomes authority', async () => {
  const f = lineFixture();
  f.controller.setEvent('e1');
  let release!: (value: unknown) => void;
  f.replies.read = () => new Promise((resolve) => { release = resolve; });
  const reading = f.controller.start();
  f.controller.setEvent('e2');
  assert.deepEqual([f.last().mode, f.last().drawBlocked], ['unknown', true]);
  release({ ok: true, state: 'declared', award: awardAt('completed') });
  await reading;
  f.push(awardAt('completed'));
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, f.refreshed()], ['unknown', null, 0]);
  f.replies.read = async () => ({ ok: true, state: 'none' });
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().drawBlocked], ['idle', false]);
});

test('an award for another event than the active one is rejected as uncertain and never refreshes', async () => {
  const f = lineFixture();
  f.controller.setEvent('e2');
  f.replies.read = declaredReply(awardAt('completed'));
  await f.controller.start();
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, f.last().drawBlocked, f.refreshed()], ['uncertain', null, true, 0]);
});

test('a stale action response after the active event changed is ignored', async () => {
  const f = await declaredFixture('failed');
  f.controller.setEvent('e1');
  let release!: (value: unknown) => void;
  f.replies.retry = () => new Promise((resolve) => { release = resolve; });
  const running = f.controller.retry('p1');
  f.controller.setEvent('e2');
  release({ ok: true, award: awardAt('completed', 'p2') });
  await running;
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, f.refreshed(), f.last().pending], ['unknown', null, 0, false]);
});

test('an award without any presentation keeps the legacy declared mode, locked and without actions', async () => {
  const legacy = { eventId: 'e1', award: lineAward.award };
  const f = lineFixture();
  f.replies.read = declaredReply(legacy);
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().drawBlocked], ['declared', true]);
  await f.controller.retry('p1');
  await f.controller.repeat('p1');
  assert.deepEqual(f.calls, ['read']);
});

test('a push during a confirm in flight for the same event is kept and never opens or cancels the setup', async () => {
  const f = lineFixture();
  await f.controller.start();
  await f.controller.open();
  let release!: (value: unknown) => void;
  f.replies.confirm = () => new Promise((resolve) => { release = resolve; });
  const confirming = f.controller.confirm('3');
  f.push(awardAt('started'));
  release({ ok: true, award: awardAt('pending') });
  await confirming;
  assert.deepEqual([f.last().mode, f.last().award?.presentation.status, f.last().dialogOpen], ['declared', 'started', false]);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('cancel') || call === 'begin'), ['begin']);
});

// Review corrections: store-grade award validation, event generation across null contexts, and read ordering.
type AwardParts = { winnerCount: number; totalCents: number; shareCents: number; remainderCents: number; lot: string; lotResolution: string };
const derivedAward = (winnerCount: number, totalCents: number, lot = '', resolution?: string): AwardParts => ({ winnerCount, totalCents,
  shareCents: Math.floor(totalCents / winnerCount), remainderCents: totalCents % winnerCount, lot,
  lotResolution: resolution ?? (lot !== '' && winnerCount >= 2 ? 'pending' : 'not_required') });
const storedAward = (award: AwardParts, presentation: unknown = presentationOf('completed'), eventId = 'e1') => ({ eventId, award, presentation });
const base = derivedAward(3, 1000);

const malformed: Array<[string, unknown]> = [
  ['combined share/remainder/lot', storedAward({ winnerCount: 2, totalCents: 1000, shareCents: 999, remainderCents: 999, lot: '', lotResolution: 'pending' })],
  ['share off by one', storedAward({ ...base, shareCents: 332 })],
  ['remainder off by one', storedAward({ ...base, remainderCents: 2 })],
  ['remainder not below the count', storedAward({ ...derivedAward(2, 1000), shareCents: 499, remainderCents: 2 })],
  ['total not whole euros', storedAward(derivedAward(1, 1050))],
  ['total above the maximum prize', storedAward(derivedAward(1, 10_000_100))],
  ['negative total', storedAward({ ...base, totalCents: -100 })],
  ['untrimmed lot', storedAward(derivedAward(2, 1000, ' Jamón '))],
  ['lot over 120 characters', storedAward(derivedAward(2, 1000, 'x'.repeat(121)))],
  ['pending resolution without a lot', storedAward({ ...derivedAward(2, 1000), lotResolution: 'pending' })],
  ['not_required resolution for a tied lot', storedAward({ ...derivedAward(2, 1000, 'Jamón'), lotResolution: 'not_required' })],
  ['resolved resolution without a tied lot', storedAward({ ...derivedAward(1, 1000, 'Jamón'), lotResolution: 'resolved' })],
  ['zero winners', storedAward({ ...base, winnerCount: 0 })],
  ['fractional winners', storedAward({ ...base, winnerCount: 1.5 })],
  ['unsafe winners', storedAward({ ...base, winnerCount: Number.MAX_SAFE_INTEGER + 1 })],
  ['negative started time', storedAward(base, { id: 'p1', status: 'completed', startedAt: -4000, deadlineAt: 0 })],
  ['deadline not exactly 4000 later', storedAward(base, { id: 'p1', status: 'started', startedAt: 1000, deadlineAt: 5001 })],
  ['unsafe deadline', storedAward(base, { id: 'p1', status: 'started', startedAt: Number.MAX_SAFE_INTEGER, deadlineAt: Number.MAX_SAFE_INTEGER + 4000 })],
  ['blank presentation id', storedAward(base, { id: '  ', status: 'pending', startedAt: null, deadlineAt: null })],
  ['times on a pending presentation', storedAward(base, { id: 'p1', status: 'pending', startedAt: 0, deadlineAt: 4000 })],
];

test('every malformed award or time part fails closed on read and on push, with no refresh and no unlock', async () => {
  for (const [name, value] of malformed) {
    const read = lineFixture();
    read.replies.read = declaredReply(value);
    await read.controller.start();
    await flush();
    assert.deepEqual([read.last().mode, read.last().drawBlocked, read.refreshed()],
      ['uncertain', true, 0], `read: ${name}`);
    const push = await declaredFixture('pending');
    push.push(value);
    await flush();
    assert.deepEqual([push.last().mode, push.last().award, push.last().drawBlocked, push.refreshed()], ['uncertain', null, true, 0], `push: ${name}`);
    await push.controller.retry('p1');
    assert.deepEqual(push.calls.filter((call) => call.startsWith('retry')), [], name);
  }
});

test('legitimate extremes are still accepted and unlock after one refresh', async () => {
  const valid: Array<[string, unknown]> = [
    ['MAX_SAFE winners', storedAward(derivedAward(Number.MAX_SAFE_INTEGER, 10_000_000))],
    ['zero prize', storedAward(derivedAward(4, 0))],
    ['zero share with a remainder', storedAward(derivedAward(3000, 100_00))],
    ['remainder edge', storedAward(derivedAward(3, 1000))],
    ['maximum prize', storedAward(derivedAward(1, 10_000_000))],
    ['resolved tied lot', storedAward(derivedAward(2, 1000, 'Jamón', 'resolved'))],
    ['pending tied lot', storedAward(derivedAward(2, 1000, 'Jamón'))],
    ['120 character lot', storedAward(derivedAward(1, 500, 'x'.repeat(120)))],
    ['time zero', storedAward(base, { id: 'p1', status: 'completed', startedAt: 0, deadlineAt: 4000 })],
    ['largest safe time', storedAward(base, { id: 'p1', status: 'completed', startedAt: Number.MAX_SAFE_INTEGER - 4000, deadlineAt: Number.MAX_SAFE_INTEGER })],
  ];
  for (const [name, value] of valid) {
    const f = lineFixture();
    f.replies.read = declaredReply(value);
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().drawBlocked, f.refreshed()], ['declared', false, 1], name);
  }
});

test('a response from before a null context boundary is never adopted by the next event', async () => {
  const replies: Array<[string, unknown]> = [
    ['declared', { ok: true, state: 'declared', award: awardAt('completed', 'p1', 'A') }],
    ['setup', { ok: true, state: 'setup', session: { ...lineSession, eventId: 'A' } }],
    ['none', { ok: true, state: 'none' }],
    ['refusal', { ok: false, code: 'storage_failure', message: 'Could not read the first-line state. Try again.' }],
  ];
  for (const [name, reply] of replies) {
    const f = lineFixture();
    f.controller.setEvent('A');
    f.controller.setEvent(null);
    let release!: (value: unknown) => void;
    f.replies.read = () => new Promise((resolve) => { release = resolve; });
    const reading = f.controller.start();
    f.controller.setEvent('B');
    release(reply);
    await reading;
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().drawBlocked, f.last().pending, f.refreshed()],
      ['unknown', null, null, true, false, 0], name);
    f.replies.read = async () => ({ ok: true, state: 'none' });
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().drawBlocked], ['idle', false], `${name}: a new explicit read succeeds`);
  }
});

test('an action answered after a null context boundary is dropped, and the first context still keeps a read in flight', async () => {
  const f = await declaredFixture('failed');
  f.controller.setEvent('e1');
  let release!: (value: unknown) => void;
  f.replies.retry = () => new Promise((resolve) => { release = resolve; });
  const running = f.controller.retry('p1');
  f.controller.setEvent(null);
  f.controller.setEvent('e1');
  release({ ok: true, award: awardAt('completed', 'p2') });
  await running;
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, f.refreshed()], ['unknown', null, 0]);
  const initial = lineFixture();
  let answer!: (value: unknown) => void;
  initial.replies.read = () => new Promise((resolve) => { answer = resolve; });
  const first = initial.controller.start();
  initial.controller.setEvent('e1');
  answer({ ok: true, state: 'declared', award: awardAt('pending') });
  await first;
  assert.equal(initial.last().mode, 'declared', 'the first context assignment keeps the initial read');
});

async function deferredRead(f: ReturnType<typeof lineFixture>) {
  let release!: (value: unknown) => void;
  f.replies.read = () => new Promise((resolve) => { release = resolve; });
  const reading = f.controller.start();
  return { reading, release: (value: unknown) => release(value) };
}

test('an older read that says none never erases a newer pushed award', async () => {
  for (const status of ['pending', 'started', 'completed']) {
    const f = lineFixture();
    f.controller.setEvent('e1');
    const read = await deferredRead(f);
    f.push(awardAt(status));
    read.release({ ok: true, state: 'none' });
    await read.reading;
    await flush();
    assert.deepEqual([f.last().mode, f.last().award?.presentation.status, f.last().pending], ['declared', status, false], status);
    if (status !== 'completed') assert.equal(f.last().drawBlocked, true, status);
    assert.equal(f.last().liveBlocked, status !== 'completed', status);
  }
  const done = lineFixture();
  done.controller.setEvent('e1');
  const read = await deferredRead(done);
  done.push(awardAt('completed'));
  read.release({ ok: true, state: 'none' });
  await read.reading;
  await flush();
  assert.deepEqual([done.last().drawBlocked, done.refreshed()], [false, 1]);
});

test('an older setup, refusal or lost answer never overwrites a newer pushed award', async () => {
  const stale: Array<[string, () => Promise<unknown>]> = [
    ['setup', async () => ({ ok: true, state: 'setup', session: lineSession })],
    ['refusal', async () => ({ ok: false, code: 'storage_failure', message: 'Could not read the first-line state. Try again.' })],
    ['thrown', async () => { throw new Error('ipc'); }],
    ['invalid', async () => ({ ok: true, state: 'declared', award: { eventId: 'e1' } })],
  ];
  for (const [name, reply] of stale) {
    const f = lineFixture();
    f.controller.setEvent('e1');
    let release!: () => void;
    f.replies.read = () => new Promise((resolve) => { release = () => resolve(reply()); });
    const reading = f.controller.start();
    f.push(awardAt('started'));
    release();
    await reading;
    assert.deepEqual([f.last().mode, f.last().award?.presentation.status, f.last().session, f.last().drawBlocked], ['declared', 'started', null, true], name);
  }
});

test('a null or corrupt push during a read is never forgotten in favour of a stale none or award', async () => {
  for (const reply of [{ ok: true, state: 'none' }, { ok: true, state: 'declared', award: awardAt('completed') }]) {
    for (const bad of [null, { eventId: 'e1' }]) {
      const f = lineFixture();
      f.controller.setEvent('e1');
      const read = await deferredRead(f);
      f.push(bad);
      read.release(reply);
      await read.reading;
      await flush();
      assert.deepEqual([f.last().mode, f.last().award, f.last().drawBlocked, f.refreshed()], ['uncertain', null, true, 0]);
      f.replies.read = declaredReply(awardAt('completed'));
      await f.controller.open();
      await flush();
      assert.deepEqual([f.last().mode, f.last().drawBlocked], ['declared', false], 'an explicit later check recovers');
    }
  }
});

test('an older begin or cancel answer does not overwrite a newer pushed award either', async () => {
  const f = lineFixture();
  f.controller.setEvent('e1');
  await f.controller.start();
  let release!: (value: unknown) => void;
  f.replies.begin = () => new Promise((resolve) => { release = resolve; });
  const opening = f.controller.open();
  f.push(awardAt('started'));
  release({ ok: true, session: lineSession });
  await opening;
  assert.deepEqual([f.last().mode, f.last().session, f.last().award?.presentation.status], ['declared', null, 'started']);
});

test('an unsolicited push while a setup is open keeps the real session, even during a read, unlike a confirm in flight', async () => {
  const f = lineFixture();
  f.controller.setEvent('e1');
  f.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await f.controller.start();
  const read = await deferredRead(f);
  f.push(awardAt('completed'));
  assert.deepEqual([f.last().mode, f.last().session?.sessionId, f.last().drawBlocked, f.last().liveBlocked, f.refreshed()], ['setup', 's1', true, true, 0]);
  read.release({ ok: true, state: 'setup', session: lineSession });
  await read.reading;
  assert.deepEqual([f.last().mode, f.last().session?.sessionId], ['setup', 's1']);
});

test('before any event was ever named, a null context followed by the first event keeps the initial read', async () => {
  const f = lineFixture();
  f.controller.setEvent(null);
  const read = await deferredRead(f);
  f.controller.setEvent('e1');
  read.release({ ok: true, state: 'declared', award: awardAt('pending') });
  await read.reading;
  assert.deepEqual([f.last().mode, f.last().award?.presentation.id], ['declared', 'p1']);
});

// Second review: the initial-context exception must not adopt a foreign event, and an obsolete read carries no authority.
test('an initial read answered after the first event was named never adopts another event, and a fresh read works', async () => {
  const foreign: Array<[string, unknown]> = [
    ['declared', { ok: true, state: 'declared', award: awardAt('failed', 'p1', 'A') }],
    ['setup', { ok: true, state: 'setup', session: { ...lineSession, eventId: 'A' } }],
  ];
  for (const [name, reply] of foreign) {
    const f = lineFixture();
    const read = await deferredRead(f);
    f.controller.setEvent('B');
    read.release(reply);
    await read.reading;
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().drawBlocked, f.last().pending, f.refreshed()],
      ['unknown', null, null, true, false, 0], name);
    f.replies.read = async () => ({ ok: true, state: 'none' });
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().drawBlocked], ['idle', false], `${name}: a fresh read works`);
  }
  const own: Array<[string, unknown, string]> = [
    ['declared', { ok: true, state: 'declared', award: awardAt('failed', 'p1', 'B') }, 'declared'],
    ['setup', { ok: true, state: 'setup', session: { ...lineSession, eventId: 'B' } }, 'setup'],
  ];
  for (const [name, reply, mode] of own) {
    const f = lineFixture();
    const read = await deferredRead(f);
    f.controller.setEvent('B');
    read.release(reply);
    await read.reading;
    assert.equal(f.last().mode, mode, `${name} of the newly named event is the initial recovery`);
  }
});

test('a begin answered for another event than the one named meanwhile, or a confirm for another event, is not adopted', async () => {
  const f = lineFixture();
  await f.controller.start();
  let release!: (value: unknown) => void;
  f.replies.begin = () => new Promise((resolve) => { release = resolve; });
  const opening = f.controller.open();
  f.controller.setEvent('B');
  release({ ok: true, session: { ...lineSession, eventId: 'A' } });
  await opening;
  assert.deepEqual([f.last().mode, f.last().session, f.last().dialogOpen, f.last().pending], ['idle', null, false, false]);
  const g = lineFixture();
  await g.controller.start();
  await g.controller.open();
  g.replies.confirm = async () => ({ ok: true, award: awardAt('pending', 'p1', 'other') });
  await g.controller.confirm('2');
  assert.deepEqual([g.last().mode, g.last().award, g.refreshed()], ['uncertain', null, 0]);
});

test('an obsolete read never replaces a newer pushed id, even a valid declared one that was never retired', async () => {
  for (const [pushed, old] of [['pending', 'completed'], ['started', 'completed'], ['started', 'failed'], ['pending', 'interrupted']] as const) {
    const f = lineFixture();
    f.controller.setEvent('e1');
    const read = await deferredRead(f);
    f.push(awardAt(pushed, 'p2'));
    read.release({ ok: true, state: 'declared', award: awardAt(old, 'p1') });
    await read.reading;
    await flush();
    assert.deepEqual([f.last().award?.presentation.id, f.last().award?.presentation.status, f.last().drawBlocked, f.refreshed()],
      ['p2', pushed, true, 0], `${pushed} then old ${old}`);
    assert.equal(f.last().liveBlocked, true, 'the live lock stays');
    f.push(awardAt('started', 'p2'));
    f.push(awardAt('completed', 'p2'));
    await flush();
    assert.deepEqual([f.last().award?.presentation.status, f.last().drawBlocked], ['completed', false], 'p2 was never retired');
  }
});

test('an obsolete read cannot recover uncertainty and a new explicit check can', async () => {
  const f = lineFixture();
  f.controller.setEvent('e1');
  const read = await deferredRead(f);
  f.push(null);
  read.release({ ok: true, state: 'declared', award: awardAt('completed') });
  await read.reading;
  await flush();
  assert.deepEqual([f.last().mode, f.last().drawBlocked, f.refreshed()], ['uncertain', true, 0]);
  f.replies.read = declaredReply(awardAt('completed'));
  await f.controller.open();
  await flush();
  assert.deepEqual([f.last().mode, f.last().drawBlocked], ['declared', false]);
});

// Third review: a foreign event is never stored as authority, whenever the event was named.
test('under a known event a read naming another event fails closed and a proper read recovers', async () => {
  const foreign: Array<[string, unknown]> = [
    ['declared', { ok: true, state: 'declared', award: awardAt('completed', 'p1', 'zzz') }],
    ['setup', { ok: true, state: 'setup', session: { ...lineSession, eventId: 'zzz' } }],
  ];
  for (const [name, reply] of foreign) {
    const f = lineFixture();
    f.controller.setEvent('e1');
    f.replies.read = async () => reply;
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().drawBlocked, f.last().error, f.refreshed(), f.last().pending],
      ['uncertain', null, null, true, 'Invalid first-line update. Check the state and try again.', 0, false], name);
    f.replies.read = declaredReply(awardAt('completed'));
    await f.controller.open();
    await flush();
    assert.deepEqual([f.last().mode, f.last().drawBlocked], ['declared', false], `${name}: the check recovers`);
  }
});

test('a begin or a confirm naming another event than the named one fails closed', async () => {
  const f = lineFixture();
  f.controller.setEvent('e1');
  await f.controller.start();
  f.replies.begin = async () => ({ ok: true, session: { ...lineSession, eventId: 'zzz' } });
  await f.controller.open();
  assert.deepEqual([f.last().mode, f.last().session, f.last().dialogOpen], ['uncertain', null, false]);
  const g = lineFixture();
  g.replies.read = async () => ({ ok: true, state: 'setup', session: lineSession });
  await g.controller.start();
  g.controller.setEvent('other');
  assert.deepEqual([g.last().mode, g.last().session], ['uncertain', null], 'naming the event validates an initial session');
  const h = lineFixture();
  h.replies.read = declaredReply(awardAt('completed', 'p1', 'zzz'));
  await h.controller.start();
  assert.equal(h.last().mode, 'declared', 'with no event named yet the initial read is kept');
  h.controller.setEvent('e1');
  await flush();
  // The event read triggered by the unnamed completion is only a read; nothing unlocks.
  assert.deepEqual([h.last().mode, h.last().award, h.last().drawBlocked, h.last().refresh], ['uncertain', null, true, 'none']);
});

test('an obsolete read with a foreign or failing answer never replaces a newer pushed state', async () => {
  for (const reply of [{ ok: true, state: 'declared', award: awardAt('completed', 'p1', 'zzz') }, { ok: false, message: 'x' }]) {
    const f = lineFixture();
    f.controller.setEvent('e1');
    const read = await deferredRead(f);
    f.push(awardAt('started', 'p2'));
    read.release(reply);
    await read.reading;
    assert.deepEqual([f.last().mode, f.last().award?.presentation.id], ['declared', 'p2']);
  }
});
