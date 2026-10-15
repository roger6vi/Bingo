// Isolated Bingo award smoke (BG-07 S1, #30): `node verification/bingo-award-smoke.mjs` after `npm run build`.
// It drives the real operator UI through the contextual award flow on a fresh temporary profile: configured
// prizes, three manual draws, the line declaration and its public celebration, the Bingo declaration through
// the operator dialog with the default winner count (below two winners the store forces lot_resolution
// not_required, so no lot panel ever appears and no lot draw is needed), the public ¡Bingo! celebration with
// its start acknowledgement, and the refusal of both drawing modes once the Bingo is committed, with the
// board's called numbers preserved. Launch ownership, timeout cancellation and guarded cleanup are owned by
// the shared lifecycle core in bingo-smoke-lifecycle.mjs. Every launch uses the existing temporary-profile
// guard from electron-smoke.mjs (`--user-data-dir` directly inside the OS temp dir, never overlapping the
// real profile); the temporary profile is only ever deleted through the same guarded path. The guard itself
// may stat default-profile metadata read-only to prove non-overlap: that access needs its own runtime
// permission and is never exercised here. On failure a log of the main process and page consoles is written
// to $SMOKE_ARTIFACTS_DIR (default verification/artifacts/bingo-award-smoke). This file never runs on import
// or in CI: it launches real windows and needs explicit permission.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTemporaryProfile, launchArgs, profilePrefix } from './electron-smoke.mjs';
import { runIsolated } from './bingo-smoke-lifecycle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const stepTimeout = 15_000;
const totalTimeout = 180_000;
const DRAWN = [42, 7, 13];
const PRIZES = { line: { amount: 150, lot: 'Jamón ibérico' }, bingo: { amount: 1500, lot: 'Cesta navideña' } };

// The only deletion path in this harness: the existing guard must accept the profile first (an existing
// bingo-smoke-* directory directly inside the OS temp dir that does not overlap the real profile), and only
// its resolved path is removed. Tests inject `guard`/`rm` to observe that ordering without a filesystem.
export function removeTemporaryProfile(profile, { guard = assertTemporaryProfile, rm = rmSync, ...options } = {}) {
  const resolved = guard(profile, options);
  rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return resolved;
}

// Playwright's first main-process evaluate after launch sometimes fails with "Resulting promise was garbage
// collected" (upstream electron-smoke.mjs observation). The read is side-effect free, so retry only that.
async function readUserData(app, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    } catch (error) {
      if (attempt >= attempts || !/Resulting promise was garbage collected/.test(error.message)) throw error;
    }
  }
}

async function smoke() {
  const log = [];
  const artifacts = path.resolve(process.env.SMOKE_ARTIFACTS_DIR ?? path.join(root, 'verification', 'artifacts', 'bingo-award-smoke'));
  const note = (source, text) => log.push(`[${new Date().toISOString()}] ${source}: ${String(text).trimEnd()}`);
  try {
    await runIsolated({
      timeoutMs: totalTimeout,
      allocateProfile: () => realpathSync(mkdtempSync(path.join(tmpdir(), `${profilePrefix}award-`))),
      launch: async (profile) => {
        const { _electron: electron } = await import('playwright');
        return electron.launch({ executablePath: require('electron'), args: launchArgs(profile), timeout: 30_000 });
      },
      verify: async (app, profile) => {
        app.process().stdout?.on('data', (data) => note('award main stdout', data));
        app.process().stderr?.on('data', (data) => note('award main stderr', data));
        const watch = (page) => {
          page.setDefaultTimeout(stepTimeout);
          page.on('console', (message) => note(`${page.url()} console.${message.type()}`, message.text()));
          page.on('pageerror', (error) => note(`${page.url()} pageerror`, error.stack ?? error.message));
        };
        app.windows().forEach(watch);
        app.on('window', watch);
        const operator = await app.firstWindow();
        // Once the operator window exists main is ready; confirm it really runs on the temporary profile.
        assert.equal(realpathSync(await readUserData(app)), profile, 'Electron must run on the temporary --user-data-dir');
        return { operator };
      },
      closeApp: async (app) => {
        await app.close().catch(() => app.process().kill('SIGKILL'));
      },
      removeProfile: (profile) => removeTemporaryProfile(profile),
    }, async ({ app, operator, profile, check }) => {
      const step = async (name, body) => {
        check(); // between-steps cancellation: a timed-out run starts no new step
        const started = Date.now();
        try {
          await body();
        } catch (error) {
          throw new Error(`Smoke step "${name}" failed: ${error.message}`, { cause: error });
        }
        console.log(`✓ ${name} (${Date.now() - started} ms)`);
      };
      let publicWindow;
      const celebrate = async (kind) => {
        await operator.waitForFunction((expected) => {
          const celebration = document.querySelector('#line-celebration');
          return celebration.active === true && celebration.kind === expected;
        }, kind, { timeout: 30_000 });
        await operator.waitForFunction(() => document.querySelector('#line-celebration').active === false,
          null, { timeout: 30_000 });
      };

      await step('app starts on an isolated temporary profile', async () => {
        await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
        assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'the database lives in the temporary profile');
      });

      await step('prizes are configured through the settings form and saved', async () => {
        await operator.fill('#settings-line-amount input', String(PRIZES.line.amount));
        await operator.fill('#settings-line-lot input', PRIZES.line.lot);
        await operator.fill('#settings-bingo-amount input', String(PRIZES.bingo.amount));
        await operator.fill('#settings-bingo-lot input', PRIZES.bingo.lot);
        await operator.click('#tab-bingo');
        await operator.locator('#unsaved-dialog dialog').waitFor({ state: 'visible' });
        await operator.locator('#unsaved-dialog [data-action="save"] button').click();
        await operator.waitForFunction(() => document.querySelector('#tab-bingo').getAttribute('aria-selected') === 'true');
      });

      await step('the public window is attached', async () => {
        [publicWindow] = await Promise.all([
          app.waitForEvent('window'),
          operator.locator('#open-public button').click(),
        ]);
        await publicWindow.waitForFunction(() => document.querySelector('#called-count')?.value === '0');
      });

      await step('three numbers are drawn by hand', async () => {
        for (const number of DRAWN) {
          await operator.locator(`#operator-board [data-number="${number}"]`).click();
          await operator.waitForFunction((n) => document.querySelector('#called-numbers').calledNumbers.includes(n), number);
        }
        assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), DRAWN.length);
      });

      await step('the line is declared through its dialog and celebrated once', async () => {
        await operator.locator('#claim-line').click();
        await operator.locator('#line-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#line-winners input'), '1', 'the line dialog starts at one winner');
        await operator.locator('#line-dialog [data-action="confirm"] button').click();
        await celebrate('line');
      });

      await step('the Bingo claim is enabled after the Line celebration', async () => {
        // Default one winner: the store forces lot_resolution not_required, so the Line lot panel never
        // appears and no lot draw is needed (or possible) before the Bingo claim unlocks.
        await operator.waitForFunction(() => !document.querySelector('#claim-bingo').disabled);
      });

      await step('the bingo is declared through the dialog and celebrated publicly', async () => {
        await operator.locator('#claim-bingo').click();
        await operator.locator('#bingo-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#bingo-winners input'), '1', 'the dialog starts at the default one winner');
        await operator.locator('#bingo-dialog [data-action="confirm"] button').click();
        await celebrate('bingo');
        assert.equal(await publicWindow.locator('#bingo-award').evaluate((award) => !award.hidden && award.textContent !== ''),
          true, 'the committed bingo facts stay static on the public page');
        // The public start receipt completed the presentation: neither manual action may be offered.
        assert.equal(await operator.locator('#bingo-retry').isVisible(), false, 'a completed celebration offers no retry');
        assert.equal(await operator.locator('#bingo-repeat').isVisible(), false, 'a completed celebration offers no repeat');
      });

      await step('the board is locked, the calls preserved and both draws refuse', async () => {
        const before = await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]);
        assert.equal(await operator.evaluate(() => document.querySelector('#draw-controls').manualDisabled), true,
          'manual drawing is locked after the committed bingo');
        assert.equal(await operator.evaluate(() => document.querySelector('#operator-board').disabled), true,
          'the board is locked after the committed bingo');
        const refusals = await operator.evaluate((n) =>
          Promise.all([window.desktop.drawManual(n), window.desktop.drawDigital()])
            .then((results) => results.map((result) => result.code)), 50);
        // The store refuses drawing before the transition; IPC classifies that domain refusal as
        // invalid_draw. Neither drawing mode may alter the committed calls or unlock the board.
        assert.deepEqual(refusals, ['invalid_draw', 'invalid_draw'], 'main refuses both drawing modes after the committed bingo');
        assert.deepEqual(await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]), before,
          'the called numbers are preserved');
      });
    });
    console.log('Bingo award smoke passed');
  } catch (error) {
    try {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(path.join(artifacts, 'bingo-award-smoke.log'), `${log.join('\n')}\n`);
      console.error(`Smoke artifacts written to ${artifacts}`);
    } catch (cause) {
      console.error(`Could not save smoke artifacts: ${cause.message}`);
    }
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(root, 'dist', 'main.js'))) {
    console.error('✗ dist/ is missing: run `npm run build` first (this harness does not build).');
    process.exitCode = 1;
  } else {
    const started = Date.now();
    try {
      await smoke();
      console.log(`completed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.error(`✗ ${error.message}`);
      if (error.cause?.stack) console.error(error.cause.stack);
      if (error.cleanupFailures) {
        console.error(`cleanup failures: ${error.cleanupFailures.map((failure) => failure.message).join('; ')}`);
      }
      process.exitCode = 1;
    }
  }
}
