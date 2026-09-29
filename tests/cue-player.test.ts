import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CUE_SETTINGS_KEY, createCuePlayer, describeCueStatus, readCueSettings } from '../src/cue-player.mjs';
import { wiredCue } from '../src/cue-registry.mjs';
import { PHASE_LABELS_ES } from '../src/operator-copy.mjs';
import { RATE, generateCueBuffers } from '../scripts/generate-cue-audio.mjs';

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
  assert.match(describeCueStatus(f.last().status).message, /No suena nada al iniciar ni al recargar/);
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
  assert.equal(describeCueStatus(f.last().status).message, 'Aviso reproducido: Bingo cantado');
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
  assert.equal(describeCueStatus(f.last().status).message, 'Aviso de prueba silenciado: Partida terminada');
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
    { message: 'Sonido del aviso no disponible (Línea cantada). La partida continúa.', tone: 'warning' });
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

test('committed cue WAVs satisfy the PCM header contract and exactly match the generator, byte for byte', () => {
  const root = path.resolve(import.meta.dirname, '..');
  // generateCueBuffers() only computes bytes in memory; nothing is written to disk by this test.
  const generated = generateCueBuffers();
  for (const cue of ['line', 'bingo', 'final']) {
    const committed = readFileSync(path.join(root, `assets/cues/${cue}.wav`));

    // RIFF/WAVE container and fmt chunk id, matching the 44-byte canonical PCM header this generator writes.
    assert.equal(committed.toString('ascii', 0, 4), 'RIFF');
    assert.equal(committed.readUInt32LE(4), committed.length - 8, `${cue}: RIFF chunk size`);
    assert.equal(committed.toString('ascii', 8, 12), 'WAVE');
    assert.equal(committed.toString('ascii', 12, 16), 'fmt ', `${cue}: fmt chunk id`);
    assert.equal(committed.readUInt32LE(16), 16, `${cue}: fmt chunk size (PCM)`);

    // PCM format contract: audio format 1 (PCM, no compression), 1 channel (mono), 22050 Hz, 16-bit depth.
    assert.equal(committed.readUInt16LE(20), 1, `${cue}: audio format must be PCM`);
    assert.equal(committed.readUInt16LE(22), 1, `${cue}: channel count must be mono`);
    assert.equal(committed.readUInt32LE(24), RATE, `${cue}: sample rate must be 22050 Hz`);
    assert.equal(committed.readUInt16LE(34), 16, `${cue}: bit depth must be 16-bit`);
    assert.equal(committed.readUInt32LE(28), RATE * 2, `${cue}: byte rate must match rate * blockAlign`);
    assert.equal(committed.readUInt16LE(32), 2, `${cue}: block align must match mono 16-bit frames`);

    // data subchunk id and declared size, consistent with the header's own accounting.
    assert.equal(committed.toString('ascii', 36, 40), 'data', `${cue}: data chunk id`);
    assert.equal(committed.readUInt32LE(40), committed.length - 44, `${cue}: data chunk size`);

    // Deterministic equivalence: the committed asset is exactly what the generator produces today,
    // so regenerating never silently drifts from what is bundled and shipped.
    assert.ok(committed.equals(generated[cue]), `${cue}: committed WAV must byte-for-byte match scripts/generate-cue-audio.mjs`);
  }
});

test('cue status copy is Spanish, like the rest of the operator window', () => {
  for (const [milestone, label] of Object.entries(PHASE_LABELS_ES)) {
    if (wiredCue(milestone) !== null) assert.equal(wiredCue(milestone)?.label, label, milestone);
  }
  const all = ['idle', 'played', 'muted', 'failed', 'held'].flatMap((kind) => [false, true].map((preview) =>
    describeCueStatus({ kind, milestone: 'line_declared', preview }).message));
  assert.deepEqual(all, [
    'Avisos de sonido listos. No suena nada al iniciar ni al recargar.',
    'Avisos de sonido listos. No suena nada al iniciar ni al recargar.',
    'Aviso reproducido: Línea cantada',
    'Aviso de prueba reproducido: Línea cantada',
    'Aviso silenciado: Línea cantada',
    'Aviso de prueba silenciado: Línea cantada',
    'Sonido del aviso no disponible (Línea cantada). La partida continúa.',
    'Sonido del aviso de prueba no disponible (Línea cantada). La partida continúa.',
    'Aviso en espera hasta que termine el Tongo: Línea cantada',
    'Aviso de prueba en espera hasta que termine el Tongo: Línea cantada',
  ]);
  for (const message of all) assert.doesNotMatch(message, /\b(Cue|Test|sound|played|muted|declared|finished|game)\b/i, message);
});
