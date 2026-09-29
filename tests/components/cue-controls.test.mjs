import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-status.mjs';
import { bindCueControls } from '../../src/cue-ui.mjs';
import { CUE_SOURCES } from '../../src/cue-sources.mjs';
import { CUE_SETTINGS_KEY } from '../../src/cue-player.mjs';

const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const snap = (phase, lastTransitionAt) => ({ calledNumbers: [4], phase, lastTransitionAt });

// Mirrors the rail markup in src/operator.html.
async function mount(createAudio, storage = new Map()) {
  const root = await fixture(html`<div>
    <input type="checkbox" id="cue-mute" aria-label="Silenciar avisos">
    <input id="cue-volume" type="range" min="0" max="100" step="5" aria-label="Volumen de avisos">
    <input type="button" id="cue-test" value="Probar aviso"><bingo-status id="cue-status" hidden></bingo-status></div>`);
  const [mute, volume, test, status] = ['#cue-mute', '#cue-volume', '#cue-test', '#cue-status'].map((id) => root.querySelector(id));
  const cues = bindCueControls({ mute, volume, test, status }, { createAudio,
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  return { cues, mute, volume, test, status, storage };
}

it('bundled cue files decode as local audio in the browser', async () => {
  for (const url of Object.values(CUE_SOURCES)) {
    const audio = new Audio();
    const ready = new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = reject; });
    audio.src = url;
    await ready;
    expect(new URL(url).origin).to.equal(location.origin);
    expect(audio.duration).to.be.within(0.3, 1.5);
  }
});

it('controls start silent, persist mute/volume, and cue only committed transitions', async () => {
  const played = [];
  const f = await mount((url) => ({ volume: 1, pause() {}, play: async () => { played.push(url); } }));
  expect([f.mute.checked, f.volume.value, f.status.hidden]).to.deep.equal([false, '60', true]);
  f.cues.observe(snap('line_declared', '2026-01-01T00:00:01.000Z'));
  await settle();
  expect(played).to.deep.equal([], 'an already committed milestone is a baseline');
  expect(f.status.hidden).to.equal(true);
  f.volume.value = '35';
  f.volume.dispatchEvent(new Event('input'));
  f.mute.click();
  expect(JSON.parse(f.storage.get(CUE_SETTINGS_KEY))).to.deep.equal({ muted: true, volume: 0.35 });
  expect(f.volume.getAttribute('aria-valuetext')).to.equal('35%');
  f.cues.observe(snap('bingo_declared', '2026-01-01T00:00:02.000Z'));
  await settle();
  expect(played).to.deep.equal([]);
  expect([f.status.message, f.status.hidden]).to.deep.equal(['Aviso silenciado: Bingo cantado', false]);
  f.mute.click();
  f.test.click();
  await settle();
  expect(played).to.deep.equal([CUE_SOURCES.line]);
  expect(f.status.message).to.equal('Aviso de prueba reproducido: Línea cantada');
});

it('a missing cue file warns without throwing and leaves the controls usable', async () => {
  const f = await mount(() => new Audio(new URL('../../assets/cues/missing.wav', import.meta.url).href));
  f.cues.observe(snap('drawing', null));
  f.cues.observe(snap('finished', '2026-01-01T00:00:03.000Z'));
  for (let wait = 0; wait < 60 && f.status.tone !== 'warning'; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.status.message).to.equal('Sonido del aviso no disponible (Partida terminada). La partida continúa.');
  expect([f.status.tone, f.status.hidden]).to.deep.equal(['warning', false]);
  expect(f.mute.disabled || f.volume.disabled || f.test.disabled).to.equal(false);
});
