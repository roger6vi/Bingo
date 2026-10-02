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
  session: typeof lineSession | null; award: typeof lineAward | null };
function lineFixture() {
  const calls: string[] = [];
  const renders: LineState[] = [];
  let refreshed = 0;
  const replies: Record<string, () => Promise<unknown>> = {
    read: async () => ({ ok: true, state: 'none' }),
    begin: async () => ({ ok: true, session: lineSession }),
    cancel: async () => ({ ok: true }),
    confirm: async () => ({ ok: true, award: lineAward }),
  };
  const controller = createLineController({
    readLineSetup: () => { calls.push('read'); return replies.read(); },
    beginLineSetup: () => { calls.push('begin'); return replies.begin(); },
    cancelLineSetup: (id: string, event: string) => { calls.push(`cancel:${id}:${event}`); return replies.cancel(); },
    confirmLine: (id: string, event: string, count: number) => { calls.push(`confirm:${id}:${event}:${count}`); return replies.confirm(); },
  }, { render: (state: LineState) => { renders.push(structuredClone(state)); } }, { committed: () => { refreshed++; } });
  return { controller, calls, replies, refreshed: () => refreshed, last: () => renders.at(-1) as LineState };
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
