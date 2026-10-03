// @ts-nocheck -- fake Electron apps, child processes and fs; no Electron or packaged executable is ever launched here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkBrokenDatabase, isEntry, main } from '../verification/packaged-smoke.mjs';

const exe = '/fake/Bingo';
const fakeChild = (log, { exitAfter = 5, neverExit = false, name = 'child' } = {}) => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, pid: 4242 });
  const finish = () => { if (!neverExit) setTimeout(() => { child.exitCode = 0; log.push(`exit:${name}`); child.emit('exit', 0); }, exitAfter); };
  child.kill = (signal) => { log.push(`kill:${signal}:${name}`); finish(); return true; };
  return { child, finish };
};
// A fake Playwright app: userData is what the runtime reports, close() is graceful, exit comes later.
const fakeApp = (log, { userData, hangClose = false, neverExit = false, name = 'app' } = {}) => {
  const { child, finish } = fakeChild(log, { neverExit, name });
  return { userData, child, process: () => child, firstWindow: async () => { log.push(`firstWindow:${name}`); return {}; },
    evaluate: async () => { log.push(`evaluate:${name}`); return userData; },
    close: async () => { log.push(`close:${name}`); if (hangClose) return new Promise(() => {}); finish(); } };
};
const setup = async (run, { launchOptions = () => ({}) } = {}) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-test-')));
  const log = [];
  const launched = [];
  const electron = { launch: async (options) => {
    const profile = options.args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const app = fakeApp(log, { userData: profile, name: `app${launched.length + 1}`, ...launchOptions(launched.length) });
    launched.push({ app, options, profile });
    log.push(`launch:${app.userData === profile ? 'ok' : 'wrong'}`);
    return app;
  } };
  const rm = (target, options) => { log.push(`rm:${path.basename(target).split('-').slice(0, 2).join('-')}`); rmSync(target, options); };
  const spawn = (executable, args) => {
    log.push('spawn:broken');
    return fakeChild(log, { name: 'broken' }).child;
  };
  const deps = { electron, tmp, rm, spawn, exists: () => true, log: () => {}, closeMs: 30, killMs: 30, waitMs: 5, settleMs: 5, platform: 'linux', uid: 1000 };
  try { await run({ deps, log, launched, tmp }); } finally { rmSync(tmp, { recursive: true, force: true }); }
};
const ok = { seed: async () => {}, upgraded: async () => {} };

test('importing the module launches nothing and entry detection is exact', () => {
  assert.equal(typeof main, 'function');
  const file = path.resolve(import.meta.dirname, '..', 'verification', 'packaged-smoke.mjs');
  assert.equal(isEntry(pathToFileURL(file).href, file), true);
  assert.equal(isEntry(pathToFileURL(file).href, '/other/script.mjs'), false);
  assert.equal(isEntry(pathToFileURL(file).href, undefined), false);
});

const names = (dir) => readdirSync(dir);
const supplied = (tmp, name = 'bingo-user-data') => path.join(tmp, name);
const noSeedPhases = { seed: async (ctx) => { await ctx.launch(); }, upgraded: async (ctx) => { await ctx.launch(); } };
const refused = (reason, argvOf, prepare = () => {}) => setup(async ({ deps, log, launched, tmp }) => {
  prepare(tmp);
  await assert.rejects(main({ ...deps, argv: argvOf(tmp), phases: noSeedPhases }), reason);
  assert.deepEqual(launched, []);
  assert.deepEqual(log.filter((entry) => entry !== 'spawn:broken'), []);
});

test('a supplied seed profile that is new is created, used, terminated and never deleted', () => setup(async ({ deps, log, launched, tmp }) => {
  const profile = supplied(tmp);
  const phasesRun = [];
  await main({ ...deps, argv: [exe, profile, 'seed'], phases: { seed: async (ctx) => { phasesRun.push('seed'); assert.equal(ctx.profile, profile); await ctx.launch(); }, upgraded: async () => { phasesRun.push('upgraded'); } } });
  assert.deepEqual(phasesRun, ['seed']);
  assert.ok(existsSync(profile), 'the supplied profile is kept for the workflow cleanup');
  assert.ok(launched[0].options.args.includes(`--user-data-dir=${profile}`));
  assert.ok(log.includes('exit:app1'));
  assert.ok(!log.some((entry) => entry.startsWith('rm:')), log.join(','));
}));

test('a supplied seed profile that is an empty directory is accepted', () => setup(async ({ deps, tmp }) => {
  mkdirSync(supplied(tmp));
  await main({ ...deps, argv: [exe, supplied(tmp), 'seed'], phases: noSeedPhases });
  assert.ok(existsSync(supplied(tmp)));
}));

test('a supplied upgraded profile holding the seed database is accepted, verified, and still never deleted', () => setup(async ({ deps, log, tmp }) => {
  mkdirSync(supplied(tmp));
  writeFileSync(path.join(supplied(tmp), 'current-event.sqlite'), 'seeded');
  const phasesRun = [];
  await main({ ...deps, argv: [exe, supplied(tmp), 'upgraded'], phases: { seed: async () => { phasesRun.push('seed'); }, upgraded: async (ctx) => { phasesRun.push('upgraded'); await ctx.launch(); } } });
  assert.deepEqual(phasesRun, ['upgraded']);
  assert.ok(log.includes('spawn:broken'), 'the broken-database check runs with the upgraded phase');
  assert.deepEqual(names(supplied(tmp)), ['current-event.sqlite']);
  assert.equal(log.filter((entry) => entry === 'rm:bingo-smoke').length, 1, 'only the harness-created broken profile is deleted');
  assert.ok(log.indexOf('exit:app1') >= 0);
}));

test('a supplied profile is refused when relative', () => refused(/must be absolute/, () => [exe, 'bingo-user-data', 'seed']));
test('a supplied profile is refused when its phase is not seed or upgraded', () => refused(/phase must be seed or upgraded/, (tmp) => [exe, supplied(tmp), 'other']));
test('a supplied profile is refused outside the OS temp dir', () => refused(/directly under/, () => [exe, path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-other-'))), 'bingo-x'), 'seed']));
test('a supplied profile is refused when nested below the temp dir', () => refused(/directly under/, (tmp) => [exe, path.join(tmp, 'sub', 'bingo-x'), 'seed']));
test('a supplied profile is refused without the bingo- prefix', () => refused(/start with bingo-/, (tmp) => [exe, supplied(tmp, 'user-data'), 'seed']));
test('a supplied profile is refused when it is a symlink', () => refused(/symlink/, (tmp) => [exe, supplied(tmp, 'bingo-link'), 'seed'],
  (tmp) => { mkdirSync(path.join(tmp, 'real')); symlinkSync(path.join(tmp, 'real'), supplied(tmp, 'bingo-link')); }));
test('a supplied seed profile is refused when it is not empty', () => refused(/seed profile must be new or empty/, (tmp) => [exe, supplied(tmp), 'seed'],
  (tmp) => { mkdirSync(supplied(tmp)); writeFileSync(path.join(supplied(tmp), 'old.txt'), 'x'); }));
test('a supplied upgraded profile is refused without the seed database', () => refused(/upgraded profile must already contain/, (tmp) => [exe, supplied(tmp), 'upgraded'],
  (tmp) => mkdirSync(supplied(tmp))));
test('a supplied upgraded profile that does not exist is refused', () => refused(/upgraded profile must already contain/, (tmp) => [exe, supplied(tmp), 'upgraded']));

test('on failure a supplied profile keeps existing, with every app exited first', () => setup(async ({ deps, log, tmp }) => {
  await assert.rejects(main({ ...deps, argv: [exe, supplied(tmp), 'seed'], phases: { seed: async (ctx) => { await ctx.launch(); throw new Error('phase boom'); }, upgraded: ok.upgraded } }), /phase boom/);
  assert.ok(log.includes('exit:app1'));
  assert.ok(existsSync(supplied(tmp)));
  assert.ok(!log.some((entry) => entry.startsWith('rm:')));
}));

test('a supplied profile still fails closed on a userData mismatch and terminates the app', () => setup(async ({ deps, log, tmp }) => {
  await assert.rejects(main({ ...deps, argv: [exe, supplied(tmp), 'seed'], phases: noSeedPhases }), /userData .* is not the profile/);
  assert.ok(log.includes('exit:app1') && !log.includes('firstWindow:app1'));
}, { launchOptions: () => ({ userData: '/some/real/userData' }) }));

test('a supplied profile run with an app that will not exit reports the failure', () => setup(async ({ deps, tmp }) => {
  await assert.rejects(main({ ...deps, argv: [exe, supplied(tmp), 'seed'], phases: noSeedPhases }), /did not exit|retained/);
  assert.ok(existsSync(supplied(tmp)));
}, { launchOptions: () => ({ neverExit: true }) }));

test('the profile is a harness-created canonical bingo-smoke-* directory directly under the temp dir, removed afterwards', () => setup(async ({ deps, tmp }) => {
  let seen;
  await main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { seen = ctx.profile; assert.ok(existsSync(seen)); }, upgraded: async () => {} } });
  assert.equal(path.dirname(seen), tmp);
  assert.match(path.basename(seen), /^bingo-smoke-/);
  assert.equal(existsSync(seen), false);
}));

test('a missing executable fails before any profile is created', () => setup(async ({ deps, tmp }) => {
  await assert.rejects(main({ ...deps, exists: () => false, argv: [exe], phases: ok }), /packaged executable not found/);
  assert.deepEqual(await import('node:fs').then((fs) => fs.readdirSync(tmp)), []);
}));

test('runtime userData is asserted equal to the profile before any other interaction', () => setup(async ({ deps, log }) => {
  await main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); }, upgraded: async () => {} } });
  assert.deepEqual(log.filter((entry) => /^(launch|evaluate|firstWindow)/.test(entry)), ['launch:ok', 'evaluate:app1']);
}));

test('a userData that is not the profile fails closed: no window, app terminated, then the profile is deleted', () => setup(async ({ deps, log }) => {
  await assert.rejects(main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); }, upgraded: async () => {} } }),
    /userData .* is not the profile/);
  assert.ok(!log.includes('firstWindow:app1'));
  assert.ok(log.indexOf('exit:app1') >= 0 && log.indexOf('exit:app1') < log.lastIndexOf('rm:bingo-smoke'), log.join(','));
}, { launchOptions: () => ({ userData: '/some/real/userData' }) }));

test('on success every launched app is terminated gracefully and exited before the profile is deleted', () => setup(async ({ deps, log }) => {
  await main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); await ctx.launch(); }, upgraded: async () => {} } });
  const rm = log.lastIndexOf('rm:bingo-smoke');
  for (const name of ['app1', 'app2']) {
    assert.ok(log.indexOf(`close:${name}`) < log.indexOf(`exit:${name}`) && log.indexOf(`exit:${name}`) < rm, log.join(','));
  }
}));

test('on failure every launched app is still terminated before the profile is deleted and the error propagates', () => setup(async ({ deps, log }) => {
  await assert.rejects(main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); throw new Error('phase boom'); }, upgraded: ok.upgraded } }), /phase boom/);
  assert.ok(log.indexOf('exit:app1') >= 0 && log.indexOf('exit:app1') < log.lastIndexOf('rm:bingo-smoke'), log.join(','));
}));

test('an app ignoring close is SIGKILLed and awaited before deletion', () => setup(async ({ deps, log }) => {
  await main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); }, upgraded: async () => {} } });
  assert.ok(log.indexOf('kill:SIGKILL:app1') >= 0 && log.indexOf('kill:SIGKILL:app1') < log.indexOf('exit:app1') && log.indexOf('exit:app1') < log.lastIndexOf('rm:bingo-smoke'), log.join(','));
}, { launchOptions: () => ({ hangClose: true }) }));

test('a process that will not exit keeps the profile and the failure is reported', () => setup(async ({ deps, log, tmp }) => {
  await assert.rejects(main({ ...deps, argv: [exe], phases: { seed: async (ctx) => { await ctx.launch(); }, upgraded: async () => {} } }), /did not exit|retained/);
  assert.equal(log.filter((entry) => entry === 'rm:bingo-smoke').length, 1, 'only the broken-database profile was deleted');
  assert.equal((await import('node:fs')).readdirSync(tmp).length, 1, 'profile retained');
}, { launchOptions: () => ({ neverExit: true }) }));

const brokenSetup = async (run, { win = false, neverExit = false, exitEarly = false } = {}) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-test-')));
  const log = [];
  const garbage = Buffer.from('not a sqlite database');
  let spawned;
  const spawn = (executable, args) => {
    const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    writeFileSync(path.join(profile, 'current-event.sqlite'), garbage);
    const made = fakeChild(log, { neverExit, name: 'broken' });
    if (exitEarly) made.finish();
    spawned = { ...made, profile, args };
    log.push('spawn');
    return made.child;
  };
  const rm = (target, options) => { log.push('rm:broken'); rmSync(target, options); };
  const deps = { spawn, rm, tmp, closeMs: 30, killMs: 30, waitMs: 10, settleMs: 5, platform: win ? 'win32' : 'linux', uid: 1000,
    execFileSync: (cmd, args) => { log.push(`taskkill:${args.join(' ')}`); spawned.child.kill('SIGKILL'); }, log: () => {} };
  try { await run({ deps, log, garbage, get spawned() { return spawned; } }); } finally { rmSync(tmp, { recursive: true, force: true }); }
};

test('the broken-database child runs on its own harness-created profile and is terminated before the profile is deleted', () => brokenSetup(async (state) => {
  const { deps, log } = state;
  await checkBrokenDatabase({ ...deps, executablePath: exe, step: () => {} });
  assert.match(path.basename(state.spawned.profile), /^bingo-smoke-/);
  assert.ok(log.indexOf('exit:broken') >= 0 && log.indexOf('exit:broken') < log.indexOf('rm:broken'), log.join(','));
}));

test('the broken-database child is terminated even when its assertion fails', () => brokenSetup(async ({ deps, log }) => {
  await assert.rejects(checkBrokenDatabase({ ...deps, executablePath: exe, step: () => {} }), /startup error stays on screen/);
  assert.ok(log.indexOf('exit:broken') < log.indexOf('rm:broken'), log.join(','));
}, { win: true, exitEarly: true }));

test('a broken-database child that will not exit is retained, not deleted', () => brokenSetup(async ({ deps, log }) => {
  await assert.rejects(checkBrokenDatabase({ ...deps, executablePath: exe, step: () => {} }), /did not exit|retained/);
  assert.ok(!log.includes('rm:broken'));
}, { neverExit: true }));

test('the real seed phase reaches its interaction steps (no undefined helper before the first click)', () => setup(async ({ deps, tmp }) => {
  const sentinel = new Error('reached the first click');
  const operator = { url: () => 'file:///x/app.asar/dist/renderer/operator.html', waitForFunction: async () => {}, click: async () => { throw sentinel; } };
  const electron = { launch: async (options) => {
    const app = await deps.electron.launch(options);
    app.firstWindow = async () => operator;
    return app;
  } };
  // The profile is created by the harness and the database file must exist for the seed assertion to pass.
  const original = deps.electron.launch;
  await assert.rejects(main({ ...deps, electron: { launch: async (options) => {
    const profile = options.args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    writeFileSync(path.join(profile, 'current-event.sqlite'), '');
    return electron.launch(options);
  } }, argv: [exe] }), (error) => error === sentinel);
  assert.equal(typeof original, 'function');
}));

// GitHub-hosted Windows runners keep RUNNER_TEMP (the workflow's BINGO_DATA parent) apart from os.tmpdir().
test('a supplied profile directly under RUNNER_TEMP is accepted when it differs from the OS temp dir, and never deleted', () => setup(async ({ deps, log, launched }) => {
  const runnerTemp = realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-runner-')));
  try {
    const profile = path.join(runnerTemp, 'bingo-user-data');
    await main({ ...deps, env: { RUNNER_TEMP: runnerTemp }, argv: [exe, profile, 'seed'], phases: noSeedPhases });
    assert.ok(existsSync(profile));
    assert.ok(launched[0].options.args.includes(`--user-data-dir=${profile}`));
    assert.ok(!log.some((entry) => entry.startsWith('rm:')));
  } finally { rmSync(runnerTemp, { recursive: true, force: true }); }
}));

test('RUNNER_TEMP widens the parent only to that exact directory: nested, other and relative values are refused', () => setup(async ({ deps, launched, tmp }) => {
  const runnerTemp = realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-runner-')));
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'packaged-smoke-else-')));
  try {
    for (const [envValue, profile] of [[runnerTemp, path.join(runnerTemp, 'sub', 'bingo-x')], [runnerTemp, path.join(elsewhere, 'bingo-x')],
      ['relative/dir', path.join(elsewhere, 'bingo-x')], [path.join(tmp, 'missing'), path.join(path.join(tmp, 'missing'), 'bingo-x')]]) {
      await assert.rejects(main({ ...deps, env: { RUNNER_TEMP: envValue }, argv: [exe, profile, 'seed'], phases: noSeedPhases }), /directly under/);
    }
    assert.deepEqual(launched, []);
  } finally { rmSync(runnerTemp, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
}));
