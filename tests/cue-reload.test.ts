import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCueControls } from '../src/cue-ui.mjs';
import { createOperatorController } from '../src/operator-controller.mjs';
import type { EventResult } from '../src/event-ipc.ts';

// The real operator controller feeding the real cue controls, glued exactly as in operator-ui.mjs.
type Snapshot = { calledNumbers: number[]; phase: string; lastTransitionAt: string | null };
const at = (second: number) => `2026-09-28T20:00:0${second}.000Z`;
const ok = (snapshot: Snapshot) => ({ ok: true, snapshot }) as EventResult;

function element() {
  return { checked: false, value: '', hidden: true, message: '', tone: '', setAttribute() {}, addEventListener() {} };
}

function fixture(initial: Snapshot) {
  // The committed store, which another process (or window) may change behind the operator's back.
  let committed = initial;
  const played: string[] = [];
  const cues = bindCueControls({ mute: element(), volume: element(), test: element(), status: element() } as never, {
    sources: { line: 'l.wav', bingo: 'b.wav', final: 'f.wav' },
    createAudio: (url: string) => ({ url, volume: 1, play: async () => { played.push(url); }, pause() {} }),
    storage: { getItem: () => null, setItem: () => {} },
  });
  let handlers: { reload?: () => void; digital?: () => void } = {};
  const controller = createOperatorController({
    getCurrentEvent: async () => ok(committed),
    drawManual: async () => ok(committed),
    drawDigital: async () => ok(committed),
  }, {
    bind: (callbacks: typeof handlers) => { handlers = callbacks; },
    clearManual: () => {},
    render: (state: { snapshot: Snapshot | null; snapshotSource: string | null }) =>
      cues.observe(state.snapshot, { baseline: state.snapshotSource !== 'draw' }),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    controller, played,
    commit(snapshot: Snapshot) { committed = snapshot; },
    async reload() { handlers.reload!(); await settle(); },
    async draw() { handlers.digital!(); await settle(); },
  };
}

test('an ordinary reload after an externally committed milestone never plays a cue', async () => {
  const f = fixture({ calledNumbers: [5, 17], phase: 'drawing', lastTransitionAt: null });
  await f.controller.start();
  f.commit({ calledNumbers: [5, 17], phase: 'line_declared', lastTransitionAt: at(2) });
  await f.reload();
  assert.deepEqual(f.played, [], 'README: a reload never plays');
  await f.reload();
  assert.deepEqual(f.played, [], 'repeated reloads of the same milestone stay silent');
});

test('a locally acknowledged milestone still cues once, after a reload baseline too', async () => {
  const f = fixture({ calledNumbers: [5], phase: 'drawing', lastTransitionAt: null });
  await f.controller.start();
  f.commit({ calledNumbers: [5, 17], phase: 'line_declared', lastTransitionAt: at(2) });
  await f.draw();
  assert.deepEqual(f.played, ['l.wav']);

  f.commit({ calledNumbers: [5, 17], phase: 'checking_bingo', lastTransitionAt: at(3) });
  await f.reload();
  f.commit({ calledNumbers: [5, 17, 40], phase: 'bingo_declared', lastTransitionAt: at(4) });
  await f.draw();
  assert.deepEqual(f.played, ['l.wav', 'b.wav']);
  await f.reload();
  assert.deepEqual(f.played, ['l.wav', 'b.wav'], 'reloading the acknowledged milestone does not replay it');
});

test('an event switch baselines the new event, so its committed milestone never plays', async () => {
  const f = fixture({ calledNumbers: [5], phase: 'drawing', lastTransitionAt: null });
  await f.controller.start();
  f.commit({ calledNumbers: [8, 9], phase: 'finished', lastTransitionAt: at(5) });
  await f.controller.resync();
  assert.deepEqual(f.played, []);
});
