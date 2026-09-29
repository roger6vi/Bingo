// Packaged-app smoke for operator sound cues (#39). Usage:
//   node verification/packaged-cue-smoke.mjs [<app executable>]
// The executable defaults to `BINGO_PACKAGED_APP` or the `release/` output for the current platform, as
// in packaged-smoke.mjs; the Windows workflow passes its installed executable explicitly. It always uses
// a fresh temporary --user-data-dir, never the real profile, and deletes it afterwards.
// It checks that the three cue WAVs ship inside app.asar byte-for-byte, play and decode from it under the
// offline CSP, and that an already committed milestone never replays across restarts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createEventStore } from '../src/event-store.ts';

// electron-builder's own ASAR reader (a dev dependency through electron-builder).
const asar = createRequire(import.meta.url)('@electron/asar');
const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');
const defaultExecutables = {
  darwin: path.join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bingo.app', 'Contents', 'MacOS', 'Bingo'),
  linux: path.join(release, 'linux-unpacked', 'bingo'),
};
const executablePath = process.argv[2] ?? process.env.BINGO_PACKAGED_APP ?? defaultExecutables[process.platform];
assert.ok(executablePath && existsSync(executablePath),
  `packaged executable not found: ${executablePath ?? `no default for ${process.platform}`}`);
const archive = process.platform === 'darwin'
  ? path.join(path.dirname(executablePath), '..', 'Resources', 'app.asar')
  : path.join(path.dirname(executablePath), 'resources', 'app.asar');
// Chromium refuses to run as root without disabling its own sandbox (e.g. in Linux containers).
const rootArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const step = (name) => console.log(`✓ ${name}`);
const t = (s) => `2026-09-28T20:00:0${s}.000Z`;

const profile = mkdtempSync(path.join(tmpdir(), 'bingo-packaged-cue-'));
const launch = () => electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, ...rootArgs] });

// Opens the Bingo tab once the seeded history is shown, counting every media play() from then on.
async function openBingo(app) {
  const operator = await app.firstWindow();
  await operator.evaluate(() => {
    window.__plays = 0;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) { window.__plays++; window.__src = this.src; return original.apply(this, args); };
  });
  await operator.click('#tab-bingo');
  await operator.waitForFunction(() => document.querySelector('#event-summary')?.count === 2);
  assert.equal(await operator.locator('#phase-status').evaluate((e) => e.message), 'Fase: Línea cantada');
  return operator;
}

async function expectNoReplay(operator) {
  // Give a late snapshot time to (wrongly) trigger a cue before asserting.
  await operator.waitForTimeout(1000);
  assert.equal(await operator.locator('#cue-status').evaluate((element) => element.hidden), true, 'idle status: nothing has played');
  assert.equal(await operator.evaluate(() => window.__plays), 0);
}

let app;
try {
  const packed = asar.listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  for (const cue of ['line', 'bingo', 'final']) {
    const entries = packed.filter((entry) => new RegExp(`^/dist/renderer/assets/${cue}-[\\w-]+\\.wav$`).test(entry));
    assert.equal(entries.length, 1, `one ${cue} cue in app.asar`);
    // extractFile splits on path.sep, so hand it a native path (backslashes on Windows).
    assert.deepEqual(asar.extractFile(archive, path.join(...entries[0].slice(1).split('/'))), readFileSync(path.join(root, 'assets', 'cues', `${cue}.wav`)),
      `${entries[0]} matches assets/cues/${cue}.wav`);
  }
  assert.ok(!existsSync(path.join(`${archive}.unpacked`, 'dist', 'renderer', 'assets')), 'no renderer asset is unpacked beside app.asar');
  step('the three cue WAVs ship inside app.asar byte-for-byte');

  // Seed an already committed line_declared milestone before the packaged app ever starts.
  const store = createEventStore(path.join(profile, 'current-event.sqlite'));
  store.create();
  store.update((event) => ({ ...event, calledNumbers: [5, 17] }));
  store.transitionPhase('begin_line_check', t(1));
  store.transitionPhase('declare_line', t(2));
  store.close();

  app = await launch();
  let operator = await openBingo(app);
  assert.match(operator.url(), /^file:.*app\.asar[\\/]dist[\\/]renderer[\\/]operator\.html$/);
  await expectNoReplay(operator);
  step('packaged operator does not replay the committed line milestone at startup');

  await operator.locator('#cue-test').click();
  await operator.waitForFunction(() => /^(Aviso de prueba reproducido|Sonido del aviso de prueba no disponible)/.test(document.querySelector('#cue-status').message));
  assert.equal(await operator.locator('#cue-status').evaluate((e) => e.message), 'Aviso de prueba reproducido: Línea cantada');
  assert.match(await operator.evaluate(() => window.__src), /^file:\/\/.*\/app\.asar\/dist\/renderer\/assets\/line-[\w-]+\.wav$/);
  const cueNames = packed.filter((entry) => entry.endsWith('.wav')).map((entry) => path.posix.basename(entry));
  const durations = await operator.evaluate((names) => Promise.all(names.map((name) => new Promise((resolve, reject) => {
    const audio = new Audio(new URL(name, window.__src).href);
    audio.addEventListener('loadedmetadata', () => resolve(audio.duration));
    audio.addEventListener('error', () => reject(new Error(`${name}: media error ${audio.error?.code}`)));
    audio.load();
  }))), cueNames);
  assert.equal(durations.length, 3);
  assert.ok(durations.every((duration) => duration > 0), `every packaged cue decodes: ${durations}`);
  step('test cue plays from app.asar and every packaged cue decodes under the offline CSP');

  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '2');
  assert.equal(await publicWindow.evaluate(() => document.querySelectorAll('audio').length), 0);
  assert.equal(await publicWindow.evaluate(() => 'desktop' in window), false);
  step('packaged public window loads no cue audio');

  // Unmuted, so a replay after the restart would really play.
  await operator.fill('#cue-volume', '30');
  await app.close();
  app = await launch();
  operator = await openBingo(app);
  assert.equal(await operator.inputValue('#cue-volume'), '30');
  assert.equal(await operator.locator('#cue-mute').isChecked(), false);
  await expectNoReplay(operator);
  step('restart keeps the cue volume and does not replay the milestone');

  await operator.locator('#cue-mute').check();
  await app.close();
  app = await launch();
  operator = await openBingo(app);
  assert.equal(await operator.locator('#cue-mute').isChecked(), true);
  assert.equal(await operator.inputValue('#cue-volume'), '30');
  await expectNoReplay(operator);
  step('restart keeps mute and still does not replay');
} finally {
  // A failed step must not leave the packaged app running on the profile it is about to delete.
  await app?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
