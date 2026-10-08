// @ts-nocheck -- fake launch/app/fs dependencies; no Electron is ever launched here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as smoke from '../verification/line-smoke-lifecycle.mjs';

const temp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'line-smoke-test-')));
const withTemp = async (run) => { const dir = temp(); try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const touch = (file, seconds) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'x'); utimesSync(file, seconds, seconds); };
const project = (dir, { dist = 200, src = 100 } = {}) => {
  writeFileSync(path.join(dir, 'package.json'), '{}');
  for (const file of ['main.js', 'preload.js', 'public-preload.js', 'renderer/operator.html', 'renderer/public.html']) touch(path.join(dir, 'dist', file), dist);
  touch(path.join(dir, 'src', 'a.ts'), src);
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

test('the project root and entry are explicit, canonical and freshly built', () => withTemp(async (dir) => {
  project(dir);
  const resolved = smoke.resolveProject(dir);
  assert.equal(resolved.root, dir);
  assert.equal(resolved.entry, path.join(dir, 'dist', 'main.js'));
  assert.throws(() => smoke.resolveProject(path.join(dir, 'missing')), /does not exist|canonical/);
  const link = path.join(temp(), 'link');
  symlinkSync(dir, link);
  assert.throws(() => smoke.resolveProject(link), /canonical/);
  rmSync(path.dirname(link), { recursive: true, force: true });
}));

test('a missing or stale dist is refused with an explicit build prerequisite, never built', () => withTemp(async (dir) => {
  project(dir, { dist: 100, src: 200 });
  assert.throws(() => smoke.resolveProject(dir), /stale.*npm run build/);
  rmSync(path.join(dir, 'dist'), { recursive: true });
  assert.throws(() => smoke.resolveProject(dir), /missing.*npm run build/);
}));

test('launch arguments target the explicit root and the fixture only', () => {
  const fixture = smoke.createFixture();
  try {
    assert.deepEqual(smoke.launchArgs({ root: '/feature' }, fixture, { isRoot: false }), ['/feature', `--user-data-dir=${fixture.path}`]);
    assert.ok(smoke.launchArgs({ root: '/feature' }, fixture, { isRoot: true }).includes('--no-sandbox'));
    assert.throws(() => smoke.launchArgs({ root: '/feature' }, { path: '/Users/x/Library/Application Support/app' }), /not a harness-owned/);
  } finally { rmSync(fixture.path, { recursive: true, force: true }); }
});

test('fixtures are canonical bingo-smoke-* directories directly under the OS temp dir', () => withTemp(async (dir) => {
  const fixture = smoke.createFixture({ tmp: dir });
  assert.equal(path.dirname(fixture.path), dir);
  assert.ok(path.basename(fixture.path).startsWith('bingo-smoke-'));
  assert.equal(realpathSync(fixture.path), fixture.path);
  await fixture.dispose();
  assert.ok(!existsSync(fixture.path));
  assert.throws(() => smoke.createFixture({ tmp: dir, profile: path.join(dir, 'bingo-smoke-supplied') }), /supplied|foreign/);
  // A symlinked, non-temp-child or misnamed directory returned by mkdtemp is refused.
  const real = mkdtempSync(path.join(dir, 'real-'));
  const link = path.join(dir, 'bingo-smoke-link');
  symlinkSync(real, link);
  assert.throws(() => smoke.createFixture({ tmp: dir, mkdtemp: () => link }), /symlink|canonical/);
  mkdirSync(path.join(dir, 'nested'));
  assert.throws(() => smoke.createFixture({ tmp: dir, mkdtemp: () => mkdtempSync(path.join(dir, 'nested', 'bingo-smoke-')) }), /directly/);
  assert.throws(() => smoke.createFixture({ tmp: dir, mkdtemp: () => mkdtempSync(path.join(dir, 'other-')) }), /bingo-smoke-/);
}));

test('every app exits before the owned profile is deleted, also on failure and kill fallback', () => withTemp(async (dir) => {
  for (const options of [{ exitAfter: 20 }, { hangClose: true }]) {
    const log = [];
    const rm = (target) => { log.push('rm'); rmSync(target, { recursive: true, force: true }); };
    const fixture = smoke.createFixture({ tmp: dir, rm, closeMs: 30, killMs: 200 });
    fixture.track(fakeApp(log, options));
    await fixture.dispose();
    assert.deepEqual(log, options.hangClose ? ['close', 'kill:SIGKILL', 'exit', 'rm'] : ['close', 'exit', 'rm']);
  }
  // An app that never exits keeps the profile: it is retained for diagnosis, never deleted under a live process.
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir, rm: () => log.push('rm'), closeMs: 10, killMs: 10 });
  fixture.track(fakeApp(log, { neverExit: true }));
  await assert.rejects(fixture.dispose(), /did not exit/);
  assert.ok(!log.includes('rm'));
  rmSync(fixture.path, { recursive: true, force: true });
}));

test('a restart reuses the retained fixture and deletes nothing until both instances exited', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir, rm: (target) => { log.push('rm'); rmSync(target, { recursive: true, force: true }); } });
  const first = fakeApp(log);
  fixture.track(first);
  const second = fakeApp(log);
  const seen = [];
  const next = await fixture.restart(first, async () => { log.push('launch2'); seen.push(existsSync(fixture.path)); fixture.track(second); return second; });
  assert.equal(next, second);
  assert.deepEqual(seen, [true]);
  assert.deepEqual(log, ['close', 'exit', 'launch2']);
  await fixture.dispose();
  assert.deepEqual(log, ['close', 'exit', 'launch2', 'close', 'exit', 'rm']);
}));

test('a forged fixture can neither launch nor be used as launch arguments', async () => {
  let launches = 0;
  const forged = { path: '/tmp/bingo-smoke-forged', verified: true, apps: new Set(), track() {}, markVerified() {}, async closeAll() {} };
  const electron = { launch: async () => { launches++; return fakeApp([]); } };
  await assert.rejects(smoke.launchVerified({ electron, executablePath: 'x', project: { root: '/feature' }, fixture: forged }), /not a harness-owned/);
  assert.throws(() => smoke.launchArgs({ root: '/feature' }, forged), /not a harness-owned/);
  assert.equal(launches, 0);
});

test('main-process output is attached right after launch, before any verification', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir });
  const app = fakeApp(log, { paths: { userData: path.join(dir, 'elsewhere'), appPath: '/feature' } });
  const original = app.evaluate;
  app.evaluate = async (...args) => { log.push('verify'); return original(...args); };
  await assert.rejects(smoke.launchVerified({ electron: { launch: async () => app }, executablePath: 'x', project: { root: '/feature' }, fixture,
    onLaunch: () => log.push('attach') }), /userData/);
  assert.deepEqual(log.slice(0, 2), ['attach', 'verify']);
  await fixture.dispose();
}));

test('a launch still in flight when disposal starts is closed and exited before the profile is deleted', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir, rm: (target) => { log.push('rm'); rmSync(target, { recursive: true, force: true }); } });
  const app = fakeApp(log, { paths: { userData: fixture.path, appPath: '/feature' } });
  const late = new Promise((resolve) => setTimeout(() => { log.push('launch-resolved'); resolve(app); }, 40));
  const launching = smoke.launchVerified({ electron: { launch: () => late }, executablePath: 'x', project: { root: '/feature' }, fixture });
  const disposing = fixture.dispose();
  await assert.rejects(launching, /disposing/);
  await disposing;
  assert.deepEqual(log, ['launch-resolved', 'close', 'exit', 'rm']);
  let launches = 0;
  await assert.rejects(smoke.launchVerified({ electron: { launch: async () => { launches++; return app; } }, executablePath: 'x', project: { root: '/feature' }, fixture }), /disposing/);
  assert.equal(launches, 0);
}));

test('a late restart from a timed-out scenario is refused and never launches', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir });
  const app = fakeApp(log);
  fixture.track(app);
  const disposing = fixture.dispose();
  let launched = 0;
  await assert.rejects(fixture.restart(app, async () => { launched++; }), /disposing/);
  assert.throws(() => fixture.track(fakeApp(log)), /disposing/);
  await disposing;
  assert.equal(launched, 0);
}));

test('disposal attempts every tracked app even when one refuses to exit, keeps the profile, and is idempotent', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir, rm: () => log.push('rm'), closeMs: 10, killMs: 10 });
  fixture.track(fakeApp(log, { neverExit: true, name: 'stuck' }));
  fixture.track(fakeApp(log, { name: 'fine' }));
  const first = fixture.dispose();
  const second = fixture.dispose();
  await assert.rejects(first, (error) => error instanceof AggregateError && /did not exit/.test(error.message) && error.errors.length === 1);
  await assert.rejects(second, /did not exit/);
  assert.ok(log.includes('close:stuck') && log.includes('kill:SIGKILL:stuck') && log.includes('close:fine') && log.includes('exit:fine'));
  assert.ok(!log.includes('rm'));
  rmSync(fixture.path, { recursive: true, force: true });
}));

test('disposal removes the profile exactly once when called repeatedly', () => withTemp(async (dir) => {
  const log = [];
  const fixture = smoke.createFixture({ tmp: dir, rm: (target) => { log.push('rm'); rmSync(target, { recursive: true, force: true }); } });
  await Promise.all([fixture.dispose(), fixture.dispose()]);
  await fixture.dispose();
  assert.deepEqual(log, ['rm']);
}));

// ---- the production scenario runner: timeout authority, diagnostics gap, cleanup ------------------------------------
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const manualTimer = () => { let callback; return { set: (fn) => { callback = fn; return 1; }, clear() {}, fire: () => callback() }; };

test('the runner revokes body authority synchronously on timeout and keeps it revoked through diagnostics and cleanup', async () => {
  const log = [];
  const scope = smoke.createScope();
  const timer = manualTimer();
  const target = { click: async (name) => { log.push(`click:${name}`); }, locator: () => ({ click: async (name) => { log.push(`locator:${name}`); } }) };
  const page = smoke.guarded(scope, target);
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  // A queued multi-step UI sequence, paused after its first step.
  const body = async () => { await page.click('first'); await paused; await page.click('second'); await page.locator('x').click('third'); log.push('body-continued'); };
  const owner = {
    async diagnostics() {
      log.push('diag-start');
      assert.equal(scope.cancelled, true);
      await assert.rejects(async () => page.click('during-diagnostics'), /cancelled/);
      await assert.rejects(async () => page.locator('x').click('during-diagnostics'), /cancelled/);
      release();
      await tick();
      log.push('diag-end');
    },
    async screenshots() { log.push('shots'); },
    async dispose() { log.push('dispose'); },
  };
  const running = smoke.runScenario({ name: 'x', body, ctx: {}, scope, owner, timeoutMs: 1000, boundMs: 500, say: () => {}, timer });
  await tick();
  timer.fire();
  assert.equal(scope.cancelled, true, 'cancelled synchronously, before any await');
  const result = await running;
  assert.equal(result.status, 'fail');
  assert.match(result.error, /timed out/);
  await tick();
  assert.deepEqual(log, ['click:first', 'diag-start', 'diag-end', 'shots', 'dispose']);
});

test('diagnostics that reject or hang never prevent cleanup; a passing run needs none; a failing cleanup is reported', async () => {
  const hanging = () => new Promise(() => {});
  for (const diagnostics of [async () => { throw new Error('boom'); }, hanging]) {
    const log = [];
    const owner = { diagnostics, screenshots: hanging, async dispose() { log.push('dispose'); } };
    const result = await smoke.runScenario({ name: 'x', body: async () => { throw new Error('body failed'); }, ctx: {}, scope: smoke.createScope(),
      owner, timeoutMs: 1000, boundMs: 30, say: () => {} });
    assert.deepEqual([result.status, log], ['fail', ['dispose']]);
    assert.match(result.error, /body failed/);
  }
  const log = [];
  const passing = await smoke.runScenario({ name: 'x', body: async () => {}, ctx: {}, scope: smoke.createScope(), boundMs: 30, say: () => {},
    owner: { diagnostics: async () => { log.push('diag'); }, screenshots: async () => {}, dispose: async () => { log.push('dispose'); } } });
  assert.deepEqual([passing.status, log], ['pass', ['dispose']]);
  const failedCleanup = await smoke.runScenario({ name: 'x', body: async () => {}, ctx: {}, scope: smoke.createScope(), boundMs: 30, say: () => {},
    owner: { diagnostics: async () => {}, screenshots: async () => {}, dispose: async () => { throw new Error('did not exit'); } } });
  assert.deepEqual([failedCleanup.status, /cleanup.*did not exit/.test(failedCleanup.error)], ['fail', true]);
});

// Raw capabilities a body must never reach: a retained context could open pages and a child process could be killed.
const rawCapabilities = () => {
  const events = [];
  const context = { newPage: async () => { events.push('newPage'); }, close: async () => { events.push('context.close'); } };
  const child = { kill: () => { events.push('kill'); } };
  const page = (extra = {}) => ({ click: async () => {}, emulateMedia: async () => {}, fill: async () => {}, evaluate: async () => 1, waitForFunction: async () => ({ jsHandle: true }),
    reload: async () => ({ response: true }), close: async () => {}, locator: () => locatorOf(), context: () => context, ...extra });
  const locatorOf = () => ({ click: async () => {}, fill: async () => {}, evaluate: async () => 1, waitFor: async () => {}, page: () => page(), evaluateHandle: async () => ({}) });
  const app = { evaluate: async () => 1, waitForEvent: async () => page(), context: () => context, process: () => child, windows: () => [page()],
    on() {}, evaluateHandle: async () => ({}), browserWindow: async () => ({}), contextProperty: context, get liveChild() { return child; } };
  return { events, context, child, page, app, locatorOf };
};
const ALLOWED = { app: ['evaluate', 'waitForEvent'], page: ['click', 'close', 'emulateMedia', 'evaluate', 'fill', 'locator', 'reload', 'waitForFunction'],
  locator: ['click', 'evaluate', 'fill', 'waitFor'] };
test('body-facing facades expose only an allowlist per type: no context, process, handles, windows or capability properties', () => {
  const raw = rawCapabilities();
  const scope = smoke.createScope();
  for (const [kind, target] of [['app', raw.app], ['page', raw.page()], ['locator', raw.locatorOf()]]) {
    const facade = smoke.guarded(scope, target, kind);
    assert.deepEqual(Object.keys(facade).sort(), ALLOWED[kind], kind);
    assert.deepEqual(Reflect.ownKeys(facade).filter((key) => typeof key === 'symbol'), []);
    for (const forbidden of ['context', 'process', 'windows', 'on', 'evaluateHandle', 'browserWindow', 'contextProperty', 'liveChild', 'page', 'screenshot', 'setDefaultTimeout', 'then']) {
      assert.equal(facade[forbidden], undefined, `${kind}.${forbidden}`);
    }
    assert.throws(() => { facade.context(); }, TypeError);
    assert.throws(() => { facade.injected = 1; }, TypeError);
  }
  assert.deepEqual(raw.events, []);
});

test('a context or child process retained before cancellation is unobtainable through a facade', () => {
  const raw = rawCapabilities();
  const scope = smoke.createScope();
  const facade = smoke.guarded(scope, raw.app, 'app');
  const retained = [facade.context?.(), facade.process?.(), facade.contextProperty, facade.liveChild];
  scope.cancel('test');
  assert.deepEqual(retained, [undefined, undefined, undefined, undefined], 'the escape would let retained.newPage/kill run after cancel');
});

test('app.waitForEvent accepts exactly the string "window" and never forwards a predicate or any other argument', async () => {
  const raw = rawCapabilities();
  const dispatched = [];
  const retained = [];
  const app = { ...raw.app, waitForEvent: async (...args) => {
    dispatched.push(args);
    const options = args[1];
    const predicate = typeof options === 'function' ? options : options?.predicate;
    if (typeof predicate === 'function') { retained.push(predicate(raw.page())); }
    return raw.page();
  } };
  const scope = smoke.createScope();
  const facade = smoke.guarded(scope, app, 'app');
  const leak = (rawPage) => { retained.push(rawPage); return true; };
  for (const args of [['window', leak], ['window', { predicate: leak }], ['window', { timeout: 1 }], ['window', undefined], ['window', 'window'],
    ['close'], ['console'], ['window2'], [leak], [], [undefined], [{ toString: () => 'window' }], ['window', leak, 5]]) {
    await assert.rejects(async () => facade.waitForEvent(...args), /waitForEvent/, JSON.stringify(args.map(String)));
  }
  assert.equal(dispatched.length, 0, 'rejected before the raw method is called');
  assert.deepEqual(retained, [], 'no callback ever ran or saw a raw page');
  const page = await facade.waitForEvent('window');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], ['window']);
  assert.deepEqual(Object.keys(page).sort(), ALLOWED.page);
  scope.cancel('test');
  await assert.rejects(async () => facade.waitForEvent('window'), /cancelled/);
  await assert.rejects(async () => page.click(), /cancelled/);
  assert.equal(dispatched.length, 1);
});

test('facades refuse every action, retained method and late result after cancellation', async () => {
  const raw = rawCapabilities();
  const scope = smoke.createScope();
  const page = smoke.guarded(scope, raw.page({ click: () => new Promise((resolve) => setTimeout(resolve, 30)) }));
  const app = smoke.guarded(scope, raw.app, 'app');
  const retainedClick = page.click;
  const locator = page.locator('x');
  const launched = await app.waitForEvent('window');
  const inFlight = page.click();
  scope.cancel('test');
  await assert.rejects(inFlight, /cancelled/);
  for (const attempt of [() => retainedClick(), () => page.evaluate(), () => page.fill(), () => locator.click(), () => locator.waitFor(),
    () => app.evaluate(), () => app.waitForEvent('window'), () => launched.reload(), () => launched.locator('y')]) {
    await assert.rejects(async () => attempt(), /cancelled/);
  }
  assert.deepEqual(raw.events, [], 'no raw capability was used');
});

test('returned pages and locators are wrapped, handles are dropped, and results must be JSON-safe plain data', async () => {
  const raw = rawCapabilities();
  const scope = smoke.createScope();
  const app = smoke.guarded(scope, raw.app, 'app');
  const opened = await app.waitForEvent('window');
  assert.deepEqual(Object.keys(opened).sort(), ALLOWED.page);
  assert.equal(opened.context, undefined);
  assert.deepEqual(Object.keys(opened.locator('x')).sort(), ALLOWED.locator);
  assert.equal(await opened.waitForFunction(), undefined, 'JSHandle dropped');
  assert.equal(await opened.reload(), undefined, 'Response dropped');
  const unsafe = [raw.child, raw.context, { nested: { kill: raw.child.kill } }, { get leaked() { return raw.child; } }, [raw.context], new (class Secret {})(),
    () => 1, Symbol('s'), 10n, Object.create({ inherited: 1 }), { [Symbol('k')]: 1 }];
  for (const value of unsafe) {
    const facade = smoke.guarded(scope, { evaluate: async () => value }, 'locator');
    await assert.rejects(async () => facade.evaluate(), /not JSON-safe|fail closed/);
  }
  for (const value of [1, 'a', null, undefined, true, { a: [1, { b: 'c' }], d: null }, []]) {
    assert.deepEqual(await smoke.guarded(scope, { evaluate: async () => value }, 'locator').evaluate(), value);
  }
  assert.deepEqual(raw.events, []);
});

// ---- explicit opt-in packaged mode ----------------------------------------------------------------------------
const packagedLayout = (dir, { asar = 200, src = 100, executable = true } = {}) => {
  project(dir);
  const exe = path.join(dir, 'release', 'mac-arm64', 'Bingo.app', 'Contents', 'MacOS', 'Bingo');
  if (executable) touch(exe, asar);
  touch(path.join(dir, 'release', 'mac-arm64', 'Bingo.app', 'Contents', 'Resources', 'app.asar'), asar);
  touch(path.join(dir, 'src', 'a.ts'), src);
  return exe;
};

test('packaged mode resolves the executable and its app.asar, refusing relative, missing, foreign and stale builds', () => withTemp(async (dir) => {
  const exe = packagedLayout(dir);
  const packaged = smoke.resolvePackaged(dir, exe);
  assert.deepEqual(packaged, { executable: exe, appPath: path.join(path.dirname(exe), '..', 'Resources', 'app.asar') });
  assert.throws(() => smoke.resolvePackaged(dir, 'release/x/Bingo'), /absolute/);
  assert.throws(() => smoke.resolvePackaged(dir, path.join(dir, 'release', 'nope')), /does not exist/);
  const foreign = path.join(temp(), 'Bingo');
  touch(foreign, 300);
  assert.throws(() => smoke.resolvePackaged(dir, foreign), /inside .*release/);
  rmSync(path.dirname(foreign), { recursive: true, force: true });
  touch(path.join(dir, 'src', 'a.ts'), 900);
  assert.throws(() => smoke.resolvePackaged(dir, exe), /stale.*rebuild/i);
}));

test('packaged launch arguments carry only the fixture profile (no project root); default arguments are unchanged', () => {
  const fixture = smoke.createFixture();
  try {
    const packaged = { executable: '/r/Bingo', appPath: '/r/Resources/app.asar' };
    assert.deepEqual(smoke.launchArgs({ root: '/feature', packaged }, fixture, { isRoot: false }), [`--user-data-dir=${fixture.path}`]);
    assert.deepEqual(smoke.launchArgs({ root: '/feature', packaged }, fixture, { isRoot: true }), [`--user-data-dir=${fixture.path}`, '--no-sandbox']);
    assert.deepEqual(smoke.launchArgs({ root: '/feature' }, fixture, { isRoot: false }), ['/feature', `--user-data-dir=${fixture.path}`]);
  } finally { rmSync(fixture.path, { recursive: true, force: true }); }
});

test('packaged verification requires userData = fixture and appPath = the packaged app.asar', () => withTemp(async (dir) => {
  const packaged = { executable: '/r/Bingo', appPath: '/r/Resources/app.asar' };
  const launched = async (fixture, paths, packagedValue = packaged) => smoke.launchVerified({ electron: { launch: async () => fakeApp([], { paths }) },
    executablePath: packagedValue.executable, project: { root: '/feature', packaged: packagedValue }, fixture });
  const bad = smoke.createFixture({ tmp: dir });
  await assert.rejects(launched(bad, { userData: bad.path, appPath: '/feature' }), /appPath .*app\.asar/);
  const wrongProfile = smoke.createFixture({ tmp: dir });
  await assert.rejects(launched(wrongProfile, { userData: path.join(dir, 'elsewhere'), appPath: packaged.appPath }), /userData/);
  const notAsar = smoke.createFixture({ tmp: dir });
  await assert.rejects(launched(notAsar, { userData: notAsar.path, appPath: '/r/Resources/app' }, { executable: '/r/Bingo', appPath: '/r/Resources/app' }), /app\.asar/);
  const good = smoke.createFixture({ tmp: dir });
  await launched(good, { userData: good.path, appPath: packaged.appPath });
  assert.equal(good.verified, true);
  await Promise.all([bad, wrongProfile, notAsar, good].map((fixture) => fixture.dispose()));
}));

// ---- REC02B: fixture-owned legacy checking_line seeding ---------------------------------------------------------
// The project root holds stub dist CommonJS modules that record every call, so no real database or Electron is used.
const stubProject = (dir) => {
  const root = realpathSync(dir);
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'event-core.js'), `exports.drawManual = (event, number) => {
    globalThis.__seedLog.push(['drawManual', number]); return { ...event, calledNumbers: [...event.calledNumbers, number] }; };`);
  writeFileSync(path.join(root, 'dist', 'event-store.js'), `exports.createEventStore = (file) => {
    const log = globalThis.__seedLog; log.push(['open', file]);
    let event = globalThis.__seedPristine === false ? { calledNumbers: [3], phase: 'drawing', lastTransitionAt: null } : { calledNumbers: [], phase: 'drawing', lastTransitionAt: null };
    const audit = []; let prizes = { line: { amount: 0, lot: '' }, bingo: { amount: 0, lot: '' } }; let meta = { name: 'x', date: '2026-01-01', place: 'y' };
    return {
      load: () => ({ ...event, calledNumbers: [...event.calledNumbers] }), readAudit: () => audit.map((entry) => ({ ...entry })), loadLineAward: () => null,
      loadPrizes: () => ({ eventId: 'e1', prizes }), listEvents: () => [{ id: 'e1', ...meta, active: true }],
      update(fn) { log.push(['update']); if (globalThis.__seedFail) throw new Error('write failed'); event = { ...event, ...fn(event) }; return event; },
      transitionPhase(intent, at) { log.push(['transition', intent, at]); audit.push({ sequence: audit.length + 1, transitionAt: at, kind: intent, from_phase: 'drawing', to_phase: 'checking_line' });
        event = { ...event, phase: 'checking_line', lastTransitionAt: at }; return event; },
      updateEventPrizes(id, value) { log.push(['prizes', id]); prizes = value; return prizes; },
      updateEventMeta(id, value) { log.push(['meta', id]); meta = value; return { id, ...meta, active: true }; },
      loadLegacyLineCheck: () => ({ eventId: 'e1', phase: 'checking_line', lastTransitionAt: event.lastTransitionAt, auditSequence: audit.length }),
      close() { log.push(['close']); },
    }; };`);
  return root;
};
// A fixture whose bootstrap launch was verified and whose app was then closed: the state in which seeding is allowed.
async function bootstrapped(dir, { project, rm } = {}) {
  const log = [];
  globalThis.__seedLog = []; delete globalThis.__seedFail; delete globalThis.__seedPristine;
  const root = stubProject(dir);
  const fixture = smoke.createFixture({ tmp: dir, rm });
  writeFileSync(path.join(fixture.path, 'current-event.sqlite'), '');
  const app = fakeApp(log, { paths: { userData: fixture.path, appPath: project?.packaged?.appPath ?? root } });
  const launch = () => smoke.launchVerified({ electron: { launch: async () => app }, executablePath: 'x', project: project ?? { root }, fixture });
  return { fixture, root, app, launch, log, seedLog: globalThis.__seedLog };
}

test('seedLegacyLineCheck seeds the fixed legacy line check through the real store API after the bootstrap app exited', () => withTemp(async (dir) => {
  const { fixture, launch, seedLog, log } = await bootstrapped(dir);
  await launch();
  await fixture.closeAll();
  assert.deepEqual(log, ['close', 'exit']);
  const facts = await fixture.seedLegacyLineCheck();
  assert.deepEqual(seedLog.map(([step]) => step), ['open', 'meta', 'prizes', 'update', 'drawManual', 'drawManual', 'transition', 'close']);
  assert.equal(seedLog[0][1], path.join(fixture.path, 'current-event.sqlite'));
  assert.deepEqual(seedLog.filter(([step]) => step === 'drawManual').map(([, n]) => n), [7, 42]);
  assert.equal(seedLog.find(([step]) => step === 'transition')[1], 'begin_line_check');
  assert.deepEqual([facts.calledNumbers, facts.phase, facts.award], [[7, 42], 'checking_line', null]);
  assert.deepEqual(facts.check, { eventId: 'e1', phase: 'checking_line', lastTransitionAt: facts.lastTransitionAt, auditSequence: 1 });
  assert.equal(facts.audit.length, 1);
  assert.deepEqual(facts.prizes, { line: { amount: 25, lot: 'Cesta' }, bingo: { amount: 100, lot: 'Jamón' } });
  assert.deepEqual(Object.keys(facts.meta).sort(), ['date', 'name', 'place']);
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts, 'JSON-safe facts');
  assert.ok(Date.parse(facts.lastTransitionAt) > 0 && new Date(facts.lastTransitionAt).toISOString() === facts.lastTransitionAt);
  assert.throws(() => smoke.verifiedRuntime(fixture, 'read'), /not verified/, 'the live runtime identity check is not weakened');
  await assert.rejects(fixture.seedLegacyLineCheck(), /already/, 'one seed per fixture');
  await fixture.dispose();
}));

test('seedLegacyLineCheck takes no path, SQL or callback other than a guard, and writes nothing when refused', () => withTemp(async (dir) => {
  const { fixture, launch, seedLog } = await bootstrapped(dir);
  await launch();
  await fixture.closeAll();
  for (const bad of [{ path: '/x' }, { sql: 'DELETE FROM events' }, { write: () => {} }, { guard: 'nope' }, 'a path']) {
    await assert.rejects(fixture.seedLegacyLineCheck(bad), /Refusing|guard/);
  }
  assert.deepEqual(seedLog, [], 'nothing was opened');
  await assert.rejects(fixture.seedLegacyLineCheck({ guard: () => { throw new Error('scenario cancelled: x'); } }), /cancelled/);
  assert.deepEqual(seedLog, [], 'a revoked scope never reaches the database');
  await fixture.dispose();
}));

test('seeding is refused without a verified bootstrap, with a live app, a pending launch, when packaged or disposed', () => withTemp(async (dir) => {
  // Never launched: refused before any file or module is touched (the sqlite file does not even exist).
  const fresh = smoke.createFixture({ tmp: dir });
  await assert.rejects(fresh.seedLegacyLineCheck(), /no bootstrap/);
  // A launch whose runtime identity failed verification is not a bootstrap.
  const wrong = await bootstrapped(dir);
  wrong.app.evaluate = async () => ({ userData: '/elsewhere', appPath: wrong.root });
  await assert.rejects(wrong.launch(), /not the fixture profile/);
  await assert.rejects(wrong.fixture.seedLegacyLineCheck(), /no bootstrap/);
  // Live app.
  const live = await bootstrapped(dir);
  await live.launch();
  await assert.rejects(live.fixture.seedLegacyLineCheck(), /live|running/);
  assert.deepEqual(live.seedLog, []);
  // Pending launch.
  const pending = await bootstrapped(dir);
  await pending.launch();
  await pending.fixture.closeAll();
  let release;
  const slow = new Promise((resolve) => { release = () => resolve(fakeApp([], { paths: { userData: pending.fixture.path, appPath: pending.root } })); });
  const launching = smoke.launchVerified({ electron: { launch: () => slow }, executablePath: 'x', project: { root: pending.root }, fixture: pending.fixture });
  await assert.rejects(pending.fixture.seedLegacyLineCheck(), /launch/);
  release();
  await launching;
  await pending.fixture.dispose();
  // Packaged: unsupported.
  const packagedPath = path.join(dir, 'Resources', 'app.asar');
  const packaged = await bootstrapped(dir, { project: { root: realpathSync(dir), packaged: { appPath: packagedPath } } });
  await packaged.launch();
  await packaged.fixture.closeAll();
  await assert.rejects(packaged.fixture.seedLegacyLineCheck(), /packaged/);
  // Disposed.
  const disposed = await bootstrapped(dir);
  await disposed.launch();
  await disposed.fixture.closeAll();
  const disposing = disposed.fixture.dispose();
  await assert.rejects(disposed.fixture.seedLegacyLineCheck(), /disposing/);
  await disposing;
  for (const fixture of [fresh, wrong.fixture, live.fixture, packaged.fixture]) await fixture.dispose();
}));

test('a seed claims exclusivity synchronously: no concurrent seed, no launch or restart during it, disposal waits for it', () => withTemp(async (dir) => {
  const log = [];
  const { fixture, launch, app, seedLog } = await bootstrapped(dir, { rm: (target) => { log.push('rm'); rmSync(target, { recursive: true, force: true }); } });
  await launch();
  await fixture.closeAll();
  const seeding = fixture.seedLegacyLineCheck();
  await assert.rejects(fixture.seedLegacyLineCheck(), /already|seeding/, 'a concurrent seed is refused');
  await assert.rejects(launch(), /seeding/, 'a launch is refused during the seed');
  await assert.rejects(fixture.restart(app, async () => 'launched'), /seeding/, 'a restart is refused during the seed');
  const disposing = fixture.dispose().then(() => log.push('disposed'));
  await seeding.catch(() => {});
  await disposing;
  assert.ok(log.indexOf('rm') > -1);
  assert.ok(!seedLog.some(([step]) => step === 'open') || seedLog.at(-1)[0] === 'close', 'a store opened by the seed is closed before the profile is deleted');
  assert.ok(!existsSync(fixture.path));
}));

test('disposal that starts first aborts the seed before any database write', () => withTemp(async (dir) => {
  const { fixture, launch, seedLog } = await bootstrapped(dir);
  await launch();
  await fixture.closeAll();
  const seeding = fixture.seedLegacyLineCheck();
  const disposing = fixture.dispose();
  await assert.rejects(seeding, /disposing/);
  await disposing;
  assert.deepEqual(seedLog, [], 'nothing was opened or written');
}));

test('a non-pristine baseline or a failing write closes the store, surfaces the error and retains no extra authority', () => withTemp(async (dir) => {
  const dirty = await bootstrapped(dir);
  await dirty.launch();
  await dirty.fixture.closeAll();
  globalThis.__seedPristine = false;
  await assert.rejects(dirty.fixture.seedLegacyLineCheck(), /pristine/);
  assert.deepEqual(dirty.seedLog.map(([step]) => step), ['open', 'close'], 'no write happened and the store was closed');
  await assert.rejects(dirty.fixture.seedLegacyLineCheck(), /already/, 'a failed seed is never retried on the same profile');
  await dirty.fixture.dispose();
  const failing = await bootstrapped(dir);
  await failing.launch();
  await failing.fixture.closeAll();
  globalThis.__seedFail = true;
  await assert.rejects(failing.fixture.seedLegacyLineCheck(), /write failed/);
  assert.equal(failing.seedLog.at(-1)[0], 'close', 'the store is closed in finally');
  await failing.fixture.dispose();
}));

test('seeding refuses a symlinked database or a dist module outside the verified project root', () => withTemp(async (dir) => {
  const link = await bootstrapped(dir);
  await link.launch();
  await link.fixture.closeAll();
  rmSync(path.join(link.fixture.path, 'current-event.sqlite'));
  symlinkSync(path.join(link.root, 'dist', 'event-core.js'), path.join(link.fixture.path, 'current-event.sqlite'));
  await assert.rejects(link.fixture.seedLegacyLineCheck(), /symlink|regular/);
  assert.deepEqual(link.seedLog, []);
  await link.fixture.dispose();
  const missing = await bootstrapped(dir);
  await missing.launch();
  await missing.fixture.closeAll();
  rmSync(path.join(missing.root, 'dist', 'event-store.js'));
  await assert.rejects(missing.fixture.seedLegacyLineCheck(), /event-store/);
  assert.deepEqual(missing.seedLog, []);
  await missing.fixture.dispose();
}));
