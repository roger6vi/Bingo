// @ts-nocheck -- fake launch/app/fs dependencies; no Electron is ever launched here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';
import { createLinePresentationCoordinator } from '../src/line-presentation.ts';
import * as lifecycle from '../verification/line-smoke-lifecycle.mjs';
import * as reader from '../verification/line-smoke-reader.mjs';

const smoke = { ...lifecycle, ...reader };

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

test('a runtime userData mismatch aborts before any DB interaction and closes the app', () => withTemp(async (dir) => {
  const fixture = smoke.createFixture({ tmp: dir });
  const log = [];
  const app = fakeApp(log, { paths: { userData: path.join(dir, 'elsewhere'), appPath: '/feature' } });
  const electron = { launch: async () => app };
  await assert.rejects(smoke.launchVerified({ electron, executablePath: 'x', project: { root: '/feature' }, fixture }), /userData/);
  assert.deepEqual(log, ['close', 'exit']);
  await assert.rejects(smoke.readAwards(fixture), /not verified/);
  // A foreign app path (primary checkout) is refused as well.
  const wrongApp = fakeApp([], { paths: { userData: fixture.path, appPath: '/primary' } });
  await assert.rejects(smoke.launchVerified({ electron: { launch: async () => wrongApp }, executablePath: 'x', project: { root: '/feature' }, fixture }), /appPath/);
  const good = fakeApp([], { paths: { userData: fixture.path, appPath: '/feature' } });
  await smoke.launchVerified({ electron: { launch: async () => good }, executablePath: 'x', project: { root: '/feature' }, fixture });
  assert.equal(fixture.verified, true);
  await fixture.dispose();
}));

const verified = async (fixture, app, root = '/feature') =>
  smoke.launchVerified({ electron: { launch: async () => app }, executablePath: 'x', project: { root }, fixture });

test('database reads run in the verified main process, never for forged or unverified fixtures', () => withTemp(async (dir) => {
  const fixture = smoke.createFixture({ tmp: dir });
  const forged = { path: fixture.path, verified: true, apps: new Set(), track() {}, markVerified() {}, async closeAll() {} };
  await assert.rejects(smoke.readAwards(forged), /not a harness-owned/);
  await assert.rejects(smoke.readAwards(fixture), /not verified/);
  const calls = [];
  const app = fakeApp([], { paths: { userData: fixture.path, appPath: '/feature' }, rows: [[{ id: 'x' }]], calls });
  await verified(fixture, app);
  calls.length = 0;
  assert.deepEqual(await smoke.readAwards(fixture), [{ id: 'x' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { userData: fixture.path, appPath: '/feature', file: path.join(fixture.path, 'current-event.sqlite'),
    statements: [smoke.AWARD_SQL] });
  await fixture.dispose();
  await assert.rejects(smoke.readAwards(fixture), /disposing|not verified/);
}));

test('the main-process reader checks userData and appPath before opening, and only runs read statements', () => withTemp(async (dir) => {
  const file = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE line_awards (presentation_id TEXT, presentation_status TEXT, presentation_started_at INTEGER, presentation_deadline INTEGER, winner_count INTEGER, total_cents INTEGER, share_cents INTEGER, remainder_cents INTEGER, lot TEXT, lot_resolution TEXT)');
  db.exec("INSERT INTO line_awards VALUES ('a', 'started', 1, 4001, 1, 100, 100, 0, '', 'not_required')");
  db.close();
  const electron = { app: { getPath: () => '/u', getAppPath: () => '/a' } };
  const args = { userData: '/u', appPath: '/a', file, statements: [smoke.AWARD_SQL, 'PRAGMA journal_mode'] };
  const [awards, journal] = smoke.mainReadOnly(electron, args);
  assert.deepEqual(awards.map((row) => row.status), ['started']);
  assert.equal(journal[0].journal_mode, 'delete');
  const missing = { ...args, file: path.join(dir, 'missing.sqlite') };
  assert.throws(() => smoke.mainReadOnly(electron, { ...missing, userData: '/other' }), /userData/);
  assert.throws(() => smoke.mainReadOnly(electron, { ...missing, appPath: '/other' }), /appPath/);
  assert.throws(() => smoke.mainReadOnly(electron, missing), (error) => !/userData|appPath/.test(error.message));
  assert.throws(() => smoke.mainReadOnly(electron, { ...args, statements: ['DELETE FROM line_awards'] }), /read-only statement/);
  assert.throws(() => smoke.mainReadOnly(electron, { ...args, statements: ['SELECT 1; DELETE FROM line_awards'] }), /read-only statement/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM line_awards').get().n, 1);
  check.close();
}));

// ---- intentional SQLite contention (characterization, not a product retry requirement) ----------------------------
const T1 = '2025-01-01T00:00:01.000Z';
function startedStore(dir) {
  const file = path.join(dir, 'event.sqlite');
  const store = createEventStore(file);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 10, lot: '' }, bingo: { amount: 0, lot: '' } });
  store.update((current) => drawManual(current, 7));
  return { file, store, pending: store.declareLineDirectly(store.loadLineDeclarationBaseline(), 1, T1) };
}
const holdReadLock = (file) => {
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT * FROM line_awards').all();
  return reader;
};

test('a second handle holding a read transaction makes the real store completion fail at COMMIT, leaving the row started', () => withTemp(async (dir) => {
  const { file, store, pending } = startedStore(dir);
  try {
    const { id } = store.startLinePresentation(pending.presentation.id, 1000).presentation;
    const probe = new DatabaseSync(file, { readOnly: true });
    const journalMode = probe.prepare('PRAGMA journal_mode').get().journal_mode;
    probe.close();
    assert.equal(journalMode, 'delete', 'rollback journal, not WAL: a reader blocks the writer at COMMIT');
    const reader = holdReadLock(file);
    let observed;
    assert.throws(() => store.completeLinePresentation(id, 5000), (error) => { observed = error; return true; });
    assert.match(observed.message, /database is locked/i);
    assert.equal(observed.errcode, 5, `SQLITE_BUSY expected; got ${JSON.stringify({ code: observed.code, errcode: observed.errcode, errstr: observed.errstr })}`);
    assert.doesNotMatch(observed.message, /deadline not reached/i);
    assert.deepEqual(store.loadLineAward()?.presentation, { id, status: 'started', startedAt: 1000, deadlineAt: 5000 }, 'rolled back');
    reader.exec('COMMIT');
    reader.close();
    assert.equal(store.completeLinePresentation(id, 5000).presentation.status, 'completed', 'an explicit completion succeeds once the reader is gone');
  } finally { store.close(); }
}));

test('the coordinator abandons a run on one BUSY completion: null, no timers, still started, no completion after release', () => withTemp(async (dir) => {
  const { file, store, pending } = startedStore(dir);
  try {
    let clock = 1000;
    let handle = 0;
    const timers = new Map();
    const notified = [];
    const coordinator = createLinePresentationCoordinator(store, {
      now: () => clock, schedule: (fn, ms) => { timers.set(++handle, { at: clock + ms, fn }); return handle; },
      cancel: (h) => { timers.delete(h); }, publish: () => true, notify: (value) => { notified.push(value); } });
    const advance = (ms) => {
      const target = clock + ms;
      for (let due = [...timers].find(([, t]) => t.at <= target); due; due = [...timers].find(([, t]) => t.at <= target)) {
        timers.delete(due[0]); clock = Math.max(clock, due[1].at); due[1].fn();
      }
      clock = target;
    };
    coordinator.begin(pending);
    assert.equal(coordinator.receiptStarted(pending.presentation.id), true);
    assert.equal(store.loadLineAward()?.presentation.deadlineAt, 5000);
    const reader = holdReadLock(file);
    notified.length = 0;
    advance(4000);
    assert.deepEqual(notified, [null], 'one failed completion is reported as null');
    assert.equal(coordinator.busy(), false);
    assert.equal(timers.size, 0);
    assert.equal(store.loadLineAward()?.presentation.status, 'started');
    reader.exec('COMMIT');
    reader.close();
    advance(120_000);
    assert.equal(store.loadLineAward()?.presentation.status, 'started', 'nothing retries or completes by itself');
    assert.deepEqual(notified, [null]);
    assert.equal(store.completeLinePresentation(pending.presentation.id, clock).presentation.status, 'completed');
  } finally { store.close(); }
}));
