import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CUE_SETTINGS_KEY, createCuePlayer, describeCueStatus, readCueSettings } from '../src/cue-player.mjs';

type State = { muted: boolean; volume: number; status: { kind: string; milestone: string | null; preview?: boolean } };

function memoryStorage(initial: string | null = null) {
  const values = new Map<string, string>(initial === null ? [] : [[CUE_SETTINGS_KEY, initial]]);
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}

function fakeAudio(play: () => Promise<void> = async () => {}) {
  const created: { url: string; volume: number; paused: boolean }[] = [];
  return { created, createAudio: (url: string) => {
    const audio = { url, volume: 1, paused: false, play, pause() { audio.paused = true; } };
    created.push(audio);
    return audio;
  } };
}

function fixture({ storage = memoryStorage(), audio = fakeAudio(), sources = { line: 'l.wav', bingo: 'b.wav', final: 'f.wav' } } = {}) {
  const states: State[] = [];
  const player = createCuePlayer({ sources, createAudio: audio.createAudio, storage, onChange: (state: State) => states.push(state) });
  return { player, states, storage, audio, last: () => states.at(-1)! };
}

test('defaults are unmuted at a moderate level and reported without playing anything', () => {
  const f = fixture();
  assert.deepEqual(f.last(), { muted: false, volume: 0.6, status: { kind: 'idle', milestone: null } });
  assert.equal(f.audio.created.length, 0);
  assert.match(describeCueStatus(f.last().status).message, /Nothing plays at startup/);
});

test('mute and volume persist, and invalid or unreadable stored values fall back to defaults', () => {
  const f = fixture();
  f.player.setMuted(true);
  f.player.setVolume(0.25);
  for (const invalid of [Number.NaN, -0.1, 1.5, '0.5']) f.player.setVolume(invalid as number);
  f.player.setMuted('yes' as unknown as boolean);
  assert.deepEqual(JSON.parse(f.storage.values.get(CUE_SETTINGS_KEY)!), { muted: true, volume: 0.25 });
  assert.deepEqual(readCueSettings(f.storage), { muted: true, volume: 0.25 });
  for (const stored of ['{', '{"muted":"no","volume":0.5}', '{"muted":false,"volume":2}', 'null', '[]']) {
    assert.deepEqual(readCueSettings(memoryStorage(stored)), { muted: false, volume: 0.6 }, stored);
  }
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const g = fixture({ storage: throwing as unknown as ReturnType<typeof memoryStorage> });
  g.player.setMuted(true);
  assert.equal(g.last().muted, true, 'a failed save still applies for the session');
});

test('a wired cue plays its local file at the operator volume', async () => {
  const f = fixture();
  f.player.setVolume(0.4);
  await f.player.play('bingo_declared');
  assert.deepEqual(f.audio.created.map(({ url, volume }) => ({ url, volume })), [{ url: 'b.wav', volume: 0.4 }]);
  assert.deepEqual(f.last().status, { kind: 'played', milestone: 'bingo_declared', preview: false });
  assert.equal(describeCueStatus(f.last().status).message, 'Cue played: Bingo declared');
  f.player.setVolume(0.8);
  assert.equal(f.audio.created[0].volume, 0.8, 'volume changes reach the playing cue');
});

test('muted or zero-volume cues create no audio and say so', async () => {
  const f = fixture();
  f.player.setMuted(true);
  await f.player.play('line_declared');
  f.player.setMuted(false);
  f.player.setVolume(0);
  await f.player.play('finished', { preview: true });
  assert.equal(f.audio.created.length, 0);
  assert.equal(describeCueStatus(f.last().status).message, 'Test cue muted: Game finished');
});

test('unwired milestones such as Tongo are ignored', async () => {
  const f = fixture();
  const before = f.states.length;
  await f.player.play('tongo_declared');
  await f.player.play('drawing');
  assert.equal(f.audio.created.length, 0);
  assert.equal(f.states.length, before);
});

test('missing or failing media is reported as a warning and the next cue still plays', async () => {
  let fail = true;
  const f = fixture({ sources: { line: 'l.wav' } as Record<string, string>,
    audio: fakeAudio(async () => { if (fail) throw new DOMException('no source', 'NotSupportedError'); }) });
  await f.player.play('bingo_declared');
  assert.deepEqual(f.last().status, { kind: 'failed', milestone: 'bingo_declared', preview: false });
  assert.equal(f.audio.created.length, 0, 'no source means no element');
  await f.player.play('line_declared');
  assert.equal(f.last().status.kind, 'failed');
  assert.deepEqual(describeCueStatus(f.last().status),
    { message: 'Cue sound unavailable (Line declared). The game continues.', tone: 'warning' });
  fail = false;
  await f.player.play('line_declared');
  assert.equal(f.last().status.kind, 'played');
  const g = fixture({ audio: { created: [], createAudio: () => { throw new Error('no audio'); } } as unknown as ReturnType<typeof fakeAudio> });
  await g.player.play('finished');
  assert.equal(g.last().status.kind, 'failed');
});

test('a newer cue or mute stops the playing one and retires its pending report', async () => {
  const pending: (() => void)[] = [];
  const f = fixture({ audio: fakeAudio(() => new Promise<void>((resolve) => { pending.push(resolve); })) });
  const first = f.player.play('line_declared');
  const second = f.player.play('bingo_declared');
  assert.equal(f.audio.created[0].paused, true);
  pending[1]();
  await second;
  pending[0]();
  await first;
  assert.equal(f.last().status.milestone, 'bingo_declared');
  const third = f.player.play('finished');
  f.player.setMuted(true);
  assert.equal(f.audio.created[2].paused, true);
  pending[2]();
  await third;
  assert.equal(f.last().status.milestone, 'bingo_declared', 'muting retires the pending report');
});

test('bundled cue sources are local generated WAV files large enough to be emitted, not inlined', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const sources = readFileSync(path.join(root, 'src/cue-sources.mjs'), 'utf8');
  for (const cue of ['line', 'bingo', 'final']) {
    assert.match(sources, new RegExp(`new URL\\('\\.\\./assets/cues/${cue}\\.wav', import\\.meta\\.url\\)`));
    const wav = readFileSync(path.join(root, `assets/cues/${cue}.wav`));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 4096, 'above Vite\'s inline limit, so the CSP never sees a data: URL');
  }
});
