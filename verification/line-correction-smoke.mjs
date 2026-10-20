// Isolated line correction smoke (#29 T5): `node verification/line-correction-smoke.mjs` after
// `npm run build`. It drives the real operator UI through the audited line correction flow end to end:
// configured prizes, three manual draws, the line declared and celebrated, the committed line CORRECTED
// through the operator's reason dialog (the rail reverts to the drawing state, the public window learns
// the award is gone without any celebration, and the board re-opens for drawing while the called numbers
// are preserved), the line declared AGAIN through the normal external-validation flow (a corrected
// history is re-declarable), and the post-re-declaration state: drawing STAYS OPEN, because a line award
// does not end the game (src/game-phase.ts assertDrawAllowed allows 'drawing' and 'line_declared'), the
// next draw commits once its celebration has completed, a preserved call still refuses as a duplicate,
// and the correction control is offered once more (a corrected line is re-correctable). The
// operator's reason is stored in the audit with the original award snapshot; the correction never touches
// the called numbers. Launch ownership, timeout cancellation and guarded cleanup are owned by the shared
// lifecycle core in bingo-smoke-lifecycle.mjs. Every launch uses the existing temporary-profile guard
// from electron-smoke.mjs (`--user-data-dir` directly inside the OS temp dir, never overlapping the real
// profile); the temporary profile is only ever deleted through the same guarded path. On failure a log
// of the main process and page consoles is written to $SMOKE_ARTIFACTS_DIR (default
// verification/artifacts/line-correction-smoke). This file never runs on import or in CI: it launches
// real windows and needs explicit permission.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchArgs, profilePrefix } from './electron-smoke.mjs';
import { runIsolated } from './bingo-smoke-lifecycle.mjs';
import { removeTemporaryProfile } from './bingo-award-smoke.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const stepTimeout = 15_000;
const totalTimeout = 240_000;
const DRAWN = [42, 7, 13];
const EXTRA_DRAWN = 50; // drawn AFTER the re-declared line: a line award does not end the game
const ALREADY_CALLED = 13; // a preserved call: drawing it again must refuse as a duplicate
const PRIZES = { line: { amount: 150, lot: 'Jamón ibérico' }, bingo: { amount: 1500, lot: 'Cesta navideña' } };
const REASON = 'Line claimed on the wrong card before the physical check finished';

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
  const artifacts = path.resolve(process.env.SMOKE_ARTIFACTS_DIR ?? path.join(root, 'verification', 'artifacts',
    'line-correction-smoke'));
  const note = (source, text) => log.push(`[${new Date().toISOString()}] ${source}: ${String(text).trimEnd()}`);
  try {
    await runIsolated({
      timeoutMs: totalTimeout,
      allocateProfile: () => realpathSync(mkdtempSync(path.join(tmpdir(), `${profilePrefix}line-correction-`))),
      launch: async (profile) => {
        const { _electron: electron } = await import('playwright');
        return electron.launch({ executablePath: require('electron'), args: launchArgs(profile), timeout: 30_000 });
      },
      verify: async (app, profile) => {
        app.process().stdout?.on('data', (data) => note('line-correction main stdout', data));
        app.process().stderr?.on('data', (data) => note('line-correction main stderr', data));
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
        // The celebration overlay lives in the public document (src/public.html), never in the operator page.
        await publicWindow.waitForFunction((expected) => {
          const celebration = document.querySelector('#line-celebration');
          return celebration.active === true && celebration.kind === expected;
        }, kind, { timeout: 30_000 });
        await publicWindow.waitForFunction(() => document.querySelector('#line-celebration').active === false,
          null, { timeout: 30_000 });
      };

      await step('app starts on an isolated temporary profile', async () => {
        await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
        assert.ok(existsSync(path.join(profile, 'current-event.sqlite')), 'the database lives in the temporary profile');
      });

      await step('prizes are configured through the settings form and saved', async () => {
        // The settings panel starts hidden behind the Eventos tab, so it must be activated before typing.
        await operator.click('#tab-settings');
        await operator.locator('#settings-line-amount input').waitFor({ state: 'visible' });
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
          await operator.waitForFunction((n) => document.querySelector('#called-numbers').calledNumbers.includes(n),
            number, { timeout: stepTimeout });
        }
        assert.equal(await operator.locator('#event-summary').evaluate((summary) => summary.count), DRAWN.length,
          'the event summary counts the drawn balls');
      });

      await step('the line is declared through its dialog and celebrated once', async () => {
        await operator.locator('#claim-line').click();
        await operator.locator('#line-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#line-winners input'), '1', 'the line dialog starts at one winner');
        await operator.locator('#line-dialog [data-action="confirm"] button').click();
        await celebrate('line');
      });

      await step('the committed line is corrected through the reason dialog and the rail reverts', async () => {
        // No celebration may fire for a correction: the overlay stays inactive the whole step.
        const celebrationActive = () => publicWindow.evaluate(() => document.querySelector('#line-celebration').active);
        await operator.waitForFunction(() => {
          const control = document.querySelector('#line-correct');
          return control && control.hidden === false && control.disabled === false;
        }, null, { timeout: stepTimeout });
        await operator.locator('#line-correct').click();
        await operator.locator('#line-correction-dialog dialog').waitFor({ state: 'visible' });
        await operator.fill('#line-correction-reason input', '  padded reason  ');
        await operator.locator('#line-correction-dialog [data-action="confirm"] button').isDisabled()
          .then((disabled) => assert.equal(disabled, true, 'an untrimmed reason refuses the confirm'));
        await operator.fill('#line-correction-reason input', REASON);
        await operator.locator('#line-correction-dialog [data-action="confirm"] button').click();
        // The rail reverts: the control hides, the claim re-opens for the normal external-validation flow.
        await operator.waitForFunction(() => document.querySelector('#line-correct').hidden === true);
        await operator.waitForFunction(() => !document.querySelector('#claim-line').disabled);
        // The public window learns the award is gone without any celebration.
        await publicWindow.waitForFunction(() => document.querySelector('#line-award').hidden);
        assert.equal(await celebrationActive(), false, 'a correction never replays or fires a celebration');
        // The board re-opens for drawing: the corrected line is back to the drawing state.
        await operator.waitForFunction(() => document.querySelector('#draw-controls').manualDisabled === false);
        assert.deepEqual(await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]),
          DRAWN, 'the called numbers are preserved');
      });

      await step('the line is declared again through the normal external-validation flow', async () => {
        await operator.locator('#claim-line').click();
        await operator.locator('#line-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#line-winners input'), '1', 'the dialog starts at the default winner count');
        await operator.locator('#line-dialog [data-action="confirm"] button').click();
        await celebrate('line');
        assert.equal(await publicWindow.locator('#line-award').evaluate((award) => !award.hidden && award.textContent.includes('ganador')),
          true, 'the re-declared line reaches the public page');
      });

      await step('drawing stays open after the re-declared line and the correction control is offered once more', async () => {
        // A LINE award does not end the game: assertDrawAllowed (src/game-phase.ts:41-45) accepts 'drawing' AND
        // 'line_declared', so the board stays open and the next draw must commit. It is the BINGO that locks it
        // ('bingo_declared' is not in that set) — which is why the #33 harness asserts a lock there and this one
        // must assert the opposite. The draw is driven through the board exactly like the earlier drawing step:
        // the operator paints its rail from its OWN controller render (src/operator-ui.mjs:494-495) and
        // onPublicStatus carries only the pause hint, so a raw desktop.drawManual() call would commit in the
        // store while leaving the rail stale — that is not the operator's path and must not be the smoke's.
        await operator.waitForFunction(() => document.querySelector('#draw-controls').manualDisabled === false);
        await operator.locator(`#operator-board [data-number="${EXTRA_DRAWN}"]`).click();
        await operator.waitForFunction((n) => document.querySelector('#called-numbers').calledNumbers.includes(n),
          EXTRA_DRAWN, { timeout: stepTimeout });
        assert.deepEqual(await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]),
          [...DRAWN, EXTRA_DRAWN], 'the correction preserved the earlier calls and the new draw appends to them');
        // The preserved history stays authoritative in the store as well as on screen: a number already called
        // before the correction still refuses as a duplicate (src/event-ipc.ts:77).
        const duplicate = await operator.evaluate((n) => window.desktop.drawManual(n), ALREADY_CALLED);
        assert.equal(duplicate.ok, false, 'a preserved call cannot be drawn twice after the correction');
        assert.equal(duplicate.code, 'duplicate', 'the preserved called numbers stay authoritative after the correction');
        // A corrected line is re-declarable AND re-correctable: the control comes back with the new award.
        await operator.waitForFunction(() => {
          const control = document.querySelector('#line-correct');
          return control !== null && control.hidden === false;
        }, null, { timeout: stepTimeout });
        assert.equal(await operator.locator('#line-correct').isHidden().then((hidden) => !hidden), true,
          'a corrected line is re-correctable: the control is offered again');
      });
    });
    console.log('Line correction smoke passed');
  } catch (error) {
    try {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(path.join(artifacts, 'line-correction-smoke.log'), `${log.join('\n')}\n`);
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
