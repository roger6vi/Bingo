// Smoke for a *packaged* build (#40, #41). Usage:
//   node verification/packaged-smoke.mjs [<app executable>] [<profile dir> <seed|upgraded>]
// The profile is always a temporary --user-data-dir, never the real one. With no profile, a fresh one
// is created, both phases run back to back, and it is deleted. The Windows workflow instead passes one
// profile to `seed` before an installer upgrade and to `upgraded` after it, then deletes it.
// The executable path is optional: `BINGO_PACKAGED_APP` or the default `release/` output for the
// current platform (macOS `mac-arm64`/`mac`, Linux `linux-unpacked`) is used when it is omitted, so
// `npm run test:package` runs unmodified on macOS and Linux while the Windows workflow keeps passing
// its installed executable path explicitly.
// Display-aware: one display (CI runners) expects a windowed preview; with a second display the public
// window must be fullscreen on the first non-primary display, as planPublicWindow selects.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

let [executablePath, profileArg, phaseArg] = process.argv.slice(2);
const release = path.resolve(import.meta.dirname, '..', 'release');
const defaultExecutables = {
  darwin: path.join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bingo.app', 'Contents', 'MacOS', 'Bingo'),
  linux: path.join(release, 'linux-unpacked', 'bingo'),
};
executablePath ??= process.env.BINGO_PACKAGED_APP ?? defaultExecutables[process.platform];
assert.ok(executablePath && existsSync(executablePath),
  `packaged executable not found: ${executablePath ?? `no default for ${process.platform}`}`);
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

// Mirrors planPublicWindow: the first non-primary display hosts a fullscreen public window; with only
// the primary display it is a windowed preview inside that display's work area.
async function assertPublicPlacement(app) {
  const read = () => app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('public'));
    return {
      displays: screen.getAllDisplays().map(({ id, bounds, workArea }) => ({ id, bounds, workArea })),
      primaryId: screen.getPrimaryDisplay().id,
      fullscreen: window.isFullScreen(), bounds: window.getBounds(),
    };
  });
  let state = await read();
  const secondary = state.displays.find((display) => display.id !== state.primaryId);
  console.log(`  displays: ${JSON.stringify(state.displays.map(({ id, bounds }) => ({ id, primary: id === state.primaryId, bounds })))}`);
  if (!secondary) {
    assert.equal(state.displays.length, 1, 'exactly one display');
    assert.equal(state.fullscreen, false, 'with one display the public window is a windowed preview');
    const { workArea } = state.displays[0];
    assert.ok(state.bounds.x >= workArea.x && state.bounds.y >= workArea.y &&
      state.bounds.x + state.bounds.width <= workArea.x + workArea.width &&
      state.bounds.y + state.bounds.height <= workArea.y + workArea.height, 'preview stays in the primary work area');
    step('primary-only display falls back to a preview window');
    return;
  }
  // Fullscreen transitions are asynchronous; wait for the planned state instead of sampling once.
  for (let attempt = 0; attempt < 50 && !state.fullscreen; attempt++) { await delay(200); state = await read(); }
  assert.equal(state.fullscreen, true, 'with a second display the public window is fullscreen');
  const displayOf = state.displays.find((display) => state.bounds.x >= display.bounds.x && state.bounds.x < display.bounds.x + display.bounds.width &&
    state.bounds.y >= display.bounds.y && state.bounds.y < display.bounds.y + display.bounds.height);
  assert.equal(displayOf?.id, secondary.id, 'the fullscreen public window is on the selected secondary display');
  assert.deepEqual(state.bounds, secondary.bounds, 'public window bounds match the secondary display');
  step('secondary display hosts the fullscreen public window');
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
    bridges: ['publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes', 'publicPresentation']
      .map((name) => Object.keys(window[name])),
  })), { desktop: false, require: 'undefined', bridges: Array(5).fill(['subscribe']) });
  step('committed draw reaches the sandboxed, receive-only public window');

  await assertPublicPlacement(app);

  const presentation = await publicWindow.evaluate(() => {
    const cells = [...document.querySelector('#called-numbers').shadowRoot.querySelectorAll('li')];
    return [cells.length, cells.find((cell) => cell.dataset.state === 'latest') !== undefined,
      document.querySelector('#prizes').shadowRoot.querySelectorAll('dt').length, document.querySelectorAll('video').length];
  });
  assert.deepEqual(presentation, [90, true, 2, 0], 'public shows 90 cells, the latest call, two prize rows and no video');
  step('public presentation shows the fixed board, latest call and prizes without video');

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
