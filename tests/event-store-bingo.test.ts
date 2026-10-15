import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawDigital, drawManual } from '../src/event-core.ts';
import { createEventStore, EVENT_SCHEMA_VERSION } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';
import { transitionPhase } from '../src/game-phase.ts';

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* Already closed by the test. */ } }
  for (const d of directories) fs.rmSync(d, { recursive: true, force: true });
});
// Every store a test opens is closed at the end of the file, even when an assertion fails first.
function open(path: string): Bingo {
  const store = createEventStore(path) as Bingo;
  stores.push(store);
  return store;
}
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-bingo-'));
  directories.push(directory);
  return join(directory, 'event.sqlite');
}
function withDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}

type Store = ReturnType<typeof createEventStore>;
// The bingo API under test is looked up dynamically so the first RED run reports behaviour, not a type error.
type Bingo = Store & {
  loadBingoDeclarationBaseline(): any;
  declareBingoDirectly(expected: unknown, winnerCount: unknown, at: unknown): any;
  loadBingoAward(): any;
  confirmBingoDeclaration(expected: unknown, winnerCount: unknown, at: unknown): any;
};
const LINE_AT = '2025-01-01T00:00:01.000Z';
const BINGO_AT = '2025-01-01T00:00:02.000Z';

// A committed, fully resolved first line: completed presentation and a settled lot. `tied` leaves the lot pending.
function resolvedLine(path: string, over: { calls?: number[]; lineWinners?: number; resolve?: boolean; complete?: boolean } = {}) {
  const store = open(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const n of over.calls ?? [7, 3]) store.update((c) => drawManual(c, n));
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), over.lineWinners ?? 1, LINE_AT);
  if (over.complete !== false) {
    store.startLinePresentation(line.presentation.id, 1000);
    store.completeLinePresentation(line.presentation.id, 5000);
    if (over.resolve) store.resolveLineLot({ eventId: event.id, auditSequence: 1, presentationId: line.presentation.id },
      { participantNumber: 2, colorId: participantColor(2).id });
  }
  return { store, event, line };
}
const state = (store: Bingo) => JSON.stringify({ e: store.load(), a: store.readAudit(), l: store.loadLineAward(), b: store.loadBingoAward?.() ?? null });
const bingoRow = (path: string) => withDb(path, (db) => db.prepare('SELECT * FROM bingo_awards').all());

test('fresh database is the new schema and keeps it across repeated restarts', () => {
  const path = fixture();
  createEventStore(path).close();
  for (let i = 0; i < 3; i += 1) createEventStore(path).close();
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'bingo_awards'").get()?.n, 1);
  });
  assert.ok(EVENT_SCHEMA_VERSION >= 10);
});

test('schema 9 migrates preserving audit, line award, calls, prizes and a legacy checking_bingo opening', () => {
  const path = fixture();
  const { store, event, line } = resolvedLine(path);
  store.transitionPhase('begin_bingo_check', BINGO_AT); // legacy opening stays readable and untouched
  const before = state(store);
  store.close();
  withDb(path, (db) => db.exec('DROP TABLE bingo_awards; PRAGMA user_version = 9'));
  for (let i = 0; i < 2; i += 1) {
    const reopened = open(path);
    assert.equal(state(reopened), before);
    assert.equal(reopened.load()?.phase, 'checking_bingo');
    assert.deepEqual(reopened.loadPrizes()?.prizes.bingo, { amount: 10, lot: 'Jamón' });
    assert.equal(reopened.loadLineAward()?.presentation.id, line.presentation.id);
    assert.equal(reopened.loadBingoAward(), null);
    assert.equal(event.id, reopened.loadLineAward()?.eventId);
    reopened.close();
  }
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION));
});

test('one winner commits phase, audit and award atomically from the persisted prize', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  assert.ok(Object.isFrozen(baseline) && Object.isFrozen(baseline.calledNumbers));
  assert.deepEqual(baseline.calledNumbers, [7, 3]);
  const award = store.declareBingoDirectly(baseline, 1, BINGO_AT);
  assert.ok(Object.isFrozen(award) && Object.isFrozen(award.award) && Object.isFrozen(award.presentation));
  assert.equal(award.eventId, event.id);
  assert.deepEqual({ ...award.award }, { winnerCount: 1, totalCents: 1000, shareCents: 1000, remainderCents: 0,
    lot: 'Jamón', lotResolution: 'not_required' });
  assert.equal(award.presentation.status, 'pending');
  assert.ok(award.presentation.id.length > 0);
  assert.equal(JSON.stringify(Object.keys(award)), JSON.stringify(['eventId', 'award', 'presentation']));
  assert.deepEqual(store.load(), { calledNumbers: [7, 3], phase: 'bingo_declared', lastTransitionAt: BINGO_AT });
  assert.deepEqual(store.readAudit().at(-1), { sequence: 2, transitionAt: BINGO_AT, kind: 'declare_bingo_directly',
    from_phase: 'line_declared', to_phase: 'bingo_declared' });
  store.close();
  const again = open(path);
  assert.deepEqual(again.loadBingoAward(), award);
  assert.notEqual(again.loadBingoAward(), again.loadBingoAward());
  assert.equal(again.loadLineAward()?.presentation.status, 'completed');
  assert.equal(bingoRow(path).length, 1);
  assert.equal(Object.keys(bingoRow(path)[0]).some((k) => /claimant|name|winner_id/.test(k)), false);
});

test('three winners split cents deterministically and persist a pending indivisible lot', () => {
  const { store } = resolvedLine(fixture());
  const award = store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 3, BINGO_AT);
  assert.deepEqual({ ...award.award }, { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1,
    lot: 'Jamón', lotResolution: 'pending' });
  assert.equal(award.presentation.status, 'pending');
  assert.equal(store.loadBingoAward().award.lotResolution, 'pending');
});

test('a zero-history event with a valid resolved line may declare bingo', () => {
  const { store } = resolvedLine(fixture(), { calls: [], lineWinners: 2, resolve: true });
  const award = store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 1, BINGO_AT);
  assert.equal(award.award.winnerCount, 1);
  assert.deepEqual(store.load()?.calledNumbers, []);
});

test('missing, unresolved, tied-pending and legacy lines refuse and leave storage unchanged', () => {
  const drawing = open(fixture());
  drawing.create();
  assert.throws(() => drawing.loadBingoDeclarationBaseline(), /not eligible/i);

  const legacyPath = fixture();
  const legacy = open(legacyPath);
  legacy.create();
  legacy.transitionPhase('begin_line_check', LINE_AT);
  legacy.transitionPhase('declare_line', BINGO_AT);
  assert.equal(legacy.load()?.phase, 'line_declared');
  const legacyState = state(legacy);
  assert.throws(() => legacy.loadBingoDeclarationBaseline(), /not eligible/i);
  assert.equal(state(legacy), legacyState);

  for (const over of [{ complete: false }, { lineWinners: 2 }]) {
    const { store } = resolvedLine(fixture(), over);
    const snapshot = state(store);
    assert.throws(() => store.loadBingoDeclarationBaseline(), /not eligible/i);
    assert.equal(state(store), snapshot);
  }
  // A forged baseline cannot bypass the gate.
  const { store } = resolvedLine(fixture(), { lineWinners: 2 });
  const good = resolvedLine(fixture()).store.loadBingoDeclarationBaseline();
  assert.throws(() => store.declareBingoDirectly({ ...good }, 1, BINGO_AT));
  assert.equal(store.loadBingoAward(), null);
});

test('stale event, prize, calls, phase/audit and line-resolution baselines refuse unchanged', () => {
  const mutations: Array<[string, (store: Bingo, path: string) => void]> = [
    ['calls', (store) => { store.update((c) => drawManual(c, 40)); }],
    ['prizes', (store) => { store.updateEventPrizes(store.loadBingoDeclarationBaseline().eventId,
      { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 11, lot: 'Jamón' } }); }],
    ['phase and audit', (store) => { store.transitionPhase('begin_bingo_check', BINGO_AT); }],
    ['line resolution', (_s, path) => withDb(path, (db) => db.exec("UPDATE line_awards SET presentation_id = 'other'"))],
    ['event', (store) => { store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
      store.selectEvent(store.listEvents().find((e) => !e.active)?.id); }],
  ];
  for (const [label, mutate] of mutations) {
    const path = fixture();
    const { store } = resolvedLine(path);
    const baseline = store.loadBingoDeclarationBaseline();
    mutate(store, path);
    const snapshot = state(store);
    assert.throws(() => store.declareBingoDirectly(baseline, 1, BINGO_AT), undefined, label);
    assert.equal(state(store), snapshot, label);
    assert.equal(bingoRow(path).length, 0, label);
  }
});

test('invalid inputs and non-advancing timestamps refuse unchanged', () => {
  const { store } = resolvedLine(fixture());
  const baseline = store.loadBingoDeclarationBaseline();
  const snapshot = state(store);
  for (const count of [0, -1, 1.5, Number.NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.declareBingoDirectly(baseline, count, BINGO_AT));
  }
  for (const at of [LINE_AT, '2024-01-01T00:00:00.000Z', 'nope', 3]) {
    assert.throws(() => store.declareBingoDirectly(baseline, 1, at));
  }
  assert.throws(() => store.declareBingoDirectly({ ...baseline, extra: 1 }, 1, BINGO_AT));
  assert.equal(state(store), snapshot);
});

test('phase, audit and award write failures each roll everything back', () => {
  const failures: Array<[string, string]> = [
    ['phase', "CREATE TRIGGER boom BEFORE UPDATE ON events WHEN NEW.phase = 'bingo_declared' BEGIN SELECT RAISE(ABORT, 'boom'); END"],
    ['audit', "CREATE TRIGGER boom BEFORE INSERT ON phase_audit WHEN NEW.kind = 'declare_bingo_directly' BEGIN SELECT RAISE(ABORT, 'boom'); END"],
    ['award', 'CREATE TRIGGER boom BEFORE INSERT ON bingo_awards BEGIN SELECT RAISE(ABORT, \'boom\'); END'],
  ];
  for (const [label, trigger] of failures) {
    const path = fixture();
    const { store } = resolvedLine(path);
    const baseline = store.loadBingoDeclarationBaseline();
    const snapshot = state(store);
    withDb(path, (db) => db.exec(trigger));
    assert.throws(() => store.declareBingoDirectly(baseline, 3, BINGO_AT), /boom/, label);
    assert.equal(state(store), snapshot, label);
    withDb(path, (db) => db.exec('DROP TRIGGER boom'));
    assert.equal(store.declareBingoDirectly(baseline, 3, BINGO_AT).award.winnerCount, 3, label);
  }
});

test('SQLite writer contention fails closed and a later attempt succeeds exactly once', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  const snapshot = state(store);
  const other = new DatabaseSync(path);
  try {
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => store.declareBingoDirectly(baseline, 1, BINGO_AT), /locked|busy/i);
    other.exec('ROLLBACK');
  } finally { other.close(); }
  assert.equal(state(store), snapshot);
  store.declareBingoDirectly(baseline, 1, BINGO_AT);
  assert.equal(bingoRow(path).length, 1);
});

test('a duplicate declaration is refused and never adds a second audit row or award', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  const first = store.declareBingoDirectly(baseline, 3, BINGO_AT);
  const snapshot = state(store);
  assert.throws(() => store.declareBingoDirectly(baseline, 3, '2025-01-01T00:00:03.000Z'));
  assert.throws(() => store.loadBingoDeclarationBaseline(), /not eligible/i);
  assert.equal(state(store), snapshot);
  assert.deepEqual(store.loadBingoAward(), first);
  assert.equal(store.readAudit().filter((e) => e.kind === 'declare_bingo_directly').length, 1);
});

test('uncertain-result reread is bound to the same snapshot and never declares', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  const unchanged = store.confirmBingoDeclaration(baseline, 1, BINGO_AT);
  assert.equal(unchanged.state, 'unchanged');
  assert.equal(store.loadBingoAward(), null);
  const award = store.declareBingoDirectly(baseline, 1, BINGO_AT);
  const confirmed = store.confirmBingoDeclaration(baseline, 1, BINGO_AT);
  assert.equal(confirmed.state, 'declared');
  assert.deepEqual(confirmed.award, award);
  // Different count, time or calls are not this declaration.
  assert.equal(store.confirmBingoDeclaration(baseline, 2, BINGO_AT).state, 'stale');
  assert.equal(store.confirmBingoDeclaration(baseline, 1, '2025-01-01T00:00:09.000Z').state, 'stale');
  assert.equal(store.confirmBingoDeclaration({ ...baseline, calledNumbers: [7] }, 1, BINGO_AT).state, 'stale');
  assert.equal(store.readAudit().filter((e) => e.kind === 'declare_bingo_directly').length, 1);
});

test('a foreign active event is never acknowledged as the declared one', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 1, BINGO_AT);
  const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.selectEvent(other.id);
  assert.equal(store.confirmBingoDeclaration(baseline, 1, BINGO_AT).state, 'stale');
  assert.equal(store.loadBingoAward(), null);
});

test('corrupt or missing award/audit linkage fails closed on reopen', () => {
  const corruptions: Array<[string, (db: DatabaseSync) => void]> = [
    ['missing award', (db) => db.exec('DELETE FROM bingo_awards')],
    ['wrong audit link', (db) => db.exec('UPDATE bingo_awards SET audit_sequence = 1')],
    ['share mismatch', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec('UPDATE bingo_awards SET share_cents = 1'); }],
    ['lot', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec("UPDATE bingo_awards SET lot_resolution = 'not_required'"); }],
    ['presentation', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec("UPDATE bingo_awards SET presentation_status = 'started'"); }],
  ];
  for (const [label, corrupt] of corruptions) {
    const path = fixture();
    const { store } = resolvedLine(path);
    store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 3, BINGO_AT);
    store.close();
    withDb(path, corrupt);
    assert.throws(() => createEventStore(path), undefined, label);
  }
  // An award without its direct audit row is equally invalid.
  const path = fixture();
  const { store } = resolvedLine(path);
  store.close();
  withDb(path, (db) => db.prepare(`INSERT INTO bingo_awards (event_id, audit_sequence, winner_count, total_cents,
    share_cents, remainder_cents, lot, lot_resolution, presentation_id, presentation_status)
    SELECT event_id, 1, 1, 1000, 1000, 0, 'Jamón', 'not_required', 'x', 'pending' FROM line_awards`).run());
  assert.throws(() => createEventStore(path));
});

test('both draw modes are rejected authoritatively once bingo is declared, finished, and after restart', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 1, BINGO_AT);
  const attempts = (s: Bingo) => {
    const snapshot = state(s);
    assert.throws(() => s.update((c) => drawManual(c, 50)), /not allowed/i);
    assert.throws(() => s.update((c) => drawDigital(c, () => 0)), /not allowed/i);
    // The store itself refuses, even for a transition that skips the domain draw rules.
    assert.throws(() => s.update((c) => ({ calledNumbers: [...c.calledNumbers, 50] })), /after bingo/i);
    assert.equal(state(s), snapshot);
  };
  attempts(store);
  store.close();
  const restarted = open(path);
  attempts(restarted);
  assert.equal(restarted.load()?.phase, 'bingo_declared'); // no automatic finish
  restarted.transitionPhase('finish', '2025-01-01T00:00:05.000Z');
  attempts(restarted);
  assert.equal(restarted.load()?.phase, 'finished');
});

test('legacy bingo_declared events also reject both draw modes', () => {
  const { store } = resolvedLine(fixture());
  store.transitionPhase('begin_bingo_check', BINGO_AT);
  store.transitionPhase('declare_bingo', '2025-01-01T00:00:03.000Z');
  const snapshot = state(store);
  assert.throws(() => store.update((c) => drawManual(c, 50)), /not allowed/i);
  assert.throws(() => store.update((c) => drawDigital(c, () => 0)), /not allowed/i);
  assert.throws(() => store.update((c) => ({ calledNumbers: [...c.calledNumbers, 50] })), /after bingo/i);
  assert.equal(state(store), snapshot);
});

test('pure direct intent remains replayable while the generic store transition still rejects it', () => {
  assert.equal(transitionPhase({ phase: 'line_declared' }, 'declare_bingo_directly').phase, 'bingo_declared');
  const { store } = resolvedLine(fixture());
  const snapshot = state(store);
  assert.throws(() => store.transitionPhase('declare_bingo_directly', BINGO_AT), /atomic award path/);
  assert.equal(state(store), snapshot);
});

// ---- confirmBingoDeclaration binds the WHOLE expected baseline, not just the event, calls and head ----
type Mutation = [string, (baseline: any) => any];
const altered: Mutation[] = [
  ['bingo prize euros', (b) => ({ ...b, bingoPrize: { ...b.bingoPrize, amount: b.bingoPrize.amount + 1 } })],
  ['bingo prize lot', (b) => ({ ...b, bingoPrize: { ...b.bingoPrize, lot: 'Otro' } })],
  ['line audit identity', (b) => ({ ...b, line: { ...b.line, auditSequence: b.line.auditSequence + 1 } })],
  ['line presentation identity', (b) => ({ ...b, line: { ...b.line, presentationId: 'other' } })],
  ['line resolution', (b) => ({ ...b, line: { ...b.line, lotResolution: b.line.lotResolution === 'resolved' ? 'not_required' : 'resolved' } })],
];
for (const [label, change] of altered) {
  // Altered EXPECTED values are a legitimate stale answer; storage is never written.
  test(`confirm: ${label} altered in the expected baseline is stale before the declaration`, () => {
    const path = fixture();
    const { store } = resolvedLine(path);
    const baseline = store.loadBingoDeclarationBaseline();
    const before = state(store);
    assert.equal(store.confirmBingoDeclaration(change(baseline), 3, BINGO_AT).state, 'stale');
    assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'unchanged');
    assert.equal(state(store), before);
  });
  test(`confirm: ${label} altered in the expected baseline is stale after the declaration`, () => {
    const path = fixture();
    const { store } = resolvedLine(path);
    const baseline = store.loadBingoDeclarationBaseline();
    store.declareBingoDirectly(baseline, 3, BINGO_AT);
    const before = state(store);
    assert.equal(store.confirmBingoDeclaration(change(baseline), 3, BINGO_AT).state, 'stale');
    assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'declared');
    assert.equal(state(store), before);
  });
}

test('confirm: unchanged requires the full eligible baseline, so a changed stored prize is stale', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 11, lot: 'Jamón' } });
  const before = state(store);
  assert.equal(store.confirmBingoDeclaration(baseline, 1, BINGO_AT).state, 'stale');
  assert.equal(state(store), before);
});

test('confirm: the frozen award stays acknowledged after the editable current prize changes', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  const award = store.declareBingoDirectly(baseline, 3, BINGO_AT);
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 99, lot: 'Otro' } });
  const confirmed = store.confirmBingoDeclaration(baseline, 3, BINGO_AT);
  assert.equal(confirmed.state, 'declared');
  assert.deepEqual(confirmed.award, award);
});

// Tampering with owned SQLite rows after a real declaration. Corruption (an invalid row) throws; a valid but
// different row is stale. Neither may acknowledge, and neither writes.
test('confirm: a valid line row with another presentation identity after the write is stale', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  withDb(path, (db) => db.exec("UPDATE line_awards SET presentation_id = 'other'"));
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'stale');
});
test('confirm: a valid stored award that differs from the expected prize arithmetic is stale', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  withDb(path, (db) => db.exec('UPDATE bingo_awards SET total_cents = 2000, share_cents = 666, remainder_cents = 2'));
  assert.equal(store.loadBingoAward().award.totalCents, 2000); // a valid row: only the expected-prize comparison refuses it
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'stale');
});
test('confirm: a valid stored award with another lot is stale', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  withDb(path, (db) => db.exec("UPDATE bingo_awards SET lot = 'Otro'"));
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'stale');
});
test('confirm: a missing line award after the write is stale', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  withDb(path, (db) => { db.exec('PRAGMA foreign_keys = OFF'); db.exec('DELETE FROM line_awards'); });
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'stale');
});
test('confirm: CORRUPT line storage throws instead of answering stale or declared', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  withDb(path, (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec('UPDATE line_awards SET share_cents = 1'); });
  assert.throws(() => store.confirmBingoDeclaration(baseline, 3, BINGO_AT), /Invalid stored line award/);
});
test('confirm: CORRUPT storage before the write throws as well', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  withDb(path, (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec('UPDATE line_awards SET share_cents = 1'); });
  assert.throws(() => store.confirmBingoDeclaration(baseline, 3, BINGO_AT), /Invalid stored line award/);
});

test('COMMIT-time contention: a reader holding a shared lock fails the commit and rolls back everything', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  const before = state(store);
  const reader = new DatabaseSync(path);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM events').get(); // shared lock: the writer may stage rows but cannot COMMIT
    assert.throws(() => store.declareBingoDirectly(baseline, 3, BINGO_AT), /locked|busy/i);
    reader.exec('ROLLBACK');
  } finally { reader.close(); }
  assert.equal(state(store), before);
  assert.equal(bingoRow(path).length, 0);
  assert.equal(store.declareBingoDirectly(baseline, 3, BINGO_AT).award.winnerCount, 3);
  assert.equal(bingoRow(path).length, 1);
});

// ---- the expected baseline is canonical identity: a prize lot is never silently trimmed ----
for (const lot of [' Jamón ', 'Jamón ', ' Jamón']) {
  const bad = (b: any) => ({ ...b, bingoPrize: { ...b.bingoPrize, lot } });
  test(`confirm: untrimmed expected prize lot ${JSON.stringify(lot)} is rejected as malformed before the declaration`, () => {
    const { store } = resolvedLine(fixture());
    const baseline = store.loadBingoDeclarationBaseline();
    const before = state(store);
    assert.throws(() => store.confirmBingoDeclaration(bad(baseline), 3, BINGO_AT), /Invalid bingo declaration baseline/);
    assert.equal(state(store), before);
  });
  test(`confirm: untrimmed expected prize lot ${JSON.stringify(lot)} is rejected as malformed after the declaration`, () => {
    const { store } = resolvedLine(fixture());
    const baseline = store.loadBingoDeclarationBaseline();
    store.declareBingoDirectly(baseline, 3, BINGO_AT);
    const before = state(store);
    assert.throws(() => store.confirmBingoDeclaration(bad(baseline), 3, BINGO_AT), /Invalid bingo declaration baseline/);
    assert.equal(state(store), before);
  });
  test(`declare: untrimmed expected prize lot ${JSON.stringify(lot)} is rejected before any write`, () => {
    const { store } = resolvedLine(fixture());
    const baseline = store.loadBingoDeclarationBaseline();
    const before = state(store);
    assert.throws(() => store.declareBingoDirectly(bad(baseline), 3, BINGO_AT), /Invalid bingo declaration baseline/);
    assert.equal(state(store), before);
  });
}

test('canonical and empty expected prize lots remain valid', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: '' } });
  const baseline = store.loadBingoDeclarationBaseline();
  assert.equal(baseline.bingoPrize.lot, '');
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'unchanged');
  assert.equal(store.declareBingoDirectly(baseline, 3, BINGO_AT).award.lotResolution, 'not_required');
  assert.equal(store.confirmBingoDeclaration(baseline, 3, BINGO_AT).state, 'declared');
});

// Controlled owned fixture: no public API settles a Bingo lot yet (a later unit), so the allowed pending -> resolved
// stored shape is written directly. The readback and the acknowledgment must accept it and keep the audit intact.
test('a stored pending bingo lot later resolved reads back and is still acknowledged', () => {
  const path = fixture();
  const { store } = resolvedLine(path);
  const baseline = store.loadBingoDeclarationBaseline();
  store.declareBingoDirectly(baseline, 3, BINGO_AT);
  const audit = JSON.stringify(store.readAudit());
  withDb(path, (db) => db.exec("UPDATE bingo_awards SET lot_resolution = 'resolved'"));
  assert.equal(store.loadBingoAward().award.lotResolution, 'resolved');
  const confirmed = store.confirmBingoDeclaration(baseline, 3, BINGO_AT);
  assert.equal(confirmed.state, 'declared');
  assert.equal(confirmed.award.award.lotResolution, 'resolved');
  assert.equal(JSON.stringify(store.readAudit()), audit);
});
