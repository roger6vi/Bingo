// Real-app visual capture for the UI-C acceptance pass (BG-07): `node verification/bingo-visual.mjs` after
// `npm run build`. It launches real windows on an owned bingo-smoke-* temporary profile, captures full-page
// PNGs into verification/artifacts/ui-visual, and removes the profile only through the guarded
// removeTemporaryProfile. Importing is side-effect free; the command needs explicit runtime permission.
// This tool produces evidence for a human visual decision — it asserts only that each surface it captures
// exists and is reachable, never that a layout is correct.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchArgs, profilePrefix } from './electron-smoke.mjs';
import { runIsolated } from './bingo-smoke-lifecycle.mjs';
import { DB_FILE } from './bingo-restart-ports.mjs';
import { removeTemporaryProfile } from './bingo-award-smoke.mjs';
import { declaredBingoWithLot } from './bingo-restart-fixtures.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.env.VISUAL_ARTIFACTS_DIR ?? path.join(root, 'verification', 'artifacts', 'ui-visual'));

export const CAPTURES = ['operator-events-tab', 'operator-bingo-rail', 'operator-bingo-rail-bottom', 'public-award'];

// The rail scrolls inside bingo-side-rail's shadow DOM, so scrolling has to go through scrollIntoView on a
// real rail element. This only moves the viewport of the live window; it never changes application state.
async function revealRail(operator, selector) {
  await operator.locator(selector).scrollIntoViewIfNeeded();
}

// A capture is written only into the artifacts directory; the page is the live window, never a fixture.
export async function capture(page, name, dir = outDir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`captured ${file}`);
  return file;
}

export async function visualSteps({ app }, { shot = capture } = {}) {
  const operator = await app.firstWindow();
  await operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
  await shot(operator, CAPTURES[0]);
  // Both surfaces under review live in the Bingo panel, which starts hidden behind the Eventos tab.
  await operator.click('#tab-bingo');
  await operator.waitForFunction(() => document.querySelector('#tab-bingo').getAttribute('aria-selected') === 'true');
  assert.ok(await operator.locator('#claim-tiebreak').count() === 1, 'the claims rail keeps its tie-break placeholder');
  await revealRail(operator, '#rail-claims-heading');
  await shot(operator, CAPTURES[1]);
  // The rail is taller than its column, and the lower rail elements are already inside the viewport, so
  // scrollIntoView cannot reach them: a wheel event over the rail is what actually scrolls it.
  await operator.locator('#claim-tiebreak').hover();
  await operator.mouse.wheel(0, 1200);
  await operator.waitForTimeout(200);
  await shot(operator, CAPTURES[2]);
  const [publicWindow] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await publicWindow.waitForFunction(() => document.querySelector('#bingo-award') !== null);
  await shot(publicWindow, CAPTURES[3]);
}

async function launchElectron(profile) {
  const { _electron: electron } = await import('playwright');
  return electron.launch({ executablePath: require('electron'), args: launchArgs(profile), timeout: 30_000 });
}

async function main() {
  const profile = realpathSync(mkdtempSync(path.join(tmpdir(), `${profilePrefix}visual-`)));
  const seed = declaredBingoWithLot(path.join(profile, DB_FILE));
  seed.store.close();
  await runIsolated({
    timeoutMs: 120_000,
    allocateProfile: () => profile,
    launch: launchElectron,
    closeApp: async (app) => { await app.close().catch(() => app.process().kill('SIGKILL')); },
    removeProfile: (owned) => removeTemporaryProfile(owned),
  }, (context) => visualSteps(context));
  console.log(`visual captures written to ${outDir}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
