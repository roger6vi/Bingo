import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCuePlayer, describeCueStatus } from '../src/cue-player.mjs';
import { bindCueControls } from '../src/cue-ui.mjs';
import { TONGO_DURATION_MS } from '../src/tongo-ipc.ts';

type Status = { kind: string; milestone: string | null; preview?: boolean };

function clock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    timers,
    delays: [] as number[],
    schedule(callback: () => void, delay: number) { this.delays.push(delay); timers.set(next, callback); return next++; },
    cancel(id: number) { timers.delete(id); },
    fire() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
  };
}

function fixture() {
  const time = clock();
  const created: { url: string; paused: boolean }[] = [];
  const states: { status: Status }[] = [];
  const player = createCuePlayer({
    sources: { line: 'l.wav', bingo: 'b.wav', final: 'f.wav' },
    createAudio: (url: string) => {
      const audio = { url, volume: 1, paused: false, play: async () => {}, pause() { audio.paused = true; } };
      created.push(audio);
      return audio;
    },
    storage: { getItem: () => null, setItem: () => {} },
    onChange: (state: { status: Status }) => states.push(state),
    schedule: time.schedule.bind(time), cancel: time.cancel.bind(time),
  });
  return { player, time, created, last: () => states.at(-1)!.status };
}

test('a Tongo hold stops the playing cue and defers new ones until the presentation window ends', async () => {
  const f = fixture();
  await f.player.play('line_declared');
  assert.equal(f.created[0].paused, false);
  f.player.hold(TONGO_DURATION_MS);
  assert.equal(f.created[0].paused, true, 'a cue already sounding never overlaps Tongo');
  assert.deepEqual(f.time.delays, [TONGO_DURATION_MS]);

  await f.player.play('line_declared');
  await f.player.play('bingo_declared');
  assert.equal(f.created.length, 1, 'nothing sounds during the window');
  assert.deepEqual(f.last(), { kind: 'held', milestone: 'bingo_declared', preview: false });
  assert.equal(describeCueStatus(f.last()).message, 'Aviso en espera hasta que termine el Tongo: Bingo cantado');

  f.time.fire();
  await Promise.resolve();
  assert.equal(f.player.holding(), false);
  assert.deepEqual(f.created.map(({ url }) => url), ['l.wav', 'b.wav'], 'only the latest deferred cue plays, once');
  assert.deepEqual(f.last(), { kind: 'played', milestone: 'bingo_declared', preview: false });
  f.time.fire();
  assert.equal(f.created.length, 2);
});

test('an unconfirmed hold is released without a timer, and a release with nothing deferred plays nothing', async () => {
  const f = fixture();
  f.player.hold();
  assert.equal(f.player.holding(), true);
  assert.equal(f.time.timers.size, 0);
  f.player.release();
  assert.equal(f.player.holding(), false);
  assert.equal(f.created.length, 0);
  await f.player.play('finished', { preview: true });
  assert.equal(f.created.length, 1, 'cues play normally after the hold');
});

function element(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => void>();
  return Object.assign({ checked: false, value: '', hidden: true, attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
    dispatch(type: string) { listeners.get(type)?.(); } }, extra);
}

function controls() {
  const time = clock();
  const created: { url: string; paused: boolean }[] = [];
  const ui = { mute: element(), volume: element(), test: element(), status: element() };
  const cues = bindCueControls(ui as never, {
    sources: { line: 'l.wav', bingo: 'b.wav', final: 'f.wav' },
    createAudio: (url: string) => {
      const audio = { url, volume: 1, paused: false, play: async () => {}, pause() { audio.paused = true; } };
      created.push(audio);
      return audio;
    },
    storage: { getItem: () => null, setItem: () => {} },
    schedule: time.schedule.bind(time), cancel: time.cancel.bind(time),
  });
  return { cues, ui, time, created };
}

const snapshot = (phase: string, lastTransitionAt: string) => ({ phase, lastTransitionAt });

test('the operator Tongo request holds cues for the confirmed presentation and releases on refusal', async () => {
  const f = controls();
  f.cues.observe(snapshot('drawing', 't0'));
  f.ui.test.dispatch('click');
  await Promise.resolve();
  assert.equal(f.created.length, 1);

  let seenWhileRequesting = -1;
  const presentation = { kind: 'tongo', id: 1, durationMs: TONGO_DURATION_MS };
  const result = await f.cues.playTongo(async () => {
    seenWhileRequesting = f.created.filter(({ paused }) => !paused).length;
    return { ok: true, presentation };
  });
  assert.deepEqual(result, { ok: true, presentation });
  assert.equal(seenWhileRequesting, 0, 'the test cue is silenced before the public window can start Tongo');
  assert.deepEqual(f.time.delays, [TONGO_DURATION_MS]);

  f.cues.observe(snapshot('line_declared', 't1'));
  await Promise.resolve();
  assert.equal(f.created.length, 1, 'a milestone committed during Tongo waits');
  assert.equal(f.ui.status.hidden, false);
  f.time.fire();
  await Promise.resolve();
  assert.deepEqual(f.created.map(({ url }) => url), ['l.wav', 'l.wav']);

  const refused = { ok: false, code: 'busy', message: 'Tongo is already playing on the public window.' };
  assert.deepEqual(await f.cues.playTongo(async () => refused), refused);
  f.cues.observe(snapshot('bingo_declared', 't2'));
  await Promise.resolve();
  assert.equal(f.created.at(-1)!.url, 'b.wav', 'a refused request never holds cues');

  await assert.rejects(f.cues.playTongo(async () => { throw new Error('ipc'); }), /ipc/);
  f.cues.observe(snapshot('finished', 't3'));
  await Promise.resolve();
  assert.equal(f.created.at(-1)!.url, 'f.wav', 'a failed request never holds cues');
});

test('every operator Tongo request is routed through the cue controls', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/operator-ui.mjs'), 'utf8');
  assert.match(source, /playTongo: \(\) => cues\.playTongo\(\(\) => window\.desktop\.playTongo\(\)\)/);
  assert.doesNotMatch(source.replace(/window\.desktop\.playTongo\(\)\)/, ''), /window\.desktop\.playTongo/);
  for (const factory of ['createOperatorController', 'createThemeController', 'createEventsController', 'createTongoController']) {
    assert.match(source, new RegExp(`${factory}\\(desktop,`), factory);
  }
});
