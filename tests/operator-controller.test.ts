import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorController } from '../src/operator-controller.mjs';
import type { EventResult } from '../src/event-ipc.ts';

const success = (...calledNumbers: number[]): EventResult => ({ ok: true, snapshot: { calledNumbers } });
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
    last: () => renders.at(-1) as { calledNumbers: number[]; remaining: number; stale: boolean; error: string | null;
      pending: boolean; manualDisabled: boolean; digitalDisabled: boolean; reloadDisabled: boolean } };
}

test('initial get renders persisted order, remaining count, and a non-stale state', async () => {
  const f = fixture();
  await f.controller.start();
  assert.deepEqual(f.calls, ['get']);
  assert.deepEqual(f.last(), { calledNumbers: [90, 1], remaining: 88, stale: false, error: null,
    pending: false, manualDisabled: false, digitalDisabled: false, reloadDisabled: false });
  assert.equal(typeof f.handlers.reload, 'function');
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
  f.responses.get = async () => success(1, 90, 3);
  f.handlers.reload?.();
  await new Promise(setImmediate);
  assert.deepEqual(f.last().calledNumbers, [1, 90, 3]);
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
