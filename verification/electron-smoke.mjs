// Isolated Electron smoke for the Configuración workspace (#59) and the Tongo presentation (#60). Run after `npm run build`, under a
// display (e.g. `xvfb-run -a node verification/electron-smoke.mjs`). It always uses a fresh temporary
// --user-data-dir, never the real profile, and deletes it afterwards.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const executablePath = createRequire(import.meta.url)('electron');
const profile = mkdtempSync(path.join(tmpdir(), 'bingo-smoke-'));
// Chromium refuses to run as root without disabling its own sandbox (e.g. in containers).
const rootArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];

const launch = () => electron.launch({ executablePath, args: [root, `--user-data-dir=${profile}`, ...rootArgs] });
const banner = (page) => page.locator('#panel-settings .active-event-banner').evaluate((element) => element.message);
const step = (name) => console.log(`✓ ${name}`);
const tongo = (page) => page.locator('#tongo-control').evaluate((control) => ({ progress: control.progress, error: control.error }));
const boards = (...pages) => Promise.all(pages.map((page) => page.evaluate(() =>
  [[...document.querySelector('#called-numbers').calledNumbers], document.querySelector('#phase-status').message])));

async function simulatorFrame(page) {
  const handle = await page.locator('#public-simulator').elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
  return frame;
}

try {
  let app = await launch();
  assert.equal(realpathSync(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))), realpathSync(profile));
  let operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
  assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'the database lives in the temporary profile');
  step('isolated profile');

  // Commit one draw, then open the public window.
  await operator.click('#tab-bingo');
  await operator.locator('#draw-digital button').click();
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
  // Without a public window, Tongo fails with no acknowledgement and no playback.
  await operator.locator('#tongo-control button').click();
  await operator.waitForFunction(() => document.querySelector('#tongo-control').error !== null);
  assert.deepEqual(await tongo(operator), { progress: null, error: 'Open the public window, then try Tongo again.' });
  step('Tongo without a public window is refused');
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelectorAll('#called-numbers').length === 1 &&
    document.querySelector('#called-count').value === '1' && document.querySelector('#event-name').textContent === 'Evento actual');

  // Tab navigation and draft preview: only the simulator shows the draft.
  await operator.locator('#tab-bingo').focus();
  await operator.keyboard.press('ArrowLeft');
  assert.equal(await operator.locator('#tab-settings').getAttribute('aria-selected'), 'true');
  step('keyboard tab navigation');
  const simulator = await simulatorFrame(operator);
  await operator.fill('#settings-name', 'Verbena de prueba');
  await operator.fill('#settings-place', 'Plaza Mayor');
  await operator.selectOption('#theme-select', 'high-contrast');
  await simulator.waitForFunction(() => document.querySelector('#event-name').textContent === 'Verbena de prueba' &&
    document.querySelector('#event-details').textContent.endsWith('· Plaza Mayor') &&
    document.documentElement.dataset.theme === 'high-contrast' && document.querySelector('#called-count').value === '1');
  assert.equal(await publicWindow.locator('#event-name').textContent(), 'Evento actual');
  assert.equal(await publicWindow.evaluate(() => document.documentElement.dataset.theme), 'pixel-classic');
  assert.equal(await operator.evaluate(() => document.documentElement.dataset.theme), 'pixel-classic');
  assert.match(await banner(operator), /^Evento activo: Evento actual/);
  step('draft preview reaches only the simulator');

  // The simulator is the production public page with no privileged bridge at all.
  assert.deepEqual(await simulator.evaluate(() => ({
    own: ['desktop', 'publicEvent', 'publicTheme', 'publicEventMeta'].filter((name) => name in window),
    parentDesktop: (() => { try { return 'desktop' in window.parent; } catch { return 'blocked'; } })(),
  })), { own: [], parentDesktop: 'blocked' });
  // The public window can only subscribe.
  assert.deepEqual(await publicWindow.evaluate(() => ({
    desktop: 'desktop' in window, require: typeof require,
    bridges: ['publicEvent', 'publicTheme', 'publicEventMeta'].map((name) => Object.keys(window[name])),
  })), { desktop: false, require: 'undefined', bridges: [['subscribe'], ['subscribe'], ['subscribe']] });
  step('receive-only public boundary and bridge-free simulator');

  // Unsaved-changes guard: Cancel stays, Save commits and then leaves.
  await operator.click('#tab-bingo');
  const dialog = operator.locator('#unsaved-dialog dialog');
  await dialog.waitFor({ state: 'visible' });
  await operator.locator('#unsaved-dialog [data-action="cancel"] button').click();
  assert.equal(await operator.locator('#tab-settings').getAttribute('aria-selected'), 'true');
  await operator.click('#tab-bingo');
  await dialog.waitFor({ state: 'visible' });
  await operator.locator('#unsaved-dialog [data-action="save"] button').click();
  await operator.waitForFunction(() => document.querySelector('#tab-bingo').getAttribute('aria-selected') === 'true');
  step('Save / Discard / Cancel guard');

  // Both windows and banners reflect the committed values; history is untouched.
  await publicWindow.waitForFunction(() => document.querySelector('#event-name').textContent === 'Verbena de prueba' &&
    document.documentElement.dataset.theme === 'high-contrast');
  assert.equal(await publicWindow.locator('#called-count').evaluate((output) => output.value), '1');
  assert.equal(await operator.evaluate(() => document.documentElement.dataset.theme), 'high-contrast');
  assert.match(await banner(operator), /^Evento activo: Verbena de prueba — \d{4}-\d{2}-\d{2}, Plaza Mayor$/);
  step('save reaches both windows and banners');

  // Tongo plays once on the public window, blocks other live actions, and returns to the same board.
  await publicWindow.emulateMedia({ reducedMotion: 'reduce' });
  const committed = await boards(operator, publicWindow);
  await operator.locator('#tongo-control button').click();
  await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === true);
  assert.equal(await publicWindow.locator('#tongo').evaluate((overlay) =>
    getComputedStyle(overlay.shadowRoot.querySelector('.card')).animationName), 'none');
  await operator.waitForFunction(() => document.querySelector('#tongo-control').progress !== null &&
    document.querySelector('#draw-controls').digitalDisabled && document.querySelector('#event-list').disabled);
  // Main refuses a second Tongo and any draw even if the renderer bypassed its locks.
  assert.deepEqual(await operator.evaluate(() => Promise.all([window.desktop.playTongo(), window.desktop.drawDigital()])
    .then((results) => results.map((result) => result.code))), ['busy', 'presentation_active']);
  assert.deepEqual(await boards(operator, publicWindow), committed);
  await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === false);
  await operator.waitForFunction(() => document.querySelector('#tongo-control').progress === null &&
    !document.querySelector('#draw-controls').digitalDisabled);
  assert.deepEqual(await boards(operator, publicWindow), committed);
  step('Tongo plays once, blocks live actions, and restores the committed board');

  // Reloading either window mid-presentation never replays it.
  await operator.locator('#tongo-control button').click();
  await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === true);
  await Promise.all([publicWindow.reload(), operator.reload()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
  await operator.waitForFunction(() => document.querySelector('#event-summary')?.count === 1);
  assert.equal(await publicWindow.evaluate(() => document.querySelector('#tongo').active), false);
  assert.equal((await tongo(operator)).progress, null);
  await operator.waitForTimeout(3200);
  assert.equal(await publicWindow.evaluate(() => document.querySelector('#tongo').active), false);
  assert.deepEqual(await boards(operator, publicWindow), committed);
  step('reloads during Tongo do not replay it');
  await app.close();

  // Restart on the same isolated profile.
  app = await launch();
  operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value === 'Verbena de prueba' &&
    document.documentElement.dataset.theme === 'high-contrast');
  assert.equal(await operator.inputValue('#settings-place'), 'Plaza Mayor');
  assert.equal(await operator.inputValue('#theme-select'), 'high-contrast');
  assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), 1);
  step('saved configuration and history survive restart');
  await app.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
}
