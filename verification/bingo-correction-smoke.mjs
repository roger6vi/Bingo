// Isolated Bingo correction smoke (#33 T5): `node verification/bingo-correction-smoke.mjs` after
// `npm run build`. It drives the real operator UI through the audited correction flow end to end:
// configured prizes, three manual draws, the line declared and celebrated, the Bingo declared and
// celebrated publicly, the committed bingo CORRECTED through the operator's reason dialog (the rail
// reverts to the post-line state and the public window learns the award is gone without any
// celebration), the Bingo declared AGAIN through the normal external-validation flow (a corrected
// history is re-declarable), the refusal of both drawing modes after the re-declared bingo commits,
// a THIRD declaration with two winners (a correction is the only route back, so the shared split is
// exercised for the first time) whose public text states the per-winner share and marks the shared
// lot pending, and finally that lot DRAWN through its own panel until the public page settles the
// winner. The operator's reason is stored in the audit with the original award snapshot; the
// correction never touches the called numbers. Launch ownership, timeout cancellation and guarded
// cleanup are owned by the shared lifecycle core in bingo-smoke-lifecycle.mjs. Every launch uses
// the existing temporary-profile guard from electron-smoke.mjs (`--user-data-dir` directly inside
// the OS temp dir, never overlapping the real profile); the temporary profile is only ever deleted
// through the same guarded path. On failure a log of the main process and page consoles is written
// to $SMOKE_ARTIFACTS_DIR (default verification/artifacts/bingo-correction-smoke). This file never
// runs on import or in CI: it launches real windows and needs explicit permission.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const PRIZES = { line: { amount: 150, lot: 'Jamón ibérico' }, bingo: { amount: 1500, lot: 'Cesta navideña' } };
const REASON = 'Wrong ball reported by the table before the payout';

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
    'bingo-correction-smoke'));
  const note = (source, text) => log.push(`[${new Date().toISOString()}] ${source}: ${String(text).trimEnd()}`);
  try {
    await runIsolated({
      timeoutMs: totalTimeout,
      allocateProfile: () => realpathSync(mkdtempSync(path.join(tmpdir(), `${profilePrefix}correction-`))),
      launch: async (profile) => {
        const { _electron: electron } = await import('playwright');
        return electron.launch({ executablePath: require('electron'), args: launchArgs(profile), timeout: 30_000 });
      },
      verify: async (app, profile) => {
        app.process().stdout?.on('data', (data) => note('correction main stdout', data));
        app.process().stderr?.on('data', (data) => note('correction main stderr', data));
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

      await step('the Bingo claim is enabled after the Line celebration', async () => {
        await operator.waitForFunction(() => !document.querySelector('#claim-bingo').disabled);
      });

      await step('the bingo is declared through the dialog and celebrated publicly', async () => {
        await operator.locator('#claim-bingo').click();
        await operator.locator('#bingo-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#bingo-winners input'), '1', 'the dialog starts at the default winner count');
        await operator.locator('#bingo-dialog [data-action="confirm"] button').click();
        await celebrate('bingo');
        assert.equal(await publicWindow.locator('#bingo-award').evaluate((award) => !award.hidden && award.textContent.includes('ganador')),
          true, 'the committed bingo facts stay static on the public page');
      });

      await step('the committed bingo is corrected through the reason dialog and the rail reverts', async () => {
        // No celebration may fire for a correction: the overlay stays inactive the whole step.
        const celebrationActive = () => publicWindow.evaluate(() => document.querySelector('#line-celebration').active);
        await operator.locator('#bingo-correct').click();
        await operator.locator('#bingo-correction-dialog dialog').waitFor({ state: 'visible' });
        await operator.fill('#bingo-correction-reason input', '  padded reason  ');
        await operator.locator('#bingo-correction-dialog [data-action="confirm"] button').isDisabled()
          .then((disabled) => assert.equal(disabled, true, 'an untrimmed reason refuses the confirm'));
        await operator.fill('#bingo-correction-reason input', REASON);
        await operator.locator('#bingo-correction-dialog [data-action="confirm"] button').click();
        // The rail reverts: the control hides, the claim re-opens for the normal external-validation flow.
        await operator.waitForFunction(() => document.querySelector('#bingo-correct').hidden === true);
        await operator.waitForFunction(() => !document.querySelector('#claim-bingo').disabled);
        // The public window learns the award is gone without any celebration.
        await publicWindow.waitForFunction(() => document.querySelector('#bingo-award').hidden);
        assert.equal(await celebrationActive(), false, 'a correction never replays or fires a celebration');
      });

      await step('the bingo is declared again through the normal external-validation flow', async () => {
        await operator.locator('#claim-bingo').click();
        await operator.locator('#bingo-dialog dialog').waitFor({ state: 'visible' });
        assert.equal(await operator.inputValue('#bingo-winners input'), '1', 'the dialog starts at the default winner count');
        await operator.locator('#bingo-dialog [data-action="confirm"] button').click();
        await celebrate('bingo');
        assert.equal(await publicWindow.locator('#bingo-award').evaluate((award) => !award.hidden && award.textContent.includes('ganador')),
          true, 'the re-declared bingo reaches the public page');
      });

      await step('the board is locked, the calls preserved and both draws refuse', async () => {
        await operator.evaluate(() => document.querySelector('#draw-controls').manualDisabled).then((disabled) =>
          assert.equal(disabled, true, 'manual drawing is locked after the re-declared bingo'));
        const refusals = await operator.evaluate((n) =>
          Promise.all([window.desktop.drawManual(n), window.desktop.drawDigital()])
            .then((results) => results.map((result) => result.code)), 50);
        assert.deepEqual(refusals, ['invalid_draw', 'invalid_draw'], 'main refuses both drawing modes after the re-declared bingo');
        assert.deepEqual(await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]), DRAWN,
          'the called numbers are preserved');
      });

      await step('the bingo is corrected and declared again with two winners so the split text is real', async () => {
        // A correction is the only way back to line_declared, so the two-winner game is a fresh declaration.
        await operator.locator('#bingo-correct').click();
        await operator.locator('#bingo-correction-dialog dialog').waitFor({ state: 'visible' });
        await operator.fill('#bingo-correction-reason input', REASON);
        await operator.locator('#bingo-correction-dialog [data-action="confirm"] button').click();
        await operator.waitForFunction(() => !document.querySelector('#claim-bingo').disabled);
        await operator.locator('#claim-bingo').click();
        await operator.locator('#bingo-dialog dialog').waitFor({ state: 'visible' });
        await operator.fill('#bingo-winners input', '2');
        await operator.locator('#bingo-dialog [data-action="confirm"] button').click();
        await celebrate('bingo');
        // The split is derived from the configured prize, never copied from the Line leg: the bingo pays 1500 EUR
        // and two winners divide it exactly, so the page states the per-winner share and says nothing about a rest.
        const text = await publicWindow.locator('#bingo-award').evaluate((award) => award.textContent);
        assert.ok(text.includes('2 ganadores'), `two winners are named: ${text}`);
        assert.ok(text.includes('750 \u20ac cada uno'), `the per-winner share is stated: ${text}`);
        assert.ok(!text.includes('sin repartir'), `an exact split leaves nothing undistributed: ${text}`);
        assert.ok(text.includes('pendiente de desempate'), `a shared lot still pending is stated as such: ${text}`);
      });

      await step('the bingo lot is drawn through its own panel and the public page settles the winner', async () => {
        // The lot is the only remaining pending fact, so its draw is what the operator does next.
        const panel = operator.locator('#bingo-lot');
        await panel.waitFor({ state: 'visible' });
        await panel.locator('[data-intent="draw"]').click();
        await publicWindow.waitForFunction(() => {
          const award = document.querySelector('#bingo-award');
          return award !== null && award.textContent !== '' && !award.textContent.includes('pendiente de desempate');
        }, null, { timeout: 30_000 });
        const settled = await publicWindow.locator('#bingo-award').evaluate((award) => award.textContent);
        assert.ok(settled.includes('2 ganadores'), `the winners survive the draw: ${settled}`);
        assert.ok(settled.includes('750 \u20ac cada uno'), `the split survives the draw: ${settled}`);
        // The positive fact only a committed numbered draw produces: settlement is not merely the absence of
        // "pending", it names the drawn winner, which is what this step claims to settle.
        assert.ok(settled.includes('Ganador del lote: n\u00ba'), `the drawn winner is named: ${settled}`);
        assert.ok(!settled.includes('pendiente de desempate'), `the lot is settled: ${settled}`);
      });
    });
    console.log('Bingo correction smoke passed');
  } catch (error) {
    try {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(path.join(artifacts, 'bingo-correction-smoke.log'), `${log.join('\n')}\n`);
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
