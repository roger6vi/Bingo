// Isolated Bingo restart/recovery smoke (BG-07 S2, #30): `node verification/bingo-restart-smoke.mjs`
// after `npm run build`. Importing never launches Electron; the command needs explicit runtime permission.
// Award scenario: seed before launch, hydrate static facts without celebrating, refuse both draws in BOTH
// legs, and restart the SAME profile without replay/reroll. Durable snapshots are read after app close and
// before guarded profile deletion. Node-testable allocation/seeding/projection ports live in the sibling
// bingo-restart-ports.mjs module; lifecycle ownership and timeout cancellation remain in runIsolated.
// Held scenario: observe the recovery offer at startup WITHOUT reload; cancel only through the real UI
// when offered. A missing offer leaves cancellation unexercised: save an incomplete result and exit nonzero,
// never claim a full pass. This exposes the known H5 gap without changing production recovery behavior.
// Log and result.json are saved for every outcome under SMOKE_ARTIFACTS_DIR (default project-local
// verification/artifacts/bingo-restart-smoke). No real-profile snapshots or application launch occur on
// import or in the headless tests; real runtime/profile-guard metadata access still needs authorization.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_FILE, smokePorts, durableAward } from './bingo-restart-ports.mjs';
export { seedRestartProfile, smokePorts, durableAward } from './bingo-restart-ports.mjs';
import { runIsolated } from './bingo-smoke-lifecycle.mjs';
import { removeTemporaryProfile } from './bingo-award-smoke.mjs';
import { readRawRows } from './bingo-restart-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..');
const stepTimeout = 15_000;
const CALLED = [7, 3];
const UNCALLED = 50;
const SETTLE_MS = 1_500;

const makeStep = (check) => async (name, body) => {
  check(); // between-steps cancellation: a timed-out run starts no new step
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    throw new Error(`Smoke step "${name}" failed: ${error.message}`, { cause: error });
  }
  console.log(`✓ ${name} (${Date.now() - started} ms)`);
};

const watchApp = (app, note, source) => {
  app.process().stdout?.on('data', (data) => note(`${source} main stdout`, data));
  app.process().stderr?.on('data', (data) => note(`${source} main stderr`, data));
  const watch = (page) => {
    page.setDefaultTimeout(stepTimeout);
    page.on('console', (message) => note(`${page.url()} console.${message.type()}`, message.text()));
    page.on('pageerror', (error) => note(`${page.url()} pageerror`, error.stack ?? error.message));
  };
  app.windows().forEach(watch);
  app.on('window', watch);
};

// One launch leg on the seeded profile. `state` carries the seed's pre-launch rows and the award text seen
// by the real public UI. The retry/repeat expectation is read from the LIVE persisted statuses after
// launch, because startup reconciliation may legitimately move a pending presentation to failed.
export const awardLeg = (number, state, note, { exists = existsSync, readRows = readRawRows } = {}) => async ({ app, profile, check }) => {
  const step = makeStep(check);
  let operator;
  let publicWindow;
  await step(`leg ${number}: the app starts on the seeded temporary profile`, async () => {
    watchApp(app, note, `award leg ${number}`);
    operator = await app.firstWindow();
    await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
    assert.ok(exists(path.join(profile, DB_FILE)), 'the database lives in the temporary profile');
  });
  await step(`leg ${number}: the public page hydrates the committed award without celebrating`, async () => {
    // The public controls live in the Bingo panel, which starts hidden behind the Eventos tab.
    await operator.click('#tab-bingo');
    await operator.locator('#open-public button').waitFor({ state: 'visible' });
    [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
    await publicWindow.waitForFunction((called) => document.querySelector('#called-count')?.value === String(called), CALLED.length);
    await publicWindow.waitForFunction(() => {
      const award = document.querySelector('#bingo-award');
      return award !== null && !award.hidden && award.textContent !== '';
    });
    state.awardText = await publicWindow.locator('#bingo-award').textContent();
    assert.equal(await publicWindow.evaluate(() => document.querySelector('#line-celebration').active), false,
      'static hydration never celebrates');
  });
  await step(`leg ${number}: only a failed/interrupted celebration offers retry or repeat`, async () => {
    // Startup reconciliation may legitimately move a pending presentation to failed, so the expectation
    // must come from the live persisted statuses read after launch, never from the pre-launch seed.
    const statuses = readRows(path.join(profile, DB_FILE)).bingo_awards.map((row) => row.presentation_status);
    assert.deepEqual(await operator.evaluate(() => ({
      retry: !document.querySelector('#bingo-retry').hidden,
      repeat: !document.querySelector('#bingo-repeat').hidden,
    })), { retry: statuses.includes('failed'), repeat: statuses.includes('interrupted') },
    'retry/repeat visibility must match exactly the failed/interrupted presentation statuses');
  });
  await step(`leg ${number}: both drawing modes refuse the committed bingo with unchanged calls`, async () => {
    const before = await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]);
    const refusals = await operator.evaluate((n) => Promise.all([window.desktop.drawManual(n), window.desktop.drawDigital()])
      .then((results) => results.map((result) => result.code)), UNCALLED);
    assert.deepEqual(refusals, ['invalid_draw', 'invalid_draw'], 'main refuses both drawing modes after the committed bingo');
    assert.deepEqual(await operator.evaluate(() => [...document.querySelector('#called-numbers').calledNumbers]), before,
      'the called numbers are preserved');
  });
  if (number === 2) {
    await step('the restart shows the same award facts through the real public UI', async () => {
      assert.equal(state.awardText, state.firstAwardText, 'the same award facts are shown after the restart');
    });
  }
  await step(`leg ${number}: the celebration stays inactive for the whole leg`, async () => {
    assert.equal(await publicWindow.evaluate(() => document.querySelector('#line-celebration').active), false,
      'no replay: the restart never replays the celebration');
  });
};

export async function awardScenario(note, {
  run = runIsolated, ports = smokePorts, readRows = readRawRows, remove = removeTemporaryProfile, leg = awardLeg,
} = {}) {
  let restartProfile;
  const state = {};
  try {
    // Leg 1 keeps the profile (removal is deferred to leg 2) so the restart leg can relaunch the SAME profile.
    await run({ ...ports('award', { seedOut: state }), removeProfile: (profile) => { restartProfile = profile; } },
      leg(1, state, note));
    state.firstAwardText = state.awardText;
    const snapshotA = readRows(path.join(restartProfile, DB_FILE));
    assert.deepEqual(durableAward(snapshotA.bingo_awards), durableAward(state.seed.rows.bingo_awards),
      'the first leg wrote no durable award/lot change');
    await run({
      ...ports('award', { seed: null, mkdtemp: () => restartProfile }),
      removeProfile: (profile) => {
        try {
          const snapshotB = readRows(path.join(profile, DB_FILE));
          assert.deepEqual(durableAward(snapshotB.bingo_awards), durableAward(snapshotA.bingo_awards),
            'the restart changed no durable award/lot fact and never rerolled the lot');
        } finally {
          remove(profile);
        }
      },
    }, leg(2, state, note));
  } catch (error) {
    // The first leg defers removal: if the run failed before leg 2, delete the profile through the guarded path.
    if (restartProfile !== undefined) {
      try { remove(restartProfile); } catch { /* leg 2 or its cleanup already removed it */ }
    }
    throw error;
  }
}

// Held checking_bingo: the legacy recovery offer is observed, never assumed. The recorded H5 gap says the
// offer only appears after the first reload («Recargar evento»), so the expected answer is "not visible",
// but this harness records whatever the real UI shows and only cancels — guarded, through the real UI —
// when the offer is actually visible at startup.
async function heldScenario(note, observe = () => {}) {
  let offered;
  await runIsolated(smokePorts('held'), async ({ app, check }) => {
    const step = makeStep(check);
    let operator;
    await step('the app starts on the seeded held-check profile', async () => {
      watchApp(app, note, 'held leg');
      operator = await app.firstWindow();
      await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
    });
    await step('the legacy recovery offer is observed at startup without any reload', async () => {
      await operator.waitForTimeout(SETTLE_MS); // let the startup reads settle; no reload is ever performed
      offered = await operator.evaluate(() => !document.querySelector('#bingo-recover').hidden);
      observe(offered);
      note('held startup offer', offered);
      console.log(`observed data — legacy recovery offer visible at startup (no reload): ${offered}`);
    });
    if (offered) {
      await step('the offered legacy check is cancelled only through the real UI', async () => {
        // The rail lives in the Bingo panel, so activate it before clicking the offered control.
        await operator.click('#tab-bingo');
        await operator.locator('#bingo-recover button').click();
        await operator.locator('#bingo-legacy-dialog dialog').waitFor({ state: 'visible' });
        await operator.locator('#bingo-legacy-dialog [data-action="confirm"] button').click();
        await operator.waitForFunction(() =>
          document.querySelector('#bingo-legacy-dialog')?.shadowRoot?.querySelector('dialog')?.open === false);
      });
    }
  });
  return offered;
}

function saveArtifacts(artifacts, log, result) {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, 'bingo-restart-smoke.log'), `${log.join('\n')}\n`);
  writeFileSync(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

export async function smoke({
  award = awardScenario, held = heldScenario, save = saveArtifacts, report = console.log,
} = {}) {
  const log = [];
  const artifacts = path.resolve(process.env.SMOKE_ARTIFACTS_DIR ?? path.join(root, 'verification', 'artifacts', 'bingo-restart-smoke'));
  const note = (source, text) => log.push(`[${new Date().toISOString()}] ${source}: ${String(text).trimEnd()}`);
  const result = {
    status: 'failed',
    award: 'not_exercised',
    heldCancellation: 'not_exercised',
    startupOfferVisible: null,
  };
  try {
    await award(note);
    result.award = 'passed';
    const offered = await held(note, (visible) => { result.startupOfferVisible = visible; });
    result.startupOfferVisible = offered;
    if (!offered) {
      result.status = 'incomplete';
      throw new Error('Legacy cancellation was not exercised: no recovery offer at startup.');
    }
    result.heldCancellation = 'passed';
    result.status = 'passed';
  } catch (error) {
    result.error = error.message;
    try {
      save(artifacts, log, result);
    } catch (cause) {
      error.artifactFailure = cause;
      console.error(`Could not save smoke artifacts: ${cause.message}`);
    }
    throw error;
  }
  save(artifacts, log, result);
  report('Bingo restart smoke passed');
  return result;
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
