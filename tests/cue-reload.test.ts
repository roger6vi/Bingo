import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCueControls } from '../src/cue-ui.mjs';
import { createOperatorController } from '../src/operator-controller.mjs';
import type { EventResult } from '../src/event-ipc.ts';

const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
const ack = (phase: string, lastTransitionAt: string | null, ...calledNumbers: number[]): EventResult =>
  ({ ok: true, snapshot: { calledNumbers, phase, lastTransitionAt } }) as EventResult;
const control = (props: object) => ({ ...props, addEventListener() {}, setAttribute() {} });

// The real operator controller feeding the real cue controls, rendered as src/operator-ui.mjs does.
function fixture() {
  const played: string[] = [];
  const status = control({ hidden: true }) as { hidden: boolean; message?: string };
  const cues = bindCueControls({ mute: control({ checked: false }), volume: control({ value: '60' }), test: control({}), status }, {
    sources: { line: 'line.wav', bingo: 'bingo.wav', final: 'final.wav' },
    createAudio: (url: string) => ({ volume: 1, pause() {}, play: async () => { played.push(url); } }),
    storage: { getItem: () => null, setItem: () => {} },
  });
  const responses = { get: async () => ack('drawing', null, 4), manual: async () => ack('drawing', null, 4, 9),
    digital: async () => ack('drawing', null, 4, 9) };
  const handlers: { manual?: (number: number) => void; digital?: () => void; reload?: () => void } = {};
  const controller = createOperatorController({
    getCurrentEvent: () => responses.get(), drawManual: () => responses.manual(), drawDigital: () => responses.digital(),
  }, {
    bind: (callbacks) => { Object.assign(handlers, callbacks); },
    clearManual: () => {},
    render: (state, acknowledgement) => cues.observe(state.snapshot, acknowledgement),
  });
  const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { controller, responses, handlers, played, status, settle };
}

test('an ordinary reload after a milestone committed elsewhere never plays it', async () => {
  const f = fixture();
  await f.controller.start();
  // Another process commits line_declared; this window only learns about it by re-reading.
  f.responses.get = async () => ack('line_declared', at(2), 4, 9);
  f.handlers.reload?.();
  await f.settle();
  assert.deepEqual(f.played, [], 'a re-read snapshot is a baseline, not a new transition');
  assert.equal(f.status.hidden, true);
  // Repeated renders of that snapshot (the next request's pending render) still do not play it.
  f.responses.get = async () => ack('line_declared', at(2), 4, 9);
  f.handlers.reload?.();
  await f.settle();
  assert.deepEqual(f.played, []);
});

test('transitions acknowledged for this window’s own requests still cue after a reload', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.get = async () => ack('line_declared', at(2), 4, 9);
  f.handlers.reload?.();
  await f.settle();
  f.responses.digital = async () => ack('bingo_declared', at(3), 4, 9, 17);
  f.handlers.digital?.();
  await f.settle();
  assert.deepEqual(f.played, ['bingo.wav']);
  f.responses.manual = async () => ack('finished', at(4), 4, 9, 17, 30);
  f.handlers.manual?.(30);
  await f.settle();
  assert.deepEqual(f.played, ['bingo.wav', 'final.wav']);
});

test('an event switch re-reads its history as a baseline', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.get = async () => ack('bingo_declared', at(5), 60, 61);
  await f.controller.resync();
  assert.deepEqual(f.played, []);
});
