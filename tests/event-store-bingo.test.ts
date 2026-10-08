import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createEventStore, EVENT_SCHEMA_VERSION } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';

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
type Bingo = Store & { loadBingoAward(): any };
const LINE_AT = '2025-01-01T00:00:01.000Z';
const BINGO_AT = '2025-01-01T00:00:02.000Z';

// A committed, fully resolved first line: completed presentation and a settled lot. `resolve` settles a tied lot.
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
const state = (store: Bingo) => JSON.stringify({ e: store.load(), a: store.readAudit(), l: store.loadLineAward(), b: store.loadBingoAward() });
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


// READ-VALIDATION fixture, NOT atomic-writer evidence: the atomic declaration API arrives in a later slice, so the
// consistent phase + direct audit row + Bingo award records are written with raw SQL in the owned temporary database.
function rawDeclareBingo(path: string, eventId: string, over: Record<string, unknown> = {}) {
  withDb(path, (db) => {
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 2, ?, 'declare_bingo_directly', 'line_declared', 'bingo_declared')`).run(eventId, BINGO_AT);
    db.prepare("UPDATE events SET phase = 'bingo_declared', lastTransitionAt = ? WHERE id = ?").run(BINGO_AT, eventId);
    const row = { event_id: eventId, audit_sequence: 2, winner_count: 3, total_cents: 1000, share_cents: 333,
      remainder_cents: 1, lot: 'Jamón', lot_resolution: 'pending', presentation_id: 'b-1',
      presentation_status: 'pending', ...over };
    db.prepare(`INSERT INTO bingo_awards (${Object.keys(row).join(', ')})
      VALUES (${Object.keys(row).map((k) => `:${k}`).join(', ')})`).run(row as never);
  });
}

test('read validation: a raw consistent direct declaration reads back frozen, detached and identity-free', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  assert.equal(store.loadBingoAward(), null);
  rawDeclareBingo(path, event.id);
  const award = store.loadBingoAward();
  assert.ok(Object.isFrozen(award) && Object.isFrozen(award.award) && Object.isFrozen(award.presentation));
  assert.deepEqual({ eventId: award.eventId, ...award.award, ...award.presentation }, { eventId: event.id, winnerCount: 3,
    totalCents: 1000, shareCents: 333, remainderCents: 1, lot: 'Jamón', lotResolution: 'pending', id: 'b-1',
    status: 'pending', startedAt: null, deadlineAt: null });
  assert.notEqual(store.loadBingoAward(), award);
  assert.deepEqual(store.load(), { calledNumbers: [7, 3], phase: 'bingo_declared', lastTransitionAt: BINGO_AT });
  assert.equal(Object.keys(bingoRow(path)[0]).some((k) => /claimant|name|winner_id/.test(k)), false);
  store.close();
  assert.deepEqual(open(path).loadBingoAward(), award); // restart reads the same facts
  assert.equal(open(path).loadLineAward()?.presentation.status, 'completed');
});

test('read validation: a stored pending lot later resolved is accepted and keeps the audit', () => {
  const path = fixture();
  const { store, event } = resolvedLine(path);
  rawDeclareBingo(path, event.id);
  const audit = JSON.stringify(store.readAudit());
  withDb(path, (db) => db.exec("UPDATE bingo_awards SET lot_resolution = 'resolved'"));
  assert.equal(store.loadBingoAward().award.lotResolution, 'resolved');
  assert.equal(JSON.stringify(store.readAudit()), audit);
});

test('read validation: corrupt or missing award/audit linkage fails closed on reopen, in both directions', () => {
  const corruptions: Array<[string, (db: DatabaseSync) => void]> = [
    ['audit entry without its award', (db) => db.exec('DELETE FROM bingo_awards')],
    ['wrong audit link', (db) => db.exec('UPDATE bingo_awards SET audit_sequence = 1')],
    ['share mismatch', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec('UPDATE bingo_awards SET share_cents = 1'); }],
    ['lot', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec("UPDATE bingo_awards SET lot_resolution = 'not_required'"); }],
    ['presentation', (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec("UPDATE bingo_awards SET presentation_status = 'started'"); }],
  ];
  for (const [label, corrupt] of corruptions) {
    const path = fixture();
    const { store, event } = resolvedLine(path);
    rawDeclareBingo(path, event.id);
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
