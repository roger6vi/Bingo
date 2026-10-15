import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { createEventStore } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';
import { transitionPhase } from '../src/game-phase.ts';

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* A test closed it already. */ } }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const path = () => { const dir = mkdtempSync(join(tmpdir(), 'bingo-recovery-')); dirs.push(dir); return join(dir, 'event.sqlite'); };
type Store = ReturnType<typeof createEventStore>;
const open = (file: string) => { const store = createEventStore(file) as Store; stores.push(store); return store; };
function sql(file: string, action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try { action(db); } finally { db.close(); }
}
const L = '2025-01-01T00:00:01.000Z';
const C = '2025-01-01T00:00:02.000Z';
const R = '2025-01-01T00:00:03.000Z';
const LATER = '2025-01-01T00:00:04.000Z';
function setup(opts: { line?: 'missing' | 'pending' | 'resolved' | 'tied'; calls?: number[] } = {}) {
  const file = path(), store = open(file);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const ball of opts.calls ?? [2, 9]) store.update((s) => ({ calledNumbers: [...s.calledNumbers, ball] }));
  if (opts.line === 'missing') {
    store.transitionPhase('begin_line_check', L);
    store.transitionPhase('declare_line', '2025-01-01T00:00:01.500Z');
    store.transitionPhase('begin_bingo_check', C);
  } else {
    const award = store.declareLineDirectly(store.loadLineDeclarationBaseline(), opts.line === 'tied' ? 2 : 1, L);
    if (opts.line !== 'pending') {
      store.startLinePresentation(award.presentation.id, 1000);
      store.completeLinePresentation(award.presentation.id, 5000);
    }
    if (opts.line === 'tied') store.resolveLineLot({ eventId: event.id, auditSequence: 1,
      presentationId: award.presentation.id }, { participantNumber: 2, colorId: participantColor(2).id });
    if (opts.line === 'pending') {
      // Owned legacy fixture: the modern generic gate forbids opening an unresolved line check.
      sql(file, (db) => {
        db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
          VALUES (?, 2, ?, 'begin_bingo_check', 'line_declared', 'checking_bingo')`).run(event.id, C);
        db.prepare("UPDATE events SET phase = 'checking_bingo', lastTransitionAt = ? WHERE id = ?").run(C, event.id);
      });
    } else store.transitionPhase('begin_bingo_check', C);
  }
  return { file, store, event };
}
// Raw rows are read directly so corrupt storage can still be compared byte-for-byte after a refused operation.
type Rows = Record<'events' | 'audit' | 'line' | 'bingo' | 'prizes', unknown[]>;
function rowsOnly(file: string): Rows {
  let rows = {} as Rows;
  sql(file, (db) => { rows = { events: db.prepare('SELECT * FROM events').all(), audit: db.prepare('SELECT * FROM phase_audit').all(),
    line: db.prepare('SELECT * FROM line_awards').all(), bingo: db.prepare('SELECT * FROM bingo_awards').all(),
    prizes: db.prepare('SELECT * FROM event_prizes').all() }; });
  return rows;
}
// Facts a cancellation must keep exactly: line and Bingo award rows (provenance, presentation) and prizes.
const kept = ({ line, bingo, prizes }: Rows) => ({ line, bingo, prizes });
const facts = Object.assign((s: Store, file: string) => ({ state: s.load(), audit: s.readAudit(), line: s.loadLineAward(),
  bingo: s.loadBingoAward(), prizes: s.loadPrizes(), rows: rowsOnly(file) }), { rowsOnly });

test('recovery reuses the pure reject_bingo_claim intent; a legacy check exposes its exact frozen identity', () => {
  assert.equal(transitionPhase({ phase: 'checking_bingo' }, 'reject_bingo_claim').phase, 'line_declared');
  const { store, event } = setup();
  const identity = store.loadLegacyBingoCheck();
  assert.ok(Object.isFrozen(identity));
  assert.deepEqual({ ...identity }, { eventId: event.id, phase: 'checking_bingo', lastTransitionAt: C, auditSequence: 2 });
});
test('missing historical line recovers with zero calls, but direct Bingo still needs a real award', () => {
  const { store, file } = setup({ line: 'missing', calls: [] });
  const identity = store.loadLegacyBingoCheck();
  assert.deepEqual(Object.keys(identity), ['eventId', 'phase', 'lastTransitionAt', 'auditSequence']);
  assert.ok(Object.isFrozen(identity));
  assert.equal(store.confirmLegacyBingoCancel(identity, R), 'unchanged');
  const before = facts(store, file);
  assert.deepEqual(store.cancelLegacyBingoCheck(identity, R).calledNumbers, []);
  assert.equal(store.load()?.phase, 'line_declared');
  assert.equal(store.confirmLegacyBingoCancel(identity, R), 'recovered');
  assert.deepEqual(kept(facts(store, file).rows), kept(before.rows));
  assert.equal(store.readAudit().at(-1)?.kind, 'reject_bingo_claim');
  assert.throws(() => store.loadBingoDeclarationBaseline(), /not eligible/i);
  store.close();
  assert.equal(open(file).load()?.phase, 'line_declared');
});
test('pending and fully resolved line facts survive cancellation exactly; later declaration only follows resolved line', () => {
  for (const line of ['pending', 'resolved', 'tied'] as const) {
    const { store, file } = setup({ line });
    const before = facts(store, file), identity = store.loadLegacyBingoCheck();
    store.cancelLegacyBingoCheck(identity, R);
    const after = facts(store, file);
    assert.deepEqual(kept(after.rows), kept(before.rows), line);
    assert.deepEqual(after.line, before.line, line);
    assert.deepEqual(after.state?.calledNumbers, before.state?.calledNumbers, line);
    if (line === 'pending') assert.throws(() => store.loadBingoDeclarationBaseline(), /not eligible/i);
    else assert.equal(store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 1, LATER).award.winnerCount, 1);
  }
});
test('reopen is read-only and no recovery occurs automatically', () => {
  const { file, store } = setup();
  const before = facts(store, file);
  store.close();
  const reopened = open(file);
  assert.deepEqual(facts(reopened, file), before);
  assert.equal(reopened.loadLegacyBingoCheck().phase, 'checking_bingo');
});
test('stale, duplicate and re-entered checks cannot cancel; confirmation is bound to time and active event', () => {
  const { file, store, event } = setup();
  const identity = store.loadLegacyBingoCheck();
  const before = facts(store, file);
  for (const wrong of [{ ...identity, auditSequence: identity.auditSequence - 1 },
    { ...identity, lastTransitionAt: L }, { ...identity, eventId: 'foreign' }]) {
    assert.throws(() => store.cancelLegacyBingoCheck(wrong, R));
    assert.equal(store.confirmLegacyBingoCancel(wrong, R), 'stale');
  }
  for (const time of [C, 'bad']) assert.throws(() => store.cancelLegacyBingoCheck(identity, time));
  assert.deepEqual(facts(store, file), before);
  assert.equal(store.confirmLegacyBingoCancel(identity, LATER), 'unchanged');
  store.cancelLegacyBingoCheck(identity, R);
  assert.equal(store.confirmLegacyBingoCancel(identity, LATER), 'stale');
  assert.throws(() => store.cancelLegacyBingoCheck(identity, LATER));
  store.transitionPhase('begin_bingo_check', LATER);
  assert.equal(store.confirmLegacyBingoCancel(identity, R), 'stale');
  assert.throws(() => store.cancelLegacyBingoCheck(identity, '2025-01-01T00:00:05.000Z'));
  const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.selectEvent(other.id);
  assert.equal(store.confirmLegacyBingoCancel(identity, R), 'stale');
  store.selectEvent(event.id);
});
test('invalid exact identity and no-current-event are not silently eligible', () => {
  const empty = open(path());
  assert.throws(() => empty.loadLegacyBingoCheck(), /not eligible/i);
  const { store } = setup();
  const id = store.loadLegacyBingoCheck();
  for (const bad of [{ ...id, extra: 1 }, { ...id, auditSequence: 0 }, { ...id, phase: 'line_declared' }, null]) {
    assert.throws(() => store.cancelLegacyBingoCheck(bad, R), /Invalid legacy bingo check identity/);
  }
});
test('phase and audit failures roll back; writer contention and COMMIT-time reader lock leave facts unchanged', () => {
  for (const trigger of ["CREATE TRIGGER boom BEFORE UPDATE ON events WHEN NEW.phase = 'line_declared' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    "CREATE TRIGGER boom BEFORE INSERT ON phase_audit WHEN NEW.kind = 'reject_bingo_claim' BEGIN SELECT RAISE(ABORT, 'boom'); END"]) {
    const { file, store } = setup();
    const id = store.loadLegacyBingoCheck(), before = facts(store, file);
    sql(file, (db) => db.exec(trigger));
    assert.throws(() => store.cancelLegacyBingoCheck(id, R), /boom/);
    assert.deepEqual(facts(store, file), before);
  }
  const { file, store } = setup();
  const id = store.loadLegacyBingoCheck(), before = facts(store, file);
  const writer = new DatabaseSync(file);
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.throws(() => store.cancelLegacyBingoCheck(id, R), /locked|busy/i);
    writer.exec('ROLLBACK');
  } finally { writer.close(); }
  assert.deepEqual(facts(store, file), before);
  const reader = new DatabaseSync(file);
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM events').all();
    assert.throws(() => store.cancelLegacyBingoCheck(id, R), /locked|busy/i);
    reader.exec('ROLLBACK');
  } finally { reader.close(); }
  assert.deepEqual(facts(store, file), before);
  store.cancelLegacyBingoCheck(id, R);
  assert.equal(store.confirmLegacyBingoCancel(id, R), 'recovered');
});
// Owned SQL fixture: create a valid direct Bingo award, then re-enter a check through a legal correction.
function existingBingoAwardInCheck(file: string, eventId: string) {
  const event = { id: eventId };
  sql(file, (db) => {
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 3, ?, 'reject_bingo_claim', 'checking_bingo', 'line_declared')`).run(event.id, R);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 4, ?, 'declare_bingo_directly', 'line_declared', 'bingo_declared')`).run(event.id, LATER);
    db.prepare(`INSERT INTO bingo_awards (event_id, audit_sequence, winner_count, total_cents, share_cents,
      remainder_cents, lot, lot_resolution, presentation_id, presentation_status)
      VALUES (?, 4, 1, 1000, 1000, 0, '', 'not_required', 'b-1', 'pending')`).run(event.id);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 5, ?, 'correct_bingo_declaration', 'bingo_declared', 'line_declared')`)
      .run(event.id, '2025-01-01T00:00:05.000Z');
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 6, ?, 'begin_bingo_check', 'line_declared', 'checking_bingo')`)
      .run(event.id, '2025-01-01T00:00:06.000Z');
    db.prepare("UPDATE events SET phase = 'checking_bingo', lastTransitionAt = ? WHERE id = ?")
      .run('2025-01-01T00:00:06.000Z', event.id);
  });
}
const forged = (eventId: string) =>
  ({ eventId, phase: 'checking_bingo', lastTransitionAt: '2025-01-01T00:00:06.000Z', auditSequence: 6 });
test('valid Bingo award during checking_bingo refuses recovery, without changing any facts', () => {
  const { file, store, event } = setup();
  existingBingoAwardInCheck(file, event.id);
  const before = facts(store, file);
  const refused = (e: Error & { code?: string }) =>
    /not eligible.*award/i.test(e.message) && e.code === 'legacy_bingo_check_not_eligible';
  assert.throws(() => store.loadLegacyBingoCheck(), refused);
  // A forged identity matching the head is refused by both the writer and the confirmation, without writes.
  assert.throws(() => store.cancelLegacyBingoCheck(forged(event.id), '2025-01-01T00:00:07.000Z'), refused);
  assert.throws(() => store.confirmLegacyBingoCancel(forged(event.id), '2025-01-01T00:00:07.000Z'), refused);
  assert.deepEqual(facts(store, file), before);
});
test('a corrupt present line beside a valid Bingo award is invalid storage, never a typed refusal', () => {
  const { file, store, event } = setup();
  existingBingoAwardInCheck(file, event.id);
  sql(file, (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec('UPDATE line_awards SET share_cents = 1'); });
  const rows = JSON.stringify(rowsOnly(file));
  const corruptError = (e: Error & { code?: string }) => /Invalid stored line award/.test(e.message) && e.code === undefined;
  assert.throws(() => store.loadLegacyBingoCheck(), corruptError);
  assert.throws(() => store.cancelLegacyBingoCheck(forged(event.id), '2025-01-01T00:00:07.000Z'), corruptError);
  assert.throws(() => store.confirmLegacyBingoCancel(forged(event.id), '2025-01-01T00:00:07.000Z'), corruptError);
  assert.equal(JSON.stringify(rowsOnly(file)), rows);
});
test('corrupt line or Bingo storage fails closed untyped for load, cancel and confirmation, without writes', () => {
  for (const corrupt of ['UPDATE line_awards SET share_cents = 1',
    "INSERT INTO bingo_awards (event_id, audit_sequence, winner_count, total_cents, share_cents, remainder_cents, lot, lot_resolution, presentation_id, presentation_status) SELECT event_id, 1, 1, 1000, 1000, 0, '', 'not_required', 'x', 'pending' FROM line_awards"]) {
    const { file, store } = setup();
    const identity = store.loadLegacyBingoCheck();
    sql(file, (db) => { db.exec('PRAGMA ignore_check_constraints = 1'); db.exec(corrupt); });
    const rows = JSON.stringify(facts.rowsOnly(file));
    const corruptError = (e: Error & { code?: string }) => /Invalid/.test(e.message) && e.code === undefined;
    assert.throws(() => store.loadLegacyBingoCheck(), corruptError, corrupt);
    assert.throws(() => store.cancelLegacyBingoCheck(identity, R), corruptError, corrupt);
    assert.throws(() => store.confirmLegacyBingoCancel(identity, R), corruptError, corrupt);
    assert.equal(JSON.stringify(facts.rowsOnly(file)), rows, corrupt);
  }
});
