// @ts-nocheck -- a scripted fake context; no Electron, profile or database is ever touched here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as scenarios from '../verification/line-legacy-recovery-smoke-scenarios.mjs';

const source = readFileSync(path.join(import.meta.dirname, '../verification/line-legacy-recovery-smoke-scenarios.mjs'), 'utf8');
const META = { name: 'Recuperación línea', date: '2026-01-15', place: 'Sala de pruebas' };
const PRIZES = { line: { amount: 25, lot: 'Cesta' }, bingo: { amount: 100, lot: 'Jamón' } };
const T1 = '2026-01-15T10:00:00.000Z';
const BEGIN = { sequence: 1, transitionAt: T1, kind: 'begin_line_check', fromPhase: 'drawing', toPhase: 'checking_line' };

// A state machine standing in for the product: the legacy dialog confirmation appends exactly one reject_line_claim.
function fake({ autoCancel = false, recoverTwice = false, awardOnRecover = false, loseNumbers = false } = {}) {
  const log = [];
  const note = (entry) => log.push(entry);
  const db = { ...META, calledNumbers: [], phase: 'drawing', lastTransitionAt: null, audit: [], prizes: structuredClone(PRIZES), awards: [] };
  let dialog = 'closed';
  let seeded = false;
  let live = 0;
  const recover = () => {
    db.phase = 'drawing';
    db.audit.push({ sequence: db.audit.length + 1, transitionAt: '2026-01-15T10:05:00.000Z', kind: 'reject_line_claim', fromPhase: 'checking_line', toPhase: 'drawing' });
    if (recoverTwice) db.audit.push({ ...db.audit.at(-1), sequence: db.audit.length + 1, transitionAt: '2026-01-15T10:06:00.000Z' });
    if (awardOnRecover) db.awards.push({ id: 'x', status: 'started' });
    if (loseNumbers) db.calledNumbers = [7];
  };
  const locator = (selector) => ({
    waitFor: async () => note(`wait:${selector}`),
    click: async () => {
      note(`click:${selector}`);
      if (selector === '#legacy-dialog [data-action="confirm"] button') { dialog = 'closed'; recover(); }
      else if (selector === '#legacy-dialog [data-action="cancel"] button') dialog = 'closed';
      else if (selector === '#line-recover button') dialog = 'open';
      else if (selector === '#open-public button') note('public-opened');
    },
    evaluate: async () => null,
  });
  const operator = { click: async (selector) => note(`click:${selector}`), locator, waitForFunction: async () => { note('operator:wait'); }, fill: async () => {},
    evaluate: async () => null };
  const page = { waitForFunction: async () => note('public:wait'), evaluate: async () => ({ hidden: true, active: false, text: '' }), reload: async () => {}, close: async () => {} };
  const app = { waitForEvent: async () => page, evaluate: async () => null };
  const ctx = {
    note: () => {}, pause: async () => note('pause'),
    async launch(label) {
      note(`launch:${label}`); live++;
      if (label === 'legacy' || label === 'restart') {
        if (!seeded) throw new Error('relaunch before seed');
        if (autoCancel) recover();
      }
      return { app, operator };
    },
    async restart(session, label) { note('restart'); return ctx.launch(label); },
    async closeApps() { note('closeApps'); live = 0; },
    async seedLegacyLine() {
      note('seed'); assert.equal(live, 0, 'seeding needs every app closed first');
      seeded = true;
      Object.assign(db, { calledNumbers: [7, 42], phase: 'checking_line', lastTransitionAt: T1, audit: [{ ...BEGIN }] });
      return { eventId: 'e1', calledNumbers: [7, 42], phase: 'checking_line', lastTransitionAt: T1, audit: [{ sequence: 1, transitionAt: T1, kind: 'begin_line_check', from_phase: 'drawing', to_phase: 'checking_line' }],
        prizes: PRIZES, meta: META, check: { eventId: 'e1', phase: 'checking_line', lastTransitionAt: T1, auditSequence: 1 }, award: null };
    },
    async readRecovery() { note('read'); return structuredClone(db); },
    async award() { return db.awards[0] ?? null; },
    async waitAward(label) { note(`waitAward:${label}`); const award = { id: 'a', status: 'started', startedAt: 1, deadline: 4001 }; db.awards.push(award); db.calledNumbers = [...db.calledNumbers]; return award; },
    async runToCompletion(op, started) { note('complete'); db.awards[0] = { ...started, status: 'completed' }; return db.awards[0]; },
    async declare() { note('declare'); },
    async drawFromUi() { note('drawFromUi'); db.calledNumbers = [...db.calledNumbers, 3]; },
    celebration: async () => ({ active: db.awards.length > 0 && db.awards[0].status === 'started', text: db.awards.length > 0 && db.awards[0].status === 'started',
      award: '' }),
    openPublic() { throw new Error('ctx.openPublic assumes one called number and must not be used'); },
  };
  return { ctx, log, db };
}

test('the scenario is exported under the selector name and never reads or writes outside the guarded context', () => {
  assert.deepEqual(scenarios.LEGACY_RECOVERY_SCENARIOS.map(([name]) => name), ['rec02b-legacy-recovery']);
  assert.equal(typeof scenarios.LEGACY_RECOVERY_SCENARIOS[0][1], 'function');
  assert.doesNotMatch(source, /from '\.\/|import\(|require\(|child_process|homedir|defaultUserData|node:fs|DatabaseSync|sqlite|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  assert.doesNotMatch(source, /ctx\.openPublic/);
});

test('bootstrap, close, seed, relaunch; dismiss changes nothing; one confirmation recovers; restart stays drawing; a normal line works', async () => {
  const { ctx, log, db } = fake();
  await scenarios.LEGACY_RECOVERY_SCENARIOS[0][1](ctx);
  const at = (entry) => log.indexOf(entry);
  assert.ok(at('launch:bootstrap') < at('closeApps') && at('closeApps') < at('seed') && at('seed') < at('launch:legacy'), 'bootstrap, then close, then seed, then relaunch');
  const confirms = log.filter((entry) => entry === 'click:#legacy-dialog [data-action="confirm"] button');
  assert.equal(confirms.length, 1, 'exactly one confirmation');
  assert.ok(at('click:#legacy-dialog [data-action="cancel"] button') < at('click:#legacy-dialog [data-action="confirm"] button'), 'dismissed first');
  assert.ok(at('public-opened') > -1 && at('public-opened') < at('click:#legacy-dialog [data-action="confirm"] button'), 'the public window is opened manually before the recovery');
  assert.ok(at('restart') > at('click:#legacy-dialog [data-action="confirm"] button'));
  assert.ok(at('declare') > at('restart') && at('declare') < at('complete'));
  assert.equal(db.audit.filter((entry) => entry.kind === 'reject_line_claim').length, 1);
  assert.deepEqual(db.calledNumbers.slice(0, 2), [7, 42]);
});

test('the scenario fails when recovery is automatic, duplicated, loses numbers, or creates an award', async () => {
  const run = (options) => scenarios.LEGACY_RECOVERY_SCENARIOS[0][1](fake(options).ctx);
  await assert.rejects(run({ autoCancel: true }));
  await assert.rejects(run({ recoverTwice: true }));
  await assert.rejects(run({ awardOnRecover: true }));
  await assert.rejects(run({ loseNumbers: true }));
});
