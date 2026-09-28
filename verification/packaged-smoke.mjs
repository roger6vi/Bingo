// Packaged-app smoke (#40). Run after `npm run package:dir` (Linux, under `xvfb-run -a`) or
// `npm run package:mac` (macOS). It launches the packaged executable, never development-mode Electron,
// always with a fresh temporary --user-data-dir that is deleted afterwards.
// Override the executable with BINGO_PACKAGED_APP=/path/to/executable.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const release = path.resolve(import.meta.dirname, '..', 'release');
const defaults = {
  darwin: path.join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bingo.app', 'Contents', 'MacOS', 'Bingo'),
  linux: path.join(release, 'linux-unpacked', 'bingo'),
};
const executablePath = process.env.BINGO_PACKAGED_APP ?? defaults[process.platform];
assert.ok(executablePath && existsSync(executablePath), `packaged executable not found: ${executablePath}`);
const profile = mkdtempSync(path.join(tmpdir(), 'bingo-packaged-'));
// Chromium refuses to run as root without disabling its own sandbox (e.g. in containers).
const rootArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];

const launch = () => electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, ...rootArgs] });
const step = (name) => console.log(`✓ ${name}`);
const count = (page) => page.waitForFunction(() => document.querySelector('#event-summary')?.count !== undefined)
  .then(() => page.locator('#event-summary').evaluate((summary) => summary.count));
// Against packaged executables Playwright sometimes loses its first main-process evaluation
// ("Resulting promise was garbage collected"); only that harness error is retried.
async function mainInfo(app, attempts = 3) {
  try {
    return await app.evaluate(({ app: electronApp }) => ({ packaged: electronApp.isPackaged,
      name: electronApp.getName(), appPath: electronApp.getAppPath(), userData: electronApp.getPath('userData') }));
  } catch (error) {
    if (attempts <= 1 || !/garbage collected/.test(error.message)) throw error;
    return mainInfo(app, attempts - 1);
  }
}
const activate = async (page, name) => {
  await page.click('#tab-events');
  await page.getByRole('button', { name: `Activar «${name}»` }).click();
  await page.waitForFunction((expected) => document.querySelector('#settings-name')?.value === expected, name);
};

try {
  let app = await launch();
  let operator = await app.firstWindow();
  const info = await mainInfo(app);
  assert.equal(info.packaged, true);
  assert.equal(info.name, 'Bingo');
  assert.equal(path.basename(info.appPath), 'app.asar');
  assert.equal(realpathSync(info.userData), realpathSync(profile));
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '' &&
    document.documentElement.dataset.theme === 'pixel-classic');
  assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'node:sqlite database in the temporary profile');
  step('packaged asar app, first run on an isolated profile');

  await operator.click('#tab-bingo');
  await operator.locator('#draw-digital button').click();
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count').value === '1');
  assert.deepEqual(await publicWindow.evaluate(() => ({ desktop: 'desktop' in window, require: typeof require,
    bridges: ['publicEvent', 'publicTheme', 'publicEventMeta'].map((name) => Object.keys(window[name])) })),
  { desktop: false, require: 'undefined', bridges: [['subscribe'], ['subscribe'], ['subscribe']] });
  step('committed draw reaches the sandboxed receive-only public window');

  await publicWindow.evaluate(() => document.querySelector('video').load());
  await publicWindow.waitForFunction(() => document.querySelector('video').readyState >= 1 &&
    document.querySelector('video').duration > 0);
  step('bundled media loads from the package');

  await operator.click('#tab-settings');
  const frame = await (await operator.locator('#public-simulator').elementHandle()).contentFrame();
  await frame.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
  await operator.selectOption('#theme-select', 'high-contrast');
  await operator.click('#settings-save');
  await publicWindow.waitForFunction(() => document.documentElement.dataset.theme === 'high-contrast');
  assert.equal(await operator.evaluate(() => document.documentElement.dataset.theme), 'high-contrast');
  step('isolated simulator protocol serves from the asar; saved theme reaches both windows');

  await operator.click('#tab-events');
  await operator.fill('#event-name', 'Segundo evento');
  await operator.fill('#event-place', 'Salón');
  await operator.fill('#event-date', '2026-10-01');
  await operator.click('#create-event-submit');
  await activate(operator, 'Segundo evento');
  await operator.click('#tab-bingo');
  assert.equal(await count(operator), 0);
  step('second event created and activated; first event archived');
  await app.close();

  app = await launch();
  operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value === 'Segundo evento');
  await activate(operator, 'Evento actual');
  await operator.click('#tab-bingo');
  assert.equal(await count(operator), 1);
  await operator.waitForFunction(() => document.documentElement.dataset.theme === 'high-contrast');
  step('quit/reopen recovers the active event, archived history, and theme');
  await app.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
}
