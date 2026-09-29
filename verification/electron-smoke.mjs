// Isolated Electron smoke of the built app (#59, #60, #72, #77, #78): `npm run test:smoke`, or in CI
// `xvfb-run -a npm run test:smoke`. It rebuilds when dist/ is missing or older than its sources, and on
// Linux without a display re-runs itself under `xvfb-run -a`. Every launch uses a fresh temporary
// --user-data-dir that is verified before and after startup; the real profile is never used and the
// temporary one is always deleted. On failure, screenshots of every open window and a log of the main
// process and page consoles are written to $SMOKE_ARTIFACTS_DIR (default verification/artifacts/electron-smoke).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const appName = require('../package.json').name;
export const profilePrefix = 'bingo-smoke-';
const stepTimeout = 15_000;
const totalTimeout = 150_000;

const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

// Electron's default userData for this app (appData + package name) — the real profile to protect.
export function defaultUserData({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  // Join with the target platform's separators, not the host's, so the result is host-independent.
  const { join } = platform === 'win32' ? path.win32 : path.posix;
  const appData = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(appData, appName);
}

// Resolves symlinks in whatever prefix of `target` already exists (macOS /var → /private/var), and
// rejoins the remaining, not-yet-created path segments unresolved. Safe for paths that do not exist yet:
// it never calls realpathSync on a missing entry, only on the deepest existing ancestor.
function canonicalizeExistingAncestor(target) {
  let current = path.resolve(target);
  const missingSuffix = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current; // no existing ancestor (e.g. root itself is missing)
    missingSuffix.unshift(path.basename(current));
    current = parent;
  }
  const resolvedBase = realpathSync(current);
  return missingSuffix.length ? path.join(resolvedBase, ...missingSuffix) : resolvedBase;
}

// Throws unless `profile` is an existing smoke directory directly inside the OS temp dir. Paths are
// compared after resolving symlinks (macOS /var → /private/var), so the real profile can never qualify.
export function assertTemporaryProfile(profile, { temp = tmpdir(), realProfile = defaultUserData() } = {}) {
  if (typeof profile !== 'string' || profile === '') throw new Error('Refusing to launch Electron without a temporary --user-data-dir');
  if (!existsSync(profile)) throw new Error(`Refusing to launch Electron: --user-data-dir ${profile} does not exist`);
  const resolved = realpathSync(profile);
  const resolvedTemp = realpathSync(temp);
  if (path.dirname(resolved) !== resolvedTemp || !path.basename(resolved).startsWith(profilePrefix)) {
    throw new Error(`Refusing to launch Electron: --user-data-dir ${resolved} is not a ${profilePrefix}* directory in ${resolvedTemp}`);
  }
  // The real profile may not exist yet (first launch ever); canonicalize only its existing ancestor so a
  // symlinked temp root (e.g. macOS /var) cannot make an overlapping path escape detection.
  const real = canonicalizeExistingAncestor(realProfile);
  if (within(real, resolved) || within(resolved, real)) {
    throw new Error(`Refusing to launch Electron: --user-data-dir ${resolved} overlaps the real profile ${real}`);
  }
  return resolved;
}

// The only way this script builds Electron arguments: the profile check cannot be skipped.
export function launchArgs(profile, { isRoot = process.getuid?.() === 0, ...options } = {}) {
  const resolved = assertTemporaryProfile(profile, options);
  // Chromium refuses to run as root without disabling its own sandbox (e.g. in containers).
  return [root, `--user-data-dir=${resolved}`, ...(isRoot ? ['--no-sandbox'] : [])];
}

function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(target).filter((name) => name !== 'generated').map((name) => newestMtime(path.join(target, name))));
}

function ensureBuilt() {
  const outputs = ['dist/main.js', 'dist/preload.js', 'dist/public-preload.js', 'dist/renderer/operator.html', 'dist/renderer/public.html']
    .map((file) => path.join(root, file));
  const sources = ['src', 'tokens', 'assets', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs',
    'style-dictionary.config.mjs', 'scripts/build-tokens.mjs'].map((file) => path.join(root, file));
  const built = Math.min(...outputs.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)));
  if (built > Math.max(...sources.map(newestMtime))) return;
  console.log('dist/ is missing or stale: running npm run build');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`npm run build failed (exit ${result.status ?? result.signal})`);
}

// Linux needs an X server. Re-run under xvfb-run when none is set, or explain how to get one.
function reexecUnderXvfbIfNeeded() {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
  if (process.env.BINGO_SMOKE_XVFB === '1') throw new Error('xvfb-run started without providing DISPLAY');
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) throw new Error('No display found (DISPLAY is unset) and xvfb-run is not installed. Install Xvfb or run under a desktop session.');
  const result = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, BINGO_SMOKE_XVFB: '1' } });
  process.exitCode = result.status ?? 1;
  return true;
}

// Playwright's first main-process evaluate after launch sometimes fails with "Resulting promise was
// garbage collected" (seen on Linux in CI and locally, never on a later call). The read is side-effect
// free, so retry only that error a bounded number of times.
async function readMainPaths(app, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await app.evaluate(({ app: electronApp }) => ({ userData: electronApp.getPath('userData'),
        appData: electronApp.getPath('appData'), name: electronApp.getName() }));
    } catch (error) {
      if (attempt >= attempts || !/Resulting promise was garbage collected/.test(error.message)) throw error;
    }
  }
}

function snapshot(file) {
  if (!existsSync(file)) return null;
  const { mtimeMs, size } = statSync(file);
  return { mtimeMs, size };
}

async function smoke() {
  const { _electron: electron } = await import('playwright');
  const executablePath = require('electron');
  const artifacts = path.resolve(process.env.SMOKE_ARTIFACTS_DIR ?? path.join(root, 'verification', 'artifacts', 'electron-smoke'));
  const realProfile = defaultUserData();
  const realDatabase = path.join(realProfile, 'current-event.sqlite');
  const realBefore = snapshot(realDatabase);
  const profile = realpathSync(mkdtempSync(path.join(tmpdir(), profilePrefix)));
  const log = [];
  const record = (source, text) => log.push(`[${new Date().toISOString()}] ${source}: ${String(text).trimEnd()}`);
  const apps = new Set();
  let current = 'startup';
  let timer;

  const launch = async (label) => {
    const app = await electron.launch({ executablePath, args: launchArgs(profile), timeout: 30_000 });
    apps.add(app);
    app.process().stdout?.on('data', (data) => record(`${label} main stdout`, data));
    app.process().stderr?.on('data', (data) => record(`${label} main stderr`, data));
    const watch = (page) => {
      page.setDefaultTimeout(stepTimeout);
      page.on('console', (message) => record(`${label} ${page.url()} console.${message.type()}`, message.text()));
      page.on('pageerror', (error) => record(`${label} ${page.url()} pageerror`, error.stack ?? error.message));
      page.on('crash', () => record(`${label} ${page.url()}`, 'renderer crashed'));
    };
    app.windows().forEach(watch);
    app.on('window', watch);
    app.on('close', () => apps.delete(app));
    const operator = await app.firstWindow();
    // Once the operator window exists the main process is ready; confirm it really runs on the temp profile.
    const paths = await readMainPaths(app);
    assert.equal(realpathSync(paths.userData), profile, 'Electron must run on the temporary --user-data-dir');
    assert.equal(path.join(paths.appData, paths.name), realProfile, 'the protected real profile path matches Electron');
    return { app, operator };
  };
  const close = async (app) => {
    await app.close().catch(() => app.process().kill('SIGKILL'));
    apps.delete(app);
  };
  const step = async (name, body) => {
    current = name;
    const started = Date.now();
    try {
      await body();
    } catch (error) {
      throw new Error(`Smoke step "${name}" failed: ${error.message}`, { cause: error });
    }
    console.log(`✓ ${name} (${Date.now() - started} ms)`);
  };
  const saveArtifacts = async (error) => {
    mkdirSync(artifacts, { recursive: true });
    let index = 0;
    for (const app of apps) {
      for (const page of app.windows()) {
        const name = `window-${++index}-${path.basename(new URL(page.url() || 'about:blank').pathname) || 'blank'}.png`;
        await page.screenshot({ path: path.join(artifacts, name), timeout: 5_000 })
          .catch((cause) => record('artifacts', `screenshot ${name} failed: ${cause.message}`));
      }
    }
    record('failure', `${current}\n${error.stack ?? error}`);
    writeFileSync(path.join(artifacts, 'electron-smoke.log'), `${log.join('\n')}\n`);
    console.error(`Smoke artifacts written to ${artifacts}`);
  };

  const banner = (page) => page.locator('#active-event-banner').evaluate((element) => element.message);
  const simulatorFrame = async (page) => {
    const frame = await (await page.locator('#public-simulator').elementHandle()).contentFrame();
    await frame.waitForFunction(() => document.documentElement.dataset.theme !== undefined, null, { timeout: stepTimeout });
    return frame;
  };
  const visiblePanels = (page) => page.evaluate(() => [...document.querySelectorAll('[role="tabpanel"]')]
    .filter((panel) => !panel.hidden).map((panel) => panel.id));
  const boards = (...pages) => Promise.all(pages.map((page) => page.evaluate(() =>
    [[...document.querySelector('#called-numbers').calledNumbers], document.querySelector('#phase-status').message])));
  const tongoState = (page) => page.evaluate(() => ({ progress: document.querySelector('#tongo-control').progress,
    error: document.querySelector('#tongo-error').hidden ? null : document.querySelector('#tongo-error').message }));
  const eventList = (page) => page.locator('#event-list').evaluate((list) => list.events.map(({ name, active }) => ({ name, active })));

  const run = async () => {
    let app, operator, publicWindow, simulator;
    await step('app starts on an isolated profile', async () => {
      ({ app, operator } = await launch('first launch'));
      await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
      assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'the database lives in the temporary profile');
    });

    await step('three operator tabs', async () => {
      assert.deepEqual(await visiblePanels(operator), ['panel-events'], 'Eventos is the initial tab');
      for (const [tab, panel] of [['tab-settings', 'panel-settings'], ['tab-bingo', 'panel-bingo'], ['tab-events', 'panel-events']]) {
        await operator.click(`#${tab}`);
        assert.equal(await operator.locator(`#${tab}`).getAttribute('aria-selected'), 'true', `${tab} is selected`);
        assert.deepEqual(await visiblePanels(operator), [panel], `only ${panel} is visible`);
      }
    });

    await step('full-viewport tabs without document scroll', async () => {
      // The operator is a full-viewport application: no document scroll on any tab at desktop sizes.
      // Playwright's CDP viewport override is used instead of BrowserWindow content-size, which the OS
      // clamps to the physical display's work area: this exercises real layout/rendering at both sizes
      // regardless of the host machine's actual screen size.
      for (const [width, height] of [[1280, 720], [1920, 1080]]) {
        await operator.setViewportSize({ width, height });
        await operator.waitForFunction((size) => innerWidth === size[0] && innerHeight === size[1], [width, height]);
        for (const tab of ['events', 'settings', 'bingo']) {
          await operator.click(`#tab-${tab}`);
          const scroll = await operator.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight]);
          assert.deepEqual(scroll, [width, height], `${tab} at ${width}×${height}`);
        }
      }
      await operator.click('#tab-events');
    });

    await step('Tongo without a public window is refused', async () => {
      // No acknowledgement and no playback: main only acknowledges a signal a live public window accepted.
      await operator.click('#tab-bingo');
      await operator.waitForFunction(() => !document.querySelector('#tongo-control').disabled);
      await operator.locator('#tongo-control button').click();
      await operator.waitForFunction(() => !document.querySelector('#tongo-error').hidden);
      assert.deepEqual(await tongoState(operator),
        { progress: null, error: 'Abre la pantalla pública y vuelve a intentar el Tongo.' });
      await operator.click('#tab-events');
    });

    await step('manual call from the 1–90 board reaches the public window', async () => {
      // Manual mode: the board shows 42 as called only after the acknowledged draw.
      await operator.click('#tab-bingo');
      const cell = operator.locator('#operator-board [data-number="42"]');
      assert.equal(await cell.getAttribute('data-state'), 'uncalled');
      await cell.click();
      await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
      assert.equal(await cell.getAttribute('data-state'), 'latest');
      assert.equal(await cell.getAttribute('aria-label'), 'Número 42, última bola cantada');
      // Playwright refuses to click aria-disabled elements; force the click to prove the cell is inert.
      await cell.click({ force: true });
      assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), 1, 'a called number is inert');
      [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
      await publicWindow.waitForFunction(() => document.querySelectorAll('#called-numbers').length === 1 &&
        document.querySelector('#called-count').value === '1' && document.querySelector('#event-name').textContent === 'Evento actual');
    });

    await step('keyboard tab navigation', async () => {
      await operator.locator('#tab-bingo').focus();
      await operator.keyboard.press('ArrowLeft');
      assert.equal(await operator.locator('#tab-settings').getAttribute('aria-selected'), 'true');
    });

    await step('draft preview reaches only the simulator', async () => {
      simulator = await simulatorFrame(operator);
      // The shared field components wrap native controls in their shadow roots; Playwright pierces them.
      await operator.fill('#settings-name input', 'Verbena de prueba');
      await operator.fill('#settings-place input', 'Plaza Mayor');
      await operator.selectOption('#theme-select select', 'high-contrast');
      await simulator.waitForFunction(() => document.querySelector('#event-name').textContent === 'Verbena de prueba' &&
        document.querySelector('#event-details').textContent.endsWith('· Plaza Mayor') &&
        document.documentElement.dataset.theme === 'high-contrast' && document.querySelector('#called-count').value === '1',
      null, { timeout: stepTimeout });
      assert.equal(await publicWindow.locator('#event-name').textContent(), 'Evento actual');
      assert.equal(await publicWindow.evaluate(() => document.documentElement.dataset.theme), 'jules');
      assert.equal(await operator.evaluate(() => document.documentElement.dataset.theme), 'jules');
      assert.match(await banner(operator), /^Evento activo: Evento actual/);
    });

    await step('receive-only public boundary and bridge-free simulator', async () => {
      // The simulator is the production public page with no privileged bridge at all.
      assert.deepEqual(await simulator.evaluate(() => ({
        own: ['desktop', 'publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes', 'publicPresentation'].filter((name) => name in window),
        parentDesktop: (() => { try { return 'desktop' in window.parent; } catch { return 'blocked'; } })(),
      })), { own: [], parentDesktop: 'blocked' });
      // The public window can only subscribe.
      assert.deepEqual(await publicWindow.evaluate(() => ({
        desktop: 'desktop' in window, require: typeof require,
        bridges: ['publicEvent', 'publicTheme', 'publicEventMeta', 'publicEventPrizes', 'publicPresentation']
          .map((name) => Object.keys(window[name])),
      })), { desktop: false, require: 'undefined', bridges: [['subscribe'], ['subscribe'], ['subscribe'], ['subscribe'], ['subscribe']] });
    });

    await step('Save / Discard / Cancel guard', async () => {
      // Cancel stays, Save commits and then leaves.
      await operator.click('#tab-bingo');
      const dialog = operator.locator('#unsaved-dialog dialog');
      await dialog.waitFor({ state: 'visible' });
      await operator.locator('#unsaved-dialog [data-action="cancel"] button').click();
      assert.equal(await operator.locator('#tab-settings').getAttribute('aria-selected'), 'true');
      await operator.click('#tab-bingo');
      await dialog.waitFor({ state: 'visible' });
      await operator.locator('#unsaved-dialog [data-action="save"] button').click();
      await operator.waitForFunction(() => document.querySelector('#tab-bingo').getAttribute('aria-selected') === 'true');
    });

    await step('save reaches both windows and banners', async () => {
      // History is untouched by a metadata/theme save.
      await publicWindow.waitForFunction(() => document.querySelector('#event-name').textContent === 'Verbena de prueba' &&
        document.documentElement.dataset.theme === 'high-contrast');
      assert.equal(await publicWindow.locator('#called-count').evaluate((output) => output.value), '1');
      assert.equal(await operator.evaluate(() => document.documentElement.dataset.theme), 'high-contrast');
      assert.match(await banner(operator), /^Evento activo: Verbena de prueba — \d{4}-\d{2}-\d{2}, Plaza Mayor$/);
    });

    await step('event creation and selection', async () => {
      await operator.click('#tab-events');
      await operator.fill('#event-name input', 'Segundo evento');
      await operator.fill('#event-place input', 'Salón social');
      await operator.click('#create-event-submit');
      await operator.waitForFunction(() => document.querySelector('#event-list').events?.length === 2);
      const byName = (a, b) => a.name.localeCompare(b.name);
      assert.deepEqual((await eventList(operator)).sort(byName),
        [{ name: 'Segundo evento', active: false }, { name: 'Verbena de prueba', active: true }], 'creating an event keeps the active one');
      // Activating the new event switches the operator panels and the public window to its empty history.
      await operator.getByRole('button', { name: 'Activar «Segundo evento»' }).click();
      await operator.waitForFunction(() => document.querySelector('#event-list').events.find((event) => event.active)?.name === 'Segundo evento');
      await publicWindow.waitForFunction(() => document.querySelector('#event-name').textContent === 'Segundo evento' &&
        document.querySelector('#called-count').value === '0');
      await operator.waitForFunction(() => document.querySelector('#event-summary').count === 0);
      assert.match(await banner(operator), /^Evento activo: Segundo evento — \d{4}-\d{2}-\d{2}, Salón social$/);
      // Re-activating the first event restores its committed history everywhere.
      await operator.getByRole('button', { name: 'Activar «Verbena de prueba»' }).click();
      await publicWindow.waitForFunction(() => document.querySelector('#event-name').textContent === 'Verbena de prueba' &&
        document.querySelector('#called-count').value === '1');
      await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1);
    });

    await step('Tongo plays once, blocks live actions, and restores the committed board', async () => {
      await publicWindow.emulateMedia({ reducedMotion: 'reduce' });
      await operator.click('#tab-bingo');
      const committed = await boards(operator, publicWindow);
      await operator.waitForFunction(() => !document.querySelector('#tongo-control').disabled);
      await operator.locator('#tongo-control button').click();
      await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === true);
      assert.equal(await publicWindow.locator('#tongo').evaluate((overlay) =>
        getComputedStyle(overlay.shadowRoot.querySelector('.card')).animationName), 'none', 'static under reduced motion');
      assert.equal(await publicWindow.locator('#tongo').evaluate((overlay) =>
        overlay.shadowRoot.querySelector('[role="status"]').textContent), '¡Tongo! Reclamación no válida. El juego continúa.');
      await operator.waitForFunction(() => document.querySelector('#tongo-control').progress !== null &&
        document.querySelector('#operator-board').disabled && document.querySelector('#draw-controls').manualDisabled &&
        document.querySelector('#event-list').disabled);
      assert.equal((await tongoState(operator)).error, null);
      // Main refuses a second Tongo and any draw even if the renderer bypassed its locks.
      assert.deepEqual(await operator.evaluate(() => Promise.all([window.desktop.playTongo(), window.desktop.drawDigital(),
        window.desktop.drawManual(50)]).then((results) => results.map((result) => result.code))),
      ['busy', 'presentation_active', 'presentation_active']);
      assert.deepEqual(await boards(operator, publicWindow), committed);
      await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === false);
      await operator.waitForFunction(() => document.querySelector('#tongo-control').progress === null &&
        !document.querySelector('#operator-board').disabled && !document.querySelector('#event-list').disabled);
      assert.deepEqual(await boards(operator, publicWindow), committed);
    });

    await step('reloads during Tongo do not replay it', async () => {
      const committed = await boards(operator, publicWindow);
      await operator.locator('#tongo-control button').click();
      await publicWindow.waitForFunction(() => document.querySelector('#tongo').active === true);
      await Promise.all([publicWindow.reload(), operator.reload()]);
      await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '1');
      await operator.waitForFunction(() => document.querySelector('#event-summary')?.count === 1);
      assert.equal(await publicWindow.evaluate(() => document.querySelector('#tongo').active), false);
      assert.equal((await tongoState(operator)).progress, null);
      await operator.waitForTimeout(3200);
      assert.equal(await publicWindow.evaluate(() => document.querySelector('#tongo').active), false);
      assert.deepEqual(await boards(operator, publicWindow), committed);
    });
    await close(app);

    await step('configuration, theme, events and history survive restart', async () => {
      ({ app, operator } = await launch('restart'));
      await operator.waitForFunction(() => document.querySelector('#settings-name')?.value === 'Verbena de prueba' &&
        document.documentElement.dataset.theme === 'high-contrast');
      assert.equal(await operator.inputValue('#settings-place input'), 'Plaza Mayor');
      assert.equal(await operator.inputValue('#theme-select select'), 'high-contrast');
      assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), 1);
      await operator.waitForFunction(() => document.querySelector('#event-list').events?.length === 2);
      assert.equal((await eventList(operator)).find((event) => event.active)?.name, 'Verbena de prueba');
      assert.equal(await operator.locator('#operator-board [data-number="42"]').getAttribute('data-state'), 'latest');
    });

    await step('digital draw with a read-only board', async () => {
      await operator.click('#tab-bingo');
      await operator.locator('#draw-controls label', { hasText: 'Digital' }).click();
      assert.equal(await operator.locator('#operator-board').evaluate((board) => board.readonly), true);
      await operator.locator('#draw-digital button').click();
      await operator.waitForFunction(() => document.querySelector('#event-summary').count === 2);
      assert.equal(await operator.locator('#operator-board [data-state="latest"]').count(), 1);
      assert.equal(await operator.locator('#operator-board [data-number="42"]').getAttribute('data-state'), 'called');
    });
    await close(app);

    await step('real profile untouched', async () => {
      assert.deepEqual(snapshot(realDatabase), realBefore, `${realDatabase} must not be created or modified`);
    });
  };

  const started = Date.now();
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Smoke timed out after ${totalTimeout / 1000} s during "${current}"`)), totalTimeout);
    })]);
    console.log(`Electron smoke passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    await saveArtifacts(error).catch((cause) => console.error(`Could not save smoke artifacts: ${cause.message}`));
    throw error;
  } finally {
    clearTimeout(timer);
    for (const app of apps) await close(app);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(!existsSync(profile), `temporary profile ${profile} was deleted`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!reexecUnderXvfbIfNeeded()) {
      ensureBuilt();
      await smoke();
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    if (error.cause?.stack) console.error(error.cause.stack);
    process.exitCode = 1;
  }
}
