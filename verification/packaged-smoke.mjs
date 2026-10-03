// Smoke for a *packaged* build (#40, #41). Usage:
//   node verification/packaged-smoke.mjs [<app executable>]
// The profile is always a harness-created canonical bingo-smoke-* --user-data-dir directly under the OS temp dir
// (see line-smoke-lifecycle.mjs) and both phases run back to back. The Windows installer-upgrade flow instead supplies
// one profile per invocation (`<exe> <profile> seed|upgraded`): it must be an absolute, canonical, non-symlink directory
// directly under the OS temp dir named bingo-*, new or empty for seed and holding the seed database for upgraded. A
// supplied profile is never deleted by this harness (the workflow owns it); only apps are terminated.
// Right after every launch the runtime app.getPath('userData') is asserted equal to the profile, and every launched
// process (apps and the broken-database child) is terminated (graceful, bounded, SIGKILL fallback, exit awaited)
// before the profile is deleted, on success and failure. A process that will not exit keeps the profile.
// The executable path is optional: `BINGO_PACKAGED_APP` or the default `release/` output for the current platform
// (macOS `mac-arm64`/`mac`, Linux `linux-unpacked`) is used when it is omitted, so `npm run test:package` runs
// unmodified on macOS and Linux. Import-safe: nothing runs unless this file is the entry point.
// Display-aware: one display (CI runners) expects a windowed preview; with a second display the public
// window must be fullscreen on the first non-primary display, as planPublicWindow selects.
import assert from 'node:assert/strict';
import { execFileSync as realExecFileSync, spawn as realSpawn } from 'node:child_process';
import { existsSync as realExists, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createFixture, terminateApp } from './line-smoke-lifecycle.mjs';

const database = (profile) => path.join(profile, 'current-event.sqlite');
const defaultExecutable = (platform) => {
  const release = path.resolve(import.meta.dirname, '..', 'release');
  return { darwin: path.join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bingo.app', 'Contents', 'MacOS', 'Bingo'),
    linux: path.join(release, 'linux-unpacked', 'bingo') }[platform];
};

export const isEntry = (metaUrl, argv1) => {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(argv1)); } catch { return false; }
};

// Playwright's first main-process evaluate can fail once with "Resulting promise was garbage collected".
async function readUserData(app, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')); }
    catch (error) { if (attempt >= attempts || !/garbage collected/.test(error.message)) throw error; }
  }
}

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
async function assertPublicPlacement(app, step, delay) {
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

async function seed({ profile, launch, restart, step, delay }) {
  let app = await launch();
  let operator = await openOperator(app);
  assert.match(operator.url(), /^file:.*app\.asar[\\/]dist[\\/]renderer[\\/]operator\.html$/);
  assert.ok(realExists(database(profile)), 'the database lives in the temporary profile');
  step('packaged renderer loads from app.asar with an isolated profile');

  await operator.click('#tab-bingo');
  await operator.locator('#draw-controls label', { hasText: 'Digital' }).click();
  await operator.locator('#draw-digital button').click();
  await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
  assert.deepEqual(await publicWindow.evaluate(() => ({
    desktop: 'desktop' in window, require: typeof require,
    bridges: ['publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes', 'publicLineAward', 'publicPresentation',
      'publicLineReceipt'].map((name) => Object.keys(window[name])),
  })), { desktop: false, require: 'undefined', bridges: [...Array(6).fill(['subscribe']), ['started']] });
  step('committed draw reaches the sandboxed, receive-only public window');

  await assertPublicPlacement(app, step, delay);

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

  app = await restart(app);
  await expectSaved(await openOperator(app));
  step('event, history and theme survive restart');
}

async function upgraded({ launch, step }) {
  const app = await launch();
  const operator = await openOperator(app);
  await expectSaved(operator);
  const transition = () => operator.locator('#open-public').evaluate((host) =>
    getComputedStyle(host.shadowRoot.querySelector('button')).transitionDuration);
  assert.notEqual(await transition(), '0s');
  await operator.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await transition(), '0s');
  step('state survives reinstall/upgrade; reduced motion disables packaged button transitions');
}

// An unreadable database must stay untouched: startup shows an error instead of resetting it. The child runs on its
// own harness-created profile and is always terminated (exit awaited) before that profile is deleted.
export async function checkBrokenDatabase({ executablePath, step, spawn = realSpawn, execFileSync = realExecFileSync,
  platform = process.platform, uid = process.getuid?.(), waitMs = 5000, settleMs = 1000, ...fixtureOptions }) {
  const fixture = createFixture({ tmp: fixtureOptions.tmp, rm: fixtureOptions.rm, closeMs: fixtureOptions.closeMs, killMs: fixtureOptions.killMs });
  const broken = fixture.path;
  try {
    const garbage = Buffer.from('not a sqlite database');
    writeFileSync(database(broken), garbage);
    const child = spawn(executablePath, [`--user-data-dir=${broken}`, ...(uid === 0 ? ['--no-sandbox'] : [])], { stdio: 'ignore' });
    // Tracked before any await: close() is the platform kill, terminateApp escalates and awaits the exit.
    fixture.track({ process: () => child,
      close: () => { platform === 'win32' ? execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f']) : child.kill('SIGKILL'); } });
    await delay(waitMs);
    // Windows keeps the modal startup error box open, so the process must still be alive.
    if (platform === 'win32') assert.equal(child.exitCode, null, 'the startup error stays on screen');
    await fixture.closeAll();
    await delay(settleMs);
    assert.deepEqual(readFileSync(database(broken)), garbage);
    step('unreadable database is preserved, not reset');
  } finally {
    await fixture.dispose();
  }
}


const refuse = (profile, why) => new Error(`Refusing the supplied profile ${profile}: ${why}`);

// Bounded acceptance of a CI-supplied profile. Returns the canonical path (a missing seed profile is created).
// The parent must be exactly the OS temp dir or, on CI, the runner's own RUNNER_TEMP (which GitHub-hosted Windows
// runners keep apart from os.tmpdir()). RUNNER_TEMP counts only when absolute and an existing canonical directory.
const allowedParents = (tmp, runnerTemp) => {
  const parents = [realpathSync(tmp)];
  if (runnerTemp && path.isAbsolute(runnerTemp) && realExists(runnerTemp)) parents.push(realpathSync(runnerTemp));
  return parents;
};

export function validateSuppliedProfile(profile, phase, tmp = osTmpdir(), runnerTemp = undefined) {
  if (!path.isAbsolute(profile)) throw refuse(profile, 'it must be absolute');
  if (phase !== 'seed' && phase !== 'upgraded') throw refuse(profile, `phase must be seed or upgraded, got ${phase}`);
  const parents = allowedParents(tmp, runnerTemp);
  if (!parents.includes(path.dirname(profile))) throw refuse(profile, `it must be directly under the temp dir ${parents.join(' or ')}`);
  if (!path.basename(profile).startsWith('bingo-')) throw refuse(profile, 'its name must start with bingo-');
  if (!realExists(profile)) {
    if (phase === 'upgraded') throw refuse(profile, 'an upgraded profile must already contain the seed database');
    mkdirSync(profile);
  }
  if (lstatSync(profile).isSymbolicLink()) throw refuse(profile, 'a symlink is not a profile');
  if (!lstatSync(profile).isDirectory()) throw refuse(profile, 'it is not a directory');
  if (realpathSync(profile) !== profile) throw refuse(profile, 'it is not canonical');
  if (phase === 'seed' && readdirSync(profile).length) throw refuse(profile, 'a seed profile must be new or empty');
  if (phase === 'upgraded' && !realExists(database(profile))) throw refuse(profile, 'an upgraded profile must already contain the seed database');
  return profile;
}

// Same surface as the owned fixture, but dispose only terminates: a supplied profile is never deleted.
function suppliedFixture(profile, { closeMs, killMs }) {
  const apps = new Set();
  const stop = async (app) => { await terminateApp(app, { closeMs, killMs }); apps.delete(app); };
  const closeAll = async () => {
    const errors = [];
    for (const app of [...apps]) await stop(app).catch((error) => errors.push(error));
    if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
  };
  return { path: profile, track: (app) => apps.add(app), closeAll, dispose: closeAll,
    restart: async (app, launch) => { await stop(app); return launch(); } };
}

const phaseTable = { seed, upgraded };

export async function main({ argv = process.argv.slice(2), env = process.env, platform = process.platform, uid = process.getuid?.(),
  electron, exists = realExists, log = console.log, phases = phaseTable, tmp, rm, closeMs, killMs, ...rest } = {}) {
  const [executableArg, profileArg, phaseArg] = argv;
  const executablePath = executableArg ?? env.BINGO_PACKAGED_APP ?? defaultExecutable(platform);
  assert.ok(executablePath && exists(executablePath), `packaged executable not found: ${executablePath ?? `no default for ${platform}`}`);
  const step = (name) => log(`✓ ${name}`);
  const fixture = profileArg === undefined ? createFixture({ tmp, rm, closeMs, killMs })
    : suppliedFixture(validateSuppliedProfile(profileArg, phaseArg, tmp, env.RUNNER_TEMP), { closeMs, killMs });
  const profile = fixture.path;
  // Chromium refuses to run as root without disabling its own sandbox (e.g. in Linux containers).
  const args = (extra) => [`--user-data-dir=${profile}`, ...(uid === 0 ? ['--no-sandbox'] : []), ...extra];
  const launch = async (extra = []) => {
    const app = await electron.launch({ executablePath, args: args(extra) });
    fixture.track(app);
    try {
      const userData = await readUserData(app);
      if (userData !== profile) throw new Error(`Electron userData ${userData} is not the profile ${profile}`);
    } catch (error) {
      await terminateApp(app, { closeMs, killMs }).catch(() => {});
      throw error;
    }
    return app;
  };
  const context = { executablePath, profile, step, delay, launch, restart: (app) => fixture.restart(app, launch) };
  try {
    if (profileArg === undefined || phaseArg === 'seed') await phases.seed(context);
    if (profileArg === undefined || phaseArg === 'upgraded') {
      await phases.upgraded(context);
      await checkBrokenDatabase({ executablePath, step, platform, uid, tmp, rm, closeMs, killMs, ...rest });
    }
  } finally {
    await fixture.dispose(); // terminates every tracked app and awaits exit; deletes only a harness-created profile, and keeps it if an app will not exit
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  const { _electron: electron } = await import('playwright');
  await main({ electron });
}
