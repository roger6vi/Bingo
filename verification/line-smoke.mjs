// FL09 first-line smoke: `node verification/line-smoke.mjs` after the explicit prerequisite `npm run build`.
// Import-safe: nothing runs unless this file is the entry. It never builds or installs, only launches the built app
// of its own worktree on harness-created bingo-smoke-* profiles, and never touches any other user profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, createScope, guarded, launchVerified, resolvePackaged, resolveProject, runScenario } from './line-smoke-lifecycle.mjs';
import { readAwards, readFixture } from './line-smoke-reader.mjs';

const PRESENTATION_MS = 4000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- live scenarios -------------------------------------------------------------------------------------------

export function createContext({ project, electron, executablePath, artifacts, name, say }) {
  const fixture = createFixture();
  const note = (text) => say(`${name}: ${text}`);
  const watched = new WeakSet();
  const watch = (label) => (page) => {
    if (watched.has(page)) return;
    watched.add(page);
    page.setDefaultTimeout(15_000);
    page.on('console', (message) => note(`${label} console.${message.type()} ${message.text()}`));
    page.on('pageerror', (error) => note(`${label} pageerror ${error.message}`));
  };
  const scope = createScope();
  const raws = new WeakMap();
  const ctx = {
    note,
    // Cancellable pause: the next action after it re-checks authority.
    async pause(ms) { scope.check(); await sleep(ms); scope.check(); },
    // A restart keeps the retained fixture; the raw app is looked up privately from the guarded session.
    async restart(session, label, options) {
      scope.check();
      return fixture.restart(raws.get(session.app), () => ctx.launch(label), options);
    },
    async launch(label) {
      scope.check();
      const watcher = watch(label);
      // Streams are attached by launchVerified right after launch, before the runtime profile is verified.
      const onLaunch = (app) => {
        for (const stream of ['stdout', 'stderr']) app.process()[stream]?.on('data', (data) => note(`${label} main ${stream} ${String(data).trim()}`));
        app.on('window', watcher);
      };
      const session = await launchVerified({ electron, executablePath, project, fixture, onLaunch });
      scope.check(); // a launch that resolved after cancellation stays tracked by the fixture and is terminated by disposal
      session.app.windows().forEach(watcher);
      note(`${label} launched on ${fixture.path}`);
      await session.operator.waitForFunction(() => document.querySelector('#settings-name')?.value !== '');
      scope.check();
      const app = guarded(scope, session.app, 'app');
      raws.set(app, session.app);
      return { app, operator: guarded(scope, session.operator, 'page') };
    },
    // SQL errors are never swallowed into "no award yet".
    async award() { scope.check(); const rows = await readAwards(fixture); scope.check(); return rows[0] ?? null; },
    async waitAward(label, test, timeout = 15_000) {
      const limit = Date.now() + timeout;
      for (;;) {
        const award = await ctx.award();
        if (award !== null && test(award)) { const at = Date.now(); note(`${label}: ${JSON.stringify(award)} seen@${at}`); return { ...award, at }; }
        if (Date.now() > limit) throw new Error(`timed out waiting for ${label}; last ${JSON.stringify(award)}`);
        await ctx.pause(40);
      }
    },
    async seed(operator, lot) {
      const failed = await operator.evaluate(async (value) => {
        const { eventId } = await window.desktop.getPrizes();
        return (await window.desktop.updatePrizes(eventId, { line: { amount: 100, lot: value }, bingo: { amount: 0, lot: '' } })).code ?? null;
      }, lot);
      assert.equal(failed, null, 'prizes are saved through the desktop API');
      await operator.click('#tab-bingo');
      await operator.locator('#operator-board [data-number="7"]').click();
      await operator.waitForFunction(() => document.querySelector('#event-summary').count === 1 && !document.querySelector('#claim-line').disabled);
    },
    async openPublic(app, operator) {
      await operator.click('#tab-bingo');
      const [page] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
      await page.waitForFunction(() => document.querySelector('#event-name')?.textContent === 'Evento actual' && document.querySelector('#called-count')?.value === '1');
      return page;
    },
    // Holds the page's render promise, hence the start receipt, for `ms`; the real receipt channel is still used.
    delayReceipt: (page, ms) => page.evaluate((delay) => Object.defineProperty(document.querySelector('#line-celebration'), 'updateComplete',
      { configurable: true, get: () => new Promise((resolve) => setTimeout(resolve, delay)) }), ms),
    async declare(operator, winners) {
      await operator.click('#tab-bingo');
      await operator.locator('#claim-line button').click();
      await operator.locator('#line-dialog dialog').waitFor({ state: 'visible' });
      await operator.fill('#line-winners input', String(winners));
      await operator.locator('#line-dialog [data-action="confirm"] button').click();
    },
    celebration: (page) => page.evaluate(() => { const el = document.querySelector('#line-celebration');
      return { active: el.active, text: el.shadowRoot.textContent.includes('¡Línea!'), award: document.querySelector('#line-award').textContent }; }),
    drawCode: (operator) => operator.evaluate(() => window.desktop.drawDigital().then((result) => result.code ?? 'ok')),
    async drawFromUi(operator) {
      await operator.click('#tab-bingo');
      await operator.locator('#draw-controls label', { hasText: 'Digital' }).click();
      const before = await operator.locator('#event-summary').evaluate((summary) => summary.count);
      await operator.locator('#draw-digital button').click();
      await operator.waitForFunction((count) => document.querySelector('#event-summary').count === count + 1, before);
    },
    // Started -> blocked draws -> completed. Every sample taken before the deadline must still read the unchanged
    // started row; the first completed sample must not precede the deadline. Sampling is ~40 ms plus read latency, so
    // a commit between two samples is bounded by the logged maximum gap, not excluded absolutely.
    async runToCompletion(operator, started) {
      assert.equal(started.deadline, started.startedAt + PRESENTATION_MS, 'persisted deadline is startedAt + 4000');
      assert.equal(await ctx.drawCode(operator), 'line_presentation_active', 'draws are blocked while presenting');
      assert.equal(await operator.locator('#operator-board').evaluate((board) => board.disabled), true);
      const { at: _at, ...frozen } = started;
      let samples = 0;
      let maxGap = 0;
      let previous = Date.now();
      for (const limit = started.deadline + 15_000; ; await sleep(40)) {
        const award = await ctx.award();
        const at = Date.now();
        maxGap = Math.max(maxGap, at - previous);
        previous = at;
        if (award?.status === 'started') {
          assert.deepEqual(award, frozen, 'the started row stays untouched');
          samples++;
        } else {
          assert.equal(award?.status, 'completed', `unexpected state ${JSON.stringify(award)}`);
          assert.ok(at >= started.deadline, `completion observed ${started.deadline - at} ms before the deadline`);
          assert.deepEqual([award.id, award.startedAt, award.deadline], [started.id, started.startedAt, started.deadline]);
          note(`completed seen ${at - started.deadline} ms after the deadline (${at - started.startedAt} ms after start); ${samples} started samples, max gap ${maxGap} ms`);
          return { ...award, at };
        }
        if (at > limit) throw new Error(`still started ${at - started.deadline} ms past the deadline: ${JSON.stringify(award)}`);
      }
    },
  };
  // Owner capability: never reachable from the body-facing ctx. Diagnostics and screenshots only read; dispose ends it all.
  const owner = { fixture,
    // Failure evidence gathered before disposal: line UI, owned journal mode, SQLite/runtime versions, committed rows.
    async diagnostics(error) {
      const guard = (promise) => Promise.race([promise, sleep(5000).then(() => 'timed out')]).catch((cause) => `failed: ${cause.message}`);
      const report = { error: error.stack ?? String(error), at: new Date().toISOString() };
      report.awards = await guard(readAwards(fixture));
      report.database = await guard(readFixture(fixture, ['PRAGMA journal_mode', 'PRAGMA user_version', 'SELECT sqlite_version() AS sqlite']));
      report.windows = [];
      for (const app of fixture.apps) {
        report.versions = await guard(app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite })));
        for (const page of app.windows()) {
          report.windows.push(await guard(page.evaluate(() => ({ url: location.href, lineStatus: document.querySelector('#line-status')?.message ?? null,
            retryHidden: document.querySelector('#line-retry')?.hidden ?? null, repeatHidden: document.querySelector('#line-repeat')?.hidden ?? null,
            claim: document.querySelector('#claim-line')?.textContent ?? null, celebration: document.querySelector('#line-celebration')?.active ?? null }))));
        }
      }
      writeFileSync(path.join(artifacts, `${name}-diagnostics.json`), JSON.stringify(report, null, 2));
    },
    async screenshots() {
      let index = 0;
      for (const app of fixture.apps) for (const page of app.windows()) {
        await page.screenshot({ path: path.join(artifacts, `${name}-${++index}.png`), timeout: 5000 }).catch(() => {});
      }
    },
    dispose: () => fixture.dispose(),
  };
  return { ctx, owner, scope };
}

// 1/1b. Declare through the UI; the receipt, durable started, blocked draws, completion, then drawing resumes.
const lifecycle = (winners, lot) => async (ctx) => {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, lot);
  const page = await ctx.openPublic(app, operator);
  assert.equal(await ctx.award(), null);
  await ctx.declare(operator, winners);
  const started = await ctx.waitAward('started', (award) => award.status === 'started');
  const shown = await ctx.celebration(page);
  assert.deepEqual([shown.active, shown.text], [true, true], 'the public overlay rendered the celebration');
  const done = await ctx.runToCompletion(operator, started);
  if (winners > 1) {
    assert.deepEqual([done.winners, done.totalCents, done.shareCents, done.remainderCents, done.lot, done.lotResolution],
      [winners, 10_000, 3333, 1, lot, 'pending'], 'frozen share, remainder and pending lot survive completion');
    assert.match(await operator.locator('#line-status').evaluate((status) => status.message), /sigue pendiente/);
  }
  await ctx.drawFromUi(operator);
};

// 2. Without a public window the award commits as failed; opening it sends static state only; retry rotates the id.
async function noPublic(ctx) {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, '');
  await ctx.declare(operator, 1);
  const failed = await ctx.waitAward('failed', (award) => award.status === 'failed');
  assert.equal(failed.startedAt, null);
  await operator.waitForFunction(() => !document.querySelector('#line-retry').hidden);
  const page = await ctx.openPublic(app, operator);
  await ctx.pause(2600);
  const shown = await ctx.celebration(page);
  assert.deepEqual([shown.active, shown.text], [false, false], 'static award only, no celebration');
  assert.match(shown.award, /ganador/, 'the static award is shown');
  assert.equal((await ctx.award()).id, failed.id, 'no automatic retry');
  assert.equal((await ctx.award()).status, 'failed');
  await operator.locator('#line-retry button').click();
  const started = await ctx.waitAward('started after explicit retry', (award) => award.status === 'started');
  assert.notEqual(started.id, failed.id, 'retry rotates the presentation id');
  await ctx.runToCompletion(operator, started);
}

// 3 and 4. After the receipt, a public reload or close does not replay or stall: main completes at the deadline.
const afterReceipt = (disturb) => async (ctx) => {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, '');
  const page = await ctx.openPublic(app, operator);
  await ctx.declare(operator, 1);
  const started = await ctx.waitAward('started', (award) => award.status === 'started');
  const awardText = (await ctx.celebration(page)).award;
  await disturb(page, ctx, started, awardText);
  await ctx.runToCompletion(operator, started);
  await ctx.drawFromUi(operator);
};
const reload = async (page, ctx, started, awardText) => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#called-count')?.value === '1' && document.querySelector('#line-award').textContent !== '');
  await ctx.pause(1200);
  assert.deepEqual(await ctx.celebration(page), { active: false, text: false, award: awardText }, 'no replay; the static award persists');
  const { at: _at, ...frozen } = started;
  assert.deepEqual(await ctx.award(), frozen, 'the persisted run is untouched by the reload');
};
const closePublic = (page) => page.close();

// 5. Killing main mid-presentation leaves an interrupted award that only an explicit full repeat leaves.
async function restartInterrupted(ctx) {
  const first = await ctx.launch('first run');
  await ctx.seed(first.operator, '');
  const page = await ctx.openPublic(first.app, first.operator);
  await ctx.declare(first.operator, 1);
  const started = await ctx.waitAward('started', (award) => award.status === 'started');
  assert.equal((await ctx.celebration(page)).active, true);
  const { app, operator } = await ctx.restart(first, 'restart', { force: true });
  const { at: _at, ...original } = started;
  const interrupted = await ctx.waitAward('interrupted', (award) => award.status === 'interrupted');
  assert.deepEqual({ ...interrupted, status: 'started', at: undefined }, { ...original, at: undefined }, 'id and times are preserved');
  await ctx.pause(Math.max(0, started.deadline + 1500 - Date.now()));
  assert.equal((await ctx.award()).status, 'interrupted', 'no automatic completion after the deadline');
  assert.notEqual(await ctx.drawCode(operator), 'ok', 'drawing stays locked');
  await operator.waitForFunction(() => !document.querySelector('#line-repeat').hidden);
  const publicPage = await ctx.openPublic(app, operator);
  assert.equal((await ctx.celebration(publicPage)).active, false, 'opening public never replays');
  await ctx.delayReceipt(publicPage, 1500);
  await operator.locator('#line-repeat button').click();
  const pending = await ctx.waitAward('pending after explicit repeat', (award) => award.status === 'pending');
  assert.notEqual(pending.id, started.id, 'repeat rotates the id');
  assert.deepEqual([pending.startedAt, pending.deadline], [null, null], 'times are cleared');
  await publicPage.evaluate((id) => window.publicLineReceipt.started(id), started.id);
  await ctx.pause(300);
  assert.equal((await ctx.award()).status, 'pending', 'the stale previous id is refused');
  const again = await ctx.waitAward('started again', (award) => award.status === 'started');
  await ctx.runToCompletion(operator, again);
}

// 6. Wrong, foreign, duplicate and late-replayed receipts are refused (the receipt is held to widen the window).
async function receipts(ctx) {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, '');
  const page = await ctx.openPublic(app, operator);
  await ctx.delayReceipt(page, 1500);
  const [foreign] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ BrowserWindow }, file) => {
    new BrowserWindow({ show: false, webPreferences: { preload: file, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      .loadURL('data:text/html,<title>foreign</title>');
  }, ctx.preload)]);
  await foreign.waitForFunction(() => 'publicLineReceipt' in window);
  await ctx.declare(operator, 1);
  const pending = await ctx.waitAward('pending', (award) => award.status === 'pending');
  await page.evaluate(() => window.publicLineReceipt.started('not-the-id'));
  await foreign.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  assert.equal((await ctx.award()).status, 'pending', 'wrong-id and foreign-window receipts are refused');
  const started = await ctx.waitAward('started by the real receipt', (award) => award.status === 'started');
  await page.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  const { at: _at, ...frozen } = started;
  assert.deepEqual(await ctx.award(), frozen, 'a duplicate receipt changes nothing');
  const { at: _done, ...done } = await ctx.runToCompletion(operator, started);
  await page.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  assert.deepEqual(await ctx.award(), done, 'a late receipt after completion changes nothing');
  ctx.note('operator window has no receipt API: operator-frame spoofing is not coverable without product changes');
}

// 7. Navigating the public page before its receipt voids the pending run: no start, the award fails, no retry.
async function navigateBeforeReceipt(ctx) {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, '');
  const page = await ctx.openPublic(app, operator);
  await ctx.delayReceipt(page, 1500);
  await ctx.declare(operator, 1);
  const pending = await ctx.waitAward('pending', (award) => award.status === 'pending');
  await page.reload();
  const failed = await ctx.waitAward('failed after navigation', (award) => award.status === 'failed');
  assert.deepEqual([failed.id, failed.startedAt, failed.deadline], [pending.id, null, null]);
  await ctx.pause(2200);
  assert.equal((await ctx.award()).status, 'failed', 'never started nor retried');
  assert.equal((await ctx.celebration(page)).active, false);
}

export const SCENARIOS = [
  ['1-declare-receipt-complete-draw', lifecycle(1, '')],
  ['1b-multi-winner-pending-lot', lifecycle(3, 'Cesta')],
  ['2-no-public-fail-retry', noPublic],
  ['3-public-reload-after-start', afterReceipt(reload)],
  ['4-public-close-after-start', afterReceipt(closePublic)],
  ['5-restart-interrupted-repeat', restartInterrupted],
  ['6-receipt-refusals', receipts],
  ['7-navigation-before-receipt', navigateBeforeReceipt],
];

// A selector must name at least one scenario; it is checked before any profile, artifact or launch exists.
export function selectScenarios(only, all = SCENARIOS) {
  if (only === undefined) return all;
  const picked = all.filter(([name]) => only !== '' && name.startsWith(only));
  if (picked.length === 0) throw new Error(`unknown scenario selector "${only}"; known: ${all.map(([name]) => name).join(', ')}`);
  return picked;
}

// Build provenance without spawning anything: git HEAD read from the worktree's git files plus hashes of the built
// outputs. mtimes are not provenance; the hashes tie a log to the exact bytes launched.
function provenance(project) {
  let head = 'unresolved';
  try {
    let gitdir = path.join(project.root, '.git');
    if (statSync(gitdir).isFile()) gitdir = path.resolve(project.root, readFileSync(gitdir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const ref = readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    if (!ref.startsWith('ref:')) head = ref;
    else {
      const name = ref.slice(4).trim();
      const common = existsSync(path.join(gitdir, 'commondir')) ? path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()) : gitdir;
      head = [gitdir, common].map((dir) => path.join(dir, name)).filter(existsSync).map((file) => readFileSync(file, 'utf8').trim())[0] ?? `${name} (packed)`;
    }
  } catch { /* reported as unresolved */ }
  return { head, label: 'preflight snapshot at harness start (HEAD + sha256 of the 5 launch outputs only); not proof of how or when dist was built, and other renderer chunks are not hashed',
    expectedBuild: 'npm run build:main && npm run build (explicit prerequisite, never run by this harness)', node: process.version,
    outputs: project.outputs.map((file) => ({ file: path.relative(project.root, file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      mtime: new Date(statSync(file).mtimeMs).toISOString() })) };
}

// Opt-in packaged mode: BINGO_SMOKE_PACKAGED=<absolute path of the packaged executable under release/>.
export const packagedFromEnv = (env = process.env) => env.BINGO_SMOKE_PACKAGED || undefined;
// The foreign-window scenario loads the public preload from inside the package in packaged mode.
export const preloadFor = (project) => path.join(project.packaged ? project.packaged.appPath : project.root, 'dist', 'public-preload.js');

// Packaged project: the same canonical root plus the package; hashes cover the app.asar that is launched.
function packagedProject(base, executable) {
  const resolved = resolveProject(base, { dist: false });
  const packaged = resolvePackaged(resolved.root, executable);
  return { root: resolved.root, packaged, outputs: [packaged.appPath] };
}

export async function main({ root, only = process.argv[2], packaged = packagedFromEnv() } = {}) {
  const selected = selectScenarios(only);
  if (packaged !== undefined) resolvePackaged(root ?? path.resolve(import.meta.dirname, '..'), packaged); // refuse before any profile or artifact exists
  const artifacts = mkdtempSync(path.join(tmpdir(), 'bingo-fl09-artifacts-'));
  const logFile = path.join(artifacts, 'line-smoke.log');
  const say = (text) => { const line = `[${new Date().toISOString()}] ${text}`; appendFileSync(logFile, `${line}\n`); console.log(line); };
  const results = [];
  const save = () => writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  say(`artifacts ${artifacts} (retained); scenarios ${selected.map(([name]) => name).join(', ')}`);
  try {
    const base = root ?? path.resolve(import.meta.dirname, '..');
    const project = packaged === undefined ? resolveProject(root) : packagedProject(base, packaged);
    say(`project ${project.root}; provenance ${JSON.stringify(provenance(project))}`);
    const { _electron: electron } = await import('playwright');
    const executablePath = project.packaged ? project.packaged.executable : createRequire(path.join(project.root, 'package.json'))('electron');
    if (project.packaged) say(`PACKAGED mode: executable ${executablePath}; appPath must be ${project.packaged.appPath}`);
    for (const [name, body] of selected) {
      const { ctx, owner, scope } = createContext({ project, electron, executablePath, artifacts, name, say });
      ctx.preload = preloadFor(project);
      results.push(await runScenario({ name, body, ctx, scope, owner, say }));
      say(`${name}: profile ${owner.fixture.path} removed=${!existsSync(owner.fixture.path)}`);
      save();
    }
  } catch (error) {
    results.push({ name: 'setup', status: 'fail', error: error.message });
    say(`FATAL ${error.stack}`);
    save();
    throw error;
  }
  save();
  return results.every((result) => result.status === 'pass');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()) ? 0 : 1; }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
}
