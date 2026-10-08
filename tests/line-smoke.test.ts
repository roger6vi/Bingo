// @ts-nocheck -- fake launch/app/fs dependencies; no Electron is ever launched here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as smoke from '../verification/line-smoke.mjs';

const temp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'line-smoke-test-')));
const withTemp = async (run) => { const dir = temp(); try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
// No ambient tmpdir scan: main() has no injected deps, so prove refusal precedes artifact/profile creation by source order in main().
const assertRefusesBefore = (guard) => {
  const source = readFileSync(path.join(import.meta.dirname, '../verification/line-smoke.mjs'), 'utf8');
  const main = source.slice(source.indexOf('export async function main('));
  const at = main.indexOf(guard);
  assert.ok(at >= 0, guard);
  for (const creation of ['mkdtempSync(', 'createContext(', 'runScenario(']) assert.ok(at < main.indexOf(creation), `${guard} precedes ${creation}`);
};
// A fake Playwright app whose child process exits only after `exitAfter` ms, and records the order of events.
const fakeApp = (log, { exitAfter = 5, hangClose = false, neverExit = false, paths = {}, rows = [], name = '', calls = [] } = {}) => {
  const tag = (event) => (name ? `${event}:${name}` : event);
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const finish = () => { if (!neverExit) setTimeout(() => { child.exitCode = 0; log.push(tag('exit')); child.emit('exit', 0); }, exitAfter); };
  child.kill = (signal) => { log.push(tag(`kill:${signal}`)); finish(); return true; };
  return { process: () => child, firstWindow: async () => ({}), on() {}, windows: () => [],
    evaluate: async (_fn, arg) => { calls.push(arg); return arg === undefined ? paths : rows; },
    close: async () => { log.push(tag('close')); if (hangClose) return new Promise(() => {}); finish(); } };
};

test('importing the harness exposes helpers, never builds, installs or launches', () => {
  assert.equal(typeof smoke.main, 'function');
  const source = readFileSync(path.join(import.meta.dirname, '../verification/line-smoke.mjs'), 'utf8');
  assert.doesNotMatch(source, /child_process|spawnSync|npm(\.cmd)?['"]|electron-smoke|defaultUserData|homedir/);
});

test('unknown or empty scenario selectors fail before any profile, artifact or launch', async () => {
  const names = smoke.SCENARIOS.map(([name]) => name);
  assert.equal(smoke.selectScenarios(undefined).length, names.length);
  assert.deepEqual(smoke.selectScenarios('5').map(([name]) => name), names.filter((name) => name.startsWith('5')));
  for (const bad of ['nope', '']) assert.throws(() => smoke.selectScenarios(bad), /unknown scenario/);
  await assert.rejects(smoke.main({ only: 'nope' }), /unknown scenario/);
  assertRefusesBefore('selectScenarios(only');
});

test('the body-facing context cannot launch, restart or read after cancellation, holds no owner capability, and a late launch is cleaned up', () => withTemp(async (dir) => {
  const log = [];
  const launches = [];
  const electron = { launch: ({ args }) => {
    launches.push(args);
    const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    return new Promise((resolve) => setTimeout(() => resolve(fakeApp(log, { paths: { userData: profile, appPath: '/feature' } })), 40));
  } };
  const made = smoke.createContext({ project: { root: '/feature' }, electron, executablePath: 'x', artifacts: dir, name: 't', say: () => {} });
  assert.ok(made.ctx && made.owner && made.scope, 'context, owner capability and scope are separate');
  for (const privileged of ['fixture', 'diagnostics', 'screenshots', 'dispose', 'cancel']) assert.ok(!(privileged in made.ctx), privileged);
  const profile = made.owner.fixture.path;
  const inFlight = made.ctx.launch('late');
  made.scope.cancel('timed out');
  await assert.rejects(made.ctx.launch('again'), /cancelled/);
  await assert.rejects(made.ctx.award(), /cancelled/);
  await assert.rejects(made.ctx.restart({ app: {} }, 'restart'), /cancelled/);
  await assert.rejects(inFlight, /cancelled/);
  assert.equal(launches.length, 1, 'no launch was started after cancellation');
  await made.owner.dispose();
  assert.deepEqual(log, ['close', 'exit'], 'the late app was closed and exited');
  assert.ok(!existsSync(profile), 'profile deleted only after the exit');
  await assert.rejects(made.ctx.launch('after cleanup'), /cancelled/);
  assert.equal(launches.length, 1);
}));

test('ctx.shoot re-checks authority around every capture: a revoked scope never dispatches another screenshot and cancellation is never swallowed', () => withTemp(async (dir) => {
  const setup = (shot) => {
    const made = smoke.createContext({ project: { root: '/feature' }, electron: {}, executablePath: 'x', artifacts: dir, name: 't', say: () => {} });
    const app = { windows: () => [{ screenshot: shot }, { screenshot: shot }] };
    made.owner.fixture.track(app);
    return made;
  };
  // Revoked while the first capture is pending: it resolves late, the second window is never captured.
  const calls = [];
  let release;
  const first = setup((options) => { calls.push(options.path); return new Promise((resolve) => { release = resolve; }); });
  const shooting = first.ctx.shoot('a');
  assert.equal(calls.length, 1);
  first.scope.cancel('timed out');
  release();
  await assert.rejects(shooting, /cancelled/);
  assert.equal(calls.length, 1, 'no second capture after revocation');
  // A capture that rejects because of the revocation still surfaces the cancellation, not the screenshot error.
  const failing = [];
  let fail;
  const second = setup((options) => { failing.push(options.path); return new Promise((_resolve, reject) => { fail = reject; }); });
  const pending = second.ctx.shoot('b');
  second.scope.cancel('timed out');
  fail(new Error('page closed'));
  await assert.rejects(pending, /scenario cancelled: timed out/);
  assert.equal(failing.length, 1);
  // Revoked before the call: nothing is dispatched.
  await assert.rejects(second.ctx.shoot('c'), /cancelled/);
  assert.equal(failing.length, 1);
  // An ordinary screenshot failure under live authority stays best-effort and the next window is still captured.
  const ordinary = [];
  const third = setup((options) => { ordinary.push(options.path); return ordinary.length === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(); });
  await third.ctx.shoot('d');
  assert.equal(ordinary.length, 2);
  // The owner's post-revocation screenshots are a separate capability and still run.
  const owned = [];
  const fourth = setup((options) => { owned.push(options.path); return Promise.resolve(); });
  fourth.scope.cancel('timed out');
  await fourth.owner.screenshots();
  assert.equal(owned.length, 2);
}));

test('packaged mode reads the foreign-window preload from inside the package; default mode keeps dist', () => {
  const packaged = { executable: '/r/Bingo', appPath: '/r/Resources/app.asar' };
  assert.equal(smoke.preloadFor({ root: '/feature', packaged }), path.join(packaged.appPath, 'dist', 'public-preload.js'));
  assert.equal(smoke.preloadFor({ root: '/feature' }), path.join('/feature', 'dist', 'public-preload.js'));
});

test('an unusable packaged executable fails in setup before any launch', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  await assert.rejects(smoke.main({ root, only: '1-', packaged: '/nonexistent/Bingo' }), /does not exist/);
  await assert.rejects(smoke.main({ root, only: '1-', packaged: 'relative/Bingo' }), /absolute/);
  assertRefusesBefore('resolvePackaged(');
  assert.equal(smoke.packagedFromEnv({}), undefined);
  assert.equal(smoke.packagedFromEnv({ BINGO_SMOKE_PACKAGED: '/x/Bingo' }), '/x/Bingo');
});

test('rec02b-legacy-recovery is registered, selectable by prefix, and an unknown rec02b selector fails before any profile', async () => {
  const names = smoke.SCENARIOS.map(([name]) => name);
  assert.equal(names.filter((name) => name === 'rec02b-legacy-recovery').length, 1);
  assert.deepEqual(smoke.selectScenarios('rec02b-legacy-recovery').map(([name]) => name), ['rec02b-legacy-recovery']);
  assert.deepEqual(smoke.selectScenarios('rec02b').map(([name]) => name), ['rec02b-legacy-recovery']);
  assert.ok(!smoke.selectScenarios('1').some(([name]) => name.startsWith('rec02b')), 'existing selectors are unchanged');
  await assert.rejects(smoke.main({ only: 'rec02b-nope' }), /unknown scenario/);
  assertRefusesBefore('selectScenarios(only');
});

test('packaged selection excludes legacy recovery and rejects explicit recovery selectors', async () => {
  const names = smoke.SCENARIOS.map(([name]) => name);
  assert.deepEqual(smoke.selectScenarios(undefined, smoke.SCENARIOS, { packaged: true }).map(([n]) => n), names.filter((n) => n !== 'rec02b-legacy-recovery'));
  assert.ok(smoke.selectScenarios(undefined).map(([n]) => n).includes('rec02b-legacy-recovery'), 'ordinary default keeps recovery');
  assert.ok(smoke.selectScenarios(undefined, smoke.SCENARIOS, { packaged: false }).map(([n]) => n).includes('rec02b-legacy-recovery'));
  for (const selector of ['rec02b', 'rec02b-legacy-recovery']) assert.throws(() => smoke.selectScenarios(selector, smoke.SCENARIOS, { packaged: true }), /unsupported.*packaged/i);
  assert.deepEqual(smoke.selectScenarios('1', smoke.SCENARIOS, { packaged: true }).map(([n]) => n), names.filter((n) => n.startsWith('1')));
  assert.throws(() => smoke.selectScenarios('nope', smoke.SCENARIOS, { packaged: true }), /unknown scenario/);
  // main() derives packaged mode and passes it to selection, before any profile/artifact/launch.
  const source = readFileSync(path.join(import.meta.dirname, '../verification/line-smoke.mjs'), 'utf8');
  assert.match(source.slice(source.indexOf('export async function main(')), /selectScenarios\(only, SCENARIOS, \{ packaged: packaged !== undefined \}\)/);
  assertRefusesBefore('selectScenarios(only, SCENARIOS');
});

test('the recovery context methods are guarded by the scope, expose no raw seed or SQL capability, and refuse before any launch', () => withTemp(async (dir) => {
  const made = smoke.createContext({ project: { root: '/feature' }, electron: { launch: () => { throw new Error('must not launch'); } }, executablePath: 'x',
    artifacts: dir, name: 't', say: () => {} });
  for (const method of ['closeApps', 'seedLegacyLine', 'readRecovery']) assert.equal(typeof made.ctx[method], 'function', method);
  for (const raw of ['seedLegacyLineCheck', 'readFixture', 'sql', 'query', 'write']) assert.ok(!(raw in made.ctx), raw);
  // Unbootstrapped: nothing may seed, and the reader refuses a profile that has no verified runtime.
  await assert.rejects(made.ctx.seedLegacyLine(), /no bootstrap/);
  await assert.rejects(made.ctx.readRecovery(), /not verified/);
  made.scope.cancel('timed out');
  for (const method of ['closeApps', 'seedLegacyLine', 'readRecovery']) await assert.rejects(made.ctx[method](), /cancelled/, method);
  await made.owner.dispose();
}));

test('readRecovery reads the fixed committed facts read-only through the verified runtime', () => withTemp(async (dir) => {
  const statements = [];
  const rows = [[{ name: 'N', date: '2026-01-15', place: 'P', history: '[7,42]', phase: 'checking_line', lastTransitionAt: 't' }],
    [{ sequence: 1, transitionAt: 't', kind: 'begin_line_check', fromPhase: 'drawing', toPhase: 'checking_line' }],
    [{ lineAmount: 25, lineLot: 'Cesta', bingoAmount: 100, bingoLot: 'Jamón' }], []];
  const log = [];
  let profile;
  const electron = { launch: async ({ args }) => {
    profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const app = fakeApp(log, { paths: { userData: profile, appPath: '/feature' } });
    app.evaluate = async (fn, arg) => { if (arg === undefined) return { userData: profile, appPath: '/feature' }; statements.push(...arg.statements); return rows; };
    app.firstWindow = async () => ({ waitForFunction: async () => {}, on() {}, setDefaultTimeout() {} });
    return app;
  } };
  const made = smoke.createContext({ project: { root: '/feature' }, electron, executablePath: 'x', artifacts: dir, name: 't', say: () => {} });
  await made.ctx.launch('run');
  const facts = await made.ctx.readRecovery();
  assert.deepEqual(facts, { name: 'N', date: '2026-01-15', place: 'P', calledNumbers: [7, 42], phase: 'checking_line', lastTransitionAt: 't',
    audit: [{ sequence: 1, transitionAt: 't', kind: 'begin_line_check', fromPhase: 'drawing', toPhase: 'checking_line' }],
    prizes: { line: { amount: 25, lot: 'Cesta' }, bingo: { amount: 100, lot: 'Jamón' } }, awards: [] });
  assert.equal(statements.length, 4);
  assert.ok(statements.every((sql) => /^SELECT /.test(sql) && !sql.includes(';')), 'only fixed SELECT statements');
  await made.owner.dispose();
}));
