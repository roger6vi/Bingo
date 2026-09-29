// Isolated Electron smoke for operator sound cues (#39). Run after `npm run build`, under a display
// (e.g. `xvfb-run -a node verification/cue-smoke.mjs`). It always uses a fresh temporary
// --user-data-dir, never the real profile, and deletes it afterwards.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createEventStore } from '../src/event-store.ts';
import { launchArgs, profilePrefix } from './electron-smoke.mjs';

const executablePath = createRequire(import.meta.url)('electron');
// launchArgs refuses any profile that is not a fresh smoke directory in the OS temp dir.
const profile = realpathSync(mkdtempSync(path.join(tmpdir(), profilePrefix)));
const launch = () => electron.launch({ executablePath, args: launchArgs(profile), timeout: 30_000 });
const step = (name) => console.log(`✓ ${name}`);
const cueStatus = (page) => page.locator('#cue-status').evaluate((element) => element.message);
const t = (s) => `2026-09-28T20:00:0${s}.000Z`;
try {
  // Seed an already committed line_declared milestone before the app ever starts.
  const store = createEventStore(path.join(profile, 'current-event.sqlite'));
  store.create();
  store.update((event) => ({ ...event, calledNumbers: [5, 17] }));
  store.transitionPhase('begin_line_check', t(1));
  store.transitionPhase('declare_line', t(2));
  store.close();
  let app = await launch();
  let operator = await app.firstWindow();
  // Count every media play() in the operator renderer.
  await operator.evaluate(() => { window.__plays = 0; const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) { window.__plays++; window.__src = this.src; return original.apply(this, args); }; });
  await operator.click('#tab-bingo');
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 2);
  assert.equal(await operator.locator('#phase-status').evaluate((e) => e.message), 'Fase: Línea cantada');
  assert.equal(await operator.locator('#cue-status').evaluate((element) => element.hidden), true, 'idle status: nothing has played');
  assert.equal(await operator.evaluate(() => window.__plays), 0);
  step('committed line milestone does not replay at startup');

  await operator.locator('#cue-test').click();
  await operator.waitForFunction(() => /^Test cue (played|sound unavailable)/.test(document.querySelector('#cue-status').message));
  assert.equal(await cueStatus(operator), 'Test cue played: Line declared');
  assert.match(await operator.evaluate(() => window.__src),
    /^file:\/\/.*\/dist\/renderer\/assets\/line-[\w-]+\.wav$/);
  step('built file:// operator page plays the bundled line cue under the offline CSP');

  await operator.fill('#cue-volume', '30');
  await operator.locator('#cue-mute').check();
  await operator.reload();
  await operator.click('#tab-bingo');
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 2);
  assert.equal(await operator.locator('#cue-mute').isChecked(), true);
  assert.equal(await operator.inputValue('#cue-volume'), '30');
  assert.equal(await operator.locator('#cue-status').evaluate((element) => element.hidden), true, 'idle status: nothing has played');
  step('mute/volume persist across renderer reload with no replay');

  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count').value === '2');
  assert.equal(await publicWindow.locator('#phase-status').evaluate((e) => e.message), 'Current phase: Line declared');
  assert.deepEqual(await publicWindow.evaluate(() => ({ audio: document.querySelectorAll('audio').length,
    
    numbers: document.querySelector('#called-numbers').calledNumbers })), { audio: 0, numbers: [5, 17] });
  step('public window shows every called number and loads no cue audio');
  await app.close();

  app = await launch();
  operator = await app.firstWindow();
  await operator.click('#tab-bingo');
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 2);
  assert.equal(await operator.locator('#cue-mute').isChecked(), true);
  assert.equal(await operator.locator('#cue-status').evaluate((element) => element.hidden), true, 'idle status: nothing has played');
  step('relaunch keeps cue settings and does not replay the milestone');
  await app.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
}
