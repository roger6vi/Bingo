// @ts-nocheck -- fake launch/app/fs dependencies; no Electron is ever launched here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as smoke from '../verification/line-smoke.mjs';

const temp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'line-smoke-test-')));
const withTemp = async (run) => { const dir = temp(); try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
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
  const count = () => readdirSync(tmpdir()).filter((name) => name.startsWith('bingo-fl09-artifacts-') || name.startsWith('bingo-smoke-')).length;
  const before = count();
  await assert.rejects(smoke.main({ only: 'nope' }), /unknown scenario/);
  assert.equal(count(), before);
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
  const count = () => readdirSync(tmpdir()).filter((name) => name.startsWith('bingo-fl09-artifacts-') || name.startsWith('bingo-smoke-')).length;
  const before = count();
  const root = path.resolve(import.meta.dirname, '..');
  await assert.rejects(smoke.main({ root, only: '1-', packaged: '/nonexistent/Bingo' }), /does not exist/);
  await assert.rejects(smoke.main({ root, only: '1-', packaged: 'relative/Bingo' }), /absolute/);
  assert.equal(count(), before, 'refused before any profile or artifact exists');
  assert.equal(smoke.packagedFromEnv({}), undefined);
  assert.equal(smoke.packagedFromEnv({ BINGO_SMOKE_PACKAGED: '/x/Bingo' }), '/x/Bingo');
});
