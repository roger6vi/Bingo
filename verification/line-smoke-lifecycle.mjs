// FL09 harness lifecycle core: project resolution, owned canonical fixtures, verified launch, process termination,
// the run-authority scope, allowlist facades and the scenario runner. Import-safe: nothing runs on import. It never builds
// or installs, only launches the built app of an explicit worktree on harness-created bingo-smoke-* profiles.
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const profilePrefix = 'bingo-smoke-';
const BUILD_HINT = 'run the explicit prerequisite npm run build in the feature worktree';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const newest = (target) => {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(target).filter((name) => name !== 'generated').map((name) => newest(path.join(target, name))));
};

// The explicit, canonical worktree root and its built entry. Never builds: a stale or missing dist is an error.
export function resolveProject(root = path.resolve(import.meta.dirname, '..')) {
  if (!path.isAbsolute(root) || !existsSync(root)) throw new Error(`project root ${root} does not exist`);
  if (realpathSync(root) !== root) throw new Error(`project root ${root} is not canonical`);
  const outputs = ['main.js', 'preload.js', 'public-preload.js', 'renderer/operator.html', 'renderer/public.html']
    .map((file) => path.join(root, 'dist', file));
  const missing = outputs.filter((file) => !existsSync(file));
  if (missing.length) throw new Error(`dist output is missing (${missing.map((file) => path.relative(root, file)).join(', ')}): ${BUILD_HINT}`);
  if (Math.min(...outputs.map((file) => statSync(file).mtimeMs)) < newest(path.join(root, 'src'))) {
    throw new Error(`dist is stale compared with src: ${BUILD_HINT}`);
  }
  return { root, entry: path.join(root, 'dist', 'main.js'), outputs };
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const waitForExit = (child, ms) => exited(child) ? Promise.resolve(true) : new Promise((resolve) => {
  const done = () => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
  child.once('exit', done);
});

// Closes one Electron app and resolves only once its process exited: graceful close, bounded wait, then SIGKILL.
const terminating = new WeakMap();
export function terminateApp(app, options = {}) {
  if (!terminating.has(app)) {
    const done = terminate(app, options).finally(() => terminating.delete(app));
    terminating.set(app, done);
  }
  return terminating.get(app);
}
async function terminate(app, { closeMs = 5000, killMs = 5000, force = false }) {
  const child = app.process();
  if (exited(child)) return;
  if (force) child.kill('SIGKILL');
  else await Promise.race([Promise.resolve(app.close()).catch(() => {}), sleep(closeMs)]);
  if (await waitForExit(child, force ? killMs : closeMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, killMs))) throw new Error('Electron process did not exit after SIGKILL; its profile is retained');
}

// Fixtures are opaque: ownership is a module-private WeakMap entry, so a look-alike object (forged path, track, verified)
// can neither launch, read nor be disposed. All mutable state (apps, launches, verified, closing) is private.
const states = new WeakMap();
const stateOf = (fixture) => {
  const state = states.get(fixture);
  if (state === undefined) throw new Error('Refusing: not a harness-owned fixture profile');
  return state;
};
const assertOpen = (state, action) => {
  if (state.closing) throw new Error(`fixture is disposing: refusing to ${action}`);
};

// A profile created and owned by this run: a canonical bingo-smoke-* directory directly in the OS temp dir. It is
// removed only after every tracked app exited, and kept for diagnosis otherwise. Once disposal starts, nothing can
// launch, restart, track or read through it again, and a launch still in flight is awaited and terminated first.
export function createFixture({ tmp = tmpdir(), mkdtemp = mkdtempSync, rm = rmSync, profile, closeMs, killMs } = {}) {
  if (profile !== undefined) throw new Error(`Refusing the supplied foreign profile ${profile}: only harness-created profiles are used`);
  const base = realpathSync(tmp);
  const created = mkdtemp(path.join(base, profilePrefix));
  if (lstatSync(created).isSymbolicLink()) throw new Error(`Refusing ${created}: a symlink is not a fixture profile`);
  if (realpathSync(created) !== created) throw new Error(`Refusing ${created}: profile is not canonical`);
  if (path.dirname(created) !== base) throw new Error(`Refusing ${created}: profile is not directly under ${base}`);
  if (!path.basename(created).startsWith(profilePrefix)) throw new Error(`Refusing ${created}: profile is not a ${profilePrefix}* directory`);
  const state = { apps: new Set(), launches: new Set(), verified: false, closing: false, disposal: null, active: null, root: null };
  const stop = async (app, options) => {
    await terminateApp(app, { closeMs, killMs, ...options });
    state.apps.delete(app);
    if (state.active === app) { state.active = null; state.verified = false; }
  };
  // Every tracked app is attempted even if one refuses to exit; failures are aggregated, never hidden.
  const closeAll = async () => {
    const errors = [];
    for (const app of [...state.apps]) await stop(app).catch((error) => errors.push(error));
    if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
  };
  const fixture = Object.freeze({
    path: created,
    get verified() { return state.verified; },
    get apps() { return [...state.apps]; },
    track(app) { assertOpen(state, 'track an app'); state.apps.add(app); },
    closeAll,
    async restart(app, launch, options) {
      assertOpen(state, 'restart');
      await stop(app, options);
      assertOpen(state, 'restart');
      return launch();
    },
    dispose() {
      state.closing = true;
      state.disposal ??= (async () => {
        await Promise.allSettled([...state.launches]);
        await closeAll();
        rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      })();
      return state.disposal;
    },
  });
  states.set(fixture, state);
  return fixture;
}

export function launchArgs(project, fixture, { isRoot = process.getuid?.() === 0 } = {}) {
  stateOf(fixture);
  return [project.root, `--user-data-dir=${fixture.path}`, ...(isRoot ? ['--no-sandbox'] : [])];
}

// Playwright's first main-process evaluate can fail once with "Resulting promise was garbage collected".
async function readMainPaths(app, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await app.evaluate(({ app: electronApp }) => ({ userData: electronApp.getPath('userData'), appPath: electronApp.getAppPath() })); }
    catch (error) { if (attempt >= attempts || !/garbage collected/.test(error.message)) throw error; }
  }
}

// Launches the explicit root on the fixture and proves the runtime really uses both before anything else happens.
// `onLaunch(app)` runs immediately after launch, before any verification await, so startup output is never lost.
export async function launchVerified({ electron, executablePath, project, fixture, timeout = 30_000, onLaunch }) {
  const state = stateOf(fixture);
  assertOpen(state, 'launch');
  const launching = Promise.resolve(electron.launch({ executablePath, args: launchArgs(project, fixture), timeout }))
    .then((app) => { state.apps.add(app); return app; });
  state.launches.add(launching.catch(() => {}));
  const app = await launching;
  try {
    onLaunch?.(app);
    assertOpen(state, 'verify a launch');
    const paths = await readMainPaths(app);
    if (paths.userData !== fixture.path) throw new Error(`Electron userData ${paths.userData} is not the fixture profile ${fixture.path}`);
    if (paths.appPath !== project.root) throw new Error(`Electron appPath ${paths.appPath} is not the project root ${project.root}`);
    state.verified = true;
    state.active = app;
    state.root = project.root;
    return { app, operator: await app.firstWindow() };
  } catch (error) {
    await terminateApp(app).then(() => { state.apps.delete(app); }, () => {});
    throw error;
  }
}

// Narrow accessor for the database reader: the fixture must be open (not disposing) and its runtime profile verified.
// It hands out the live app and project root only after those checks; forged fixtures are refused by `stateOf`.
export function verifiedRuntime(fixture, action) {
  const state = stateOf(fixture);
  assertOpen(state, action);
  if (!state.verified || state.active === null) throw new Error('runtime profile not verified: refusing to read the database');
  return { app: state.active, root: state.root };
}

// ---- run authority -------------------------------------------------------------------------------------------
// The scenario body acts only through guarded helpers. Cancelling the scope is synchronous and permanent: no NEW
// harness action starts afterwards and an action that finishes late reports cancellation. This does NOT retract a
// Playwright command, IPC or UI event already dispatched; those are bounded by terminating every process before the
// profile is deleted.
export function createScope() {
  let reason = null;
  return { get cancelled() { return reason !== null; }, cancel(why = 'cancelled') { reason ??= why; },
    check() { if (reason !== null) throw new Error(`scenario cancelled: ${reason}`); } };
}

// Body-facing facades are frozen objects with an explicit allowlist per type, not a generic proxy: anything else
// (context(), process(), windows(), handles, capability-valued properties) simply does not exist for the body. The owner
// keeps the raw objects for process termination, logs and diagnostics. 'data' results must be JSON-safe plain data
// (no functions, getters, symbols, class instances), 'void' results (handles, responses) are dropped.
// This is not a sandbox for the arbitrary code an evaluate callback runs inside the page or main process.
const FACADES = {
  app: { evaluate: 'data', waitForEvent: 'page' },
  page: { evaluate: 'data', waitForFunction: 'void', reload: 'void', close: 'void', locator: 'locator', click: 'void', fill: 'void' },
  locator: { click: 'void', fill: 'void', evaluate: 'data', waitFor: 'void' },
};

// Methods whose complete argument list is fixed: nothing else is forwarded (a Playwright predicate would receive a raw page).
const EXACT_ARGS = { 'app.waitForEvent': ['window'] };

function jsonSafe(value, depth = 0) {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return true;
  if (typeof value !== 'object' || depth > 20) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key) && jsonSafe(value[key], depth + 1));
}

export function guarded(scope, target, kind = 'page') {
  const facade = {};
  for (const [method, returns] of Object.entries(FACADES[kind])) {
    const settle = (value) => {
      scope.check();
      if (returns === 'void') return undefined;
      if (returns === 'data') { if (!jsonSafe(value)) throw new Error(`${kind}.${method} result is not JSON-safe plain data (fail closed)`); return value; }
      return guarded(scope, value, returns);
    };
    const exact = EXACT_ARGS[`${kind}.${method}`];
    facade[method] = (...args) => {
      scope.check();
      if (exact && (args.length !== exact.length || exact.some((value, index) => args[index] !== value))) {
        throw new Error(`${kind}.${method} accepts exactly (${exact.map((value) => JSON.stringify(value)).join(', ')}); refusing other arguments`);
      }
      const result = target[method](...args);
      return typeof result?.then === 'function' ? result.then(settle) : settle(result);
    };
  }
  return Object.freeze(facade);
}

const bounded = (promise, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
};

// Runs one scenario body under a timeout. On failure or timeout the body's authority is revoked FIRST (synchronously,
// before any await); only then are bounded, read-only diagnostics taken through the owner capability, and every
// process is terminated before the profile is deleted. Diagnostics can fail or hang without blocking cleanup.
export async function runScenario({ name, body, ctx, scope, owner, timeoutMs = 90_000, boundMs = 5000, say, timer = { set: setTimeout, clear: clearTimeout } }) {
  const started = Date.now();
  const running = Promise.resolve().then(() => body(ctx));
  running.catch(() => {}); // a late body can only fail on revoked authority
  let handle;
  let result;
  try {
    await Promise.race([running, new Promise((_, reject) => {
      handle = timer.set(() => { scope.cancel('scenario timed out'); reject(new Error('scenario timed out')); }, timeoutMs);
    })]);
    result = { name, status: 'pass', ms: Date.now() - started };
    say(`PASS ${name}`);
  } catch (error) {
    scope.cancel(error.message);
    result = { name, status: 'fail', error: error.message };
    say(`FAIL ${name}: ${error.stack}`);
    await bounded(owner.diagnostics(error), boundMs, 'diagnostics').catch((cause) => say(`${name}: diagnostics unavailable (${cause.message}); the log holds the last sampled states`));
    await bounded(owner.screenshots(), boundMs, 'screenshots').catch((cause) => say(`${name}: screenshots unavailable (${cause.message})`));
  } finally {
    timer.clear(handle);
    scope.cancel('scenario finished');
    try { await owner.dispose(); say(`${name}: cleanup done`); }
    catch (error) { say(`${name}: cleanup failed, profile retained: ${error.message}`); result = { ...result, status: 'fail', error: `${result.error ?? ''} cleanup: ${error.message}`.trim() }; }
  }
  return result;
}
