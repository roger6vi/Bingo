// Smoke for a *packaged* build (#41). Usage:
//   node verification/packaged-smoke.mjs <app executable> [<profile dir> <seed|upgraded>]
// The profile is always a temporary --user-data-dir, never the real one. With no profile, a fresh one
// is created, both phases run back to back, and it is deleted. The Windows workflow instead passes one
// profile to `seed` before an installer upgrade and to `upgraded` after it, then deletes it.
// Assumes one display (as on CI runners), where the public window opens as a primary-display preview.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const [executablePath, profileArg, phaseArg] = process.argv.slice(2);
assert.ok(executablePath && existsSync(executablePath), 'pass the packaged app executable');
// Chromium refuses to run as root without disabling its own sandbox (e.g. in Linux containers).
const rootArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const database = (profile) => path.join(profile, 'current-event.sqlite');
const step = (name) => console.log(`✓ ${name}`);
const launch = (profile, extra = []) =>
  electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, ...rootArgs, ...extra] });

async function openOperator(app) {
  const operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
  return operator;
}

async function expectSaved(operator) {
  await operator.waitForFunction(() => document.querySelector('#settings-name').value === 'Verbena Windows' &&
    document.documentElement.dataset.theme === 'high-contrast');
  assert.equal(await operator.inputValue('#settings-place input'), 'Plaza Mayor');
  assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), 1);
}

async function seed(profile) {
  let app = await launch(profile);
  let operator = await openOperator(app);
  assert.match(operator.url(), /^file:.*app\.asar[\\/]dist[\\/]renderer[\\/]operator\.html$/);
  assert.ok(existsSync(database(profile)), 'the database lives in the temporary profile');
  step('packaged renderer loads from app.asar with an isolated profile');

  await operator.click('#tab-bingo');
  await operator.locator('#draw-controls label', { hasText: 'Digital' }).click();
  await operator.locator('#draw-digital button').click();
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
  assert.deepEqual(await publicWindow.evaluate(() => ({
    desktop: 'desktop' in window, require: typeof require,
    bridges: ['publicEvent', 'publicTheme', 'publicEventMeta'].map((name) => Object.keys(window[name])),
  })), { desktop: false, require: 'undefined', bridges: [['subscribe'], ['subscribe'], ['subscribe']] });
  step('committed draw reaches the sandboxed, receive-only public window');

  const fullscreen = await publicWindow.evaluate(() => outerWidth >= screen.width && outerHeight >= screen.height);
  assert.equal(fullscreen, false, 'with one display the public window is a windowed preview');
  step('primary-only display falls back to a preview window');

  const media = await publicWindow.locator('video').evaluate((video) => new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve({ duration: video.duration, width: video.videoWidth }));
    video.addEventListener('error', () => reject(new Error(`media error ${video.error?.code}`)));
    video.load();
  }));
  assert.ok(media.duration > 0 && media.width > 0, `bundled MP4 decodes: ${JSON.stringify(media)}`);
  step('bundled offline video decodes from the package');

  await operator.click('#tab-settings');
  const simulator = await (await operator.locator('#public-simulator').elementHandle()).contentFrame();
  await simulator.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
  await operator.fill('#settings-name input', 'Verbena Windows');
  await operator.fill('#settings-place input', 'Plaza Mayor');
  await operator.selectOption('#theme-select select', 'high-contrast');
  await simulator.waitForFunction(() => document.documentElement.dataset.theme === 'high-contrast');
  await operator.click('#settings-save button');
  await publicWindow.waitForFunction(() => document.documentElement.dataset.theme === 'high-contrast' &&
    document.querySelector('#event-name').textContent === 'Verbena Windows');
  step('simulator protocol serves from the package; saved settings reach the public window');
  await app.close();

  app = await launch(profile);
  await expectSaved(await openOperator(app));
  await app.close();
  step('event, history and theme survive restart');
}

async function upgraded(profile) {
  const app = await launch(profile);
  const operator = await openOperator(app);
  await expectSaved(operator);
  const transition = () => operator.locator('#open-public').evaluate((host) =>
    getComputedStyle(host.shadowRoot.querySelector('button')).transitionDuration);
  assert.notEqual(await transition(), '0s');
  await operator.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await transition(), '0s');
  await app.close();
  step('state survives reinstall/upgrade; reduced motion disables packaged button transitions');

  // An unreadable database must stay untouched: startup shows an error instead of resetting it.
  const broken = mkdtempSync(path.join(tmpdir(), 'bingo-broken-'));
  try {
    const garbage = Buffer.from('not a sqlite database');
    writeFileSync(database(broken), garbage);
    const child = spawn(executablePath, [`--user-data-dir=${broken}`, ...rootArgs], { stdio: 'ignore' });
    await delay(5000);
    if (process.platform === 'win32') {
      // Windows keeps the modal startup error box open, so the process must still be alive.
      assert.equal(child.exitCode, null, 'the startup error stays on screen');
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    } else child.kill('SIGKILL');
    await delay(1000);
    assert.deepEqual(readFileSync(database(broken)), garbage);
    step('unreadable database is preserved, not reset');
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
}

if (profileArg) {
  await ({ seed, upgraded })[phaseArg](profileArg);
} else {
  const profile = mkdtempSync(path.join(tmpdir(), 'bingo-packaged-'));
  try {
    await seed(profile);
    await upgraded(profile);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
