// Isolated Electron smoke for the Configuración workspace (#59). Run after `npm run build`, under a
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
  await operator.waitForFunction(() => (document.querySelector('#settings-name')?.value ?? '') !== '');
  assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'the database lives in the temporary profile');
  step('isolated profile');

  // Commit one draw, then open the public window.
  await operator.click('#tab-bingo');
  await operator.locator('#draw-digital button').click();
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelectorAll('#called-numbers').length === 1 &&
    document.querySelector('#called-count').value === '1' && document.querySelector('#event-name').textContent === 'Evento actual');

  // Tab navigation and draft preview: only the simulator shows the draft.
  await operator.locator('#tab-bingo').focus();
  await operator.keyboard.press('ArrowLeft');
  assert.equal(await operator.locator('#tab-settings').getAttribute('aria-selected'), 'true');
  step('keyboard tab navigation');
  const simulator = await simulatorFrame(operator);
  // The shared field components wrap native controls in their shadow roots; Playwright pierces them.
  await operator.fill('#settings-name input', 'Verbena de prueba');
  await operator.fill('#settings-place input', 'Plaza Mayor');
  await operator.selectOption('#theme-select select', 'high-contrast');
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
  await app.close();

  // Restart on the same isolated profile.
  app = await launch();
  operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value === 'Verbena de prueba' &&
    document.documentElement.dataset.theme === 'high-contrast');
  assert.equal(await operator.inputValue('#settings-place input'), 'Plaza Mayor');
  assert.equal(await operator.inputValue('#theme-select select'), 'high-contrast');
  assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), 1);
  step('saved configuration and history survive restart');
  await app.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
}
