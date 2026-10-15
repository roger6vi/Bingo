// Node-only store fixtures for the BG-07 S2 restart/recovery acceptance preparation (#30). Deterministic and
// Electron-free: every helper operates on a caller-supplied temporary database path through createEventStore
// and prefers the public store API. The only owned raw SQL is the two held-check shapes the recovery tests
// already use (a check re-entered beside an uncompleted line presentation, and the legal legacy Bingo award
// inside checking_bingo). Every table and column mirrors tests/event-store-bingo-recovery.test.ts; none is
// invented. Helpers never close or delete anything: the caller owns the store and the temp directory.
import { DatabaseSync } from 'node:sqlite';
import { drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';

// Canonical fixture clock: strictly increasing where the raw legacy fixture needs it, reused across events
// exactly like the mirrored tests do. Exported so tests can assert identities without duplicating literals.
export const FIXTURE_TIMES = Object.freeze({
  lineAt: '2025-01-01T00:00:01.000Z',
  bingoAt: '2025-01-01T00:00:02.000Z',
  checkAt: '2025-01-01T00:00:02.000Z',
  cancelAt: '2025-01-01T00:00:03.000Z',
  legacyDeclareAt: '2025-01-01T00:00:04.000Z',
  legacyCorrectAt: '2025-01-01T00:00:05.000Z',
  legacyHeadAt: '2025-01-01T00:00:06.000Z',
  legacyCancelAt: '2025-01-01T00:00:07.000Z',
});
const LINE_PICK = { participantNumber: 2, colorId: participantColor(2).id };

function withDb(dbPath, action) {
  const db = new DatabaseSync(dbPath);
  try { return action(db); } finally { db.close(); }
}

// One event with configured lot prizes, two manual calls, a fully resolved two-winner line award and a direct
// Bingo award, mirroring event-store-bingo-presentation.test.ts:36-44 and event-store-bingo-lot-resolve
// .test.ts:18-46. With the default two winners and the non-empty Bingo lot the lot fact stays pending.
// Passing `store` declares a further event on the same database; the returned store is never closed here.
export function declaredBingoWithLot(dbPath, { name = 'A', winners = 2, store } = {}) {
  const owned = store ?? createEventStore(dbPath);
  const event = owned.createEvent({ name, date: '2025-01-01', place: 'X' });
  owned.selectEvent(event.id);
  owned.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const ball of [7, 3]) owned.update((c) => drawManual(c, ball));
  const line = owned.declareLineDirectly(owned.loadLineDeclarationBaseline(), 2, FIXTURE_TIMES.lineAt);
  owned.startLinePresentation(line.presentation.id, 1000);
  owned.completeLinePresentation(line.presentation.id, 5000);
  owned.resolveLineLot({ eventId: event.id, auditSequence: 1, presentationId: line.presentation.id }, LINE_PICK);
  const bingo = owned.declareBingoDirectly(owned.loadBingoDeclarationBaseline(), winners, FIXTURE_TIMES.bingoAt);
  return { store: owned, event, line, bingo };
}

// Resolves the current event's pending Bingo lot through the public one-shot API using the store-owned
// identity (mirrors event-store-bingo-lot-resolve.test.ts:18-46): the store resolves a Bingo lot only once its
// presentation is completed (the same rule as the Line lot), so the fixture owns the public completion steps
// first and then commits the numbered result, returning the frozen snapshot.
export function resolveLot(store) {
  const read = store.loadBingoLotResult();
  store.startBingoPresentation(read.presentation.id, 2000);
  store.completeBingoPresentation(read.presentation.id, 6000);
  const expected = { eventId: read.eventId, auditSequence: read.auditSequence, presentationId: read.presentation.id };
  return store.resolveBingoLot(expected, LINE_PICK);
}

// A held checking_bingo phase on an event with a declared line award, mirroring the recovery setup default:
// two direct state calls, a one-winner line award with a completed presentation, then the public check
// transition. The default path is public API only. `lineLotPending` leaves the line presentation uncompleted
// and re-enters the check through the owned raw shape the recovery tests already use (the modern generic gate
// forbids that transition publicly). `bingoAwardInCheck` additionally installs the legacy Bingo award fixture
// recovery must refuse; it requires the default path. The returned store is never closed here.
export function heldCheckingBingo(dbPath, { lineLotPending = false, bingoAwardInCheck = false } = {}) {
  if (lineLotPending && bingoAwardInCheck) {
    throw new Error('bingoAwardInCheck requires the default public-API held check path');
  }
  const store = createEventStore(dbPath);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const ball of [2, 9]) store.update((s) => ({ calledNumbers: [...s.calledNumbers, ball] }));
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 1, FIXTURE_TIMES.lineAt);
  if (lineLotPending) {
    withDb(dbPath, (db) => {
      db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
        VALUES (?, 2, ?, 'begin_bingo_check', 'line_declared', 'checking_bingo')`).run(event.id, FIXTURE_TIMES.checkAt);
      db.prepare("UPDATE events SET phase = 'checking_bingo', lastTransitionAt = ? WHERE id = ?")
        .run(FIXTURE_TIMES.checkAt, event.id);
    });
  } else {
    store.startLinePresentation(line.presentation.id, 1000);
    store.completeLinePresentation(line.presentation.id, 5000);
    store.transitionPhase('begin_bingo_check', FIXTURE_TIMES.checkAt);
  }
  if (bingoAwardInCheck) legacyBingoAwardInCheck(dbPath, event.id);
  return { store, event, line };
}

// Owned raw fixture mirroring event-store-bingo-recovery.test.ts:139-153: a valid direct Bingo award created
// through a legal correction and a fresh check re-entered afterwards, so a later cancellation must be refused.
function legacyBingoAwardInCheck(dbPath, eventId) {
  withDb(dbPath, (db) => {
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 3, ?, 'reject_bingo_claim', 'checking_bingo', 'line_declared')`).run(eventId, FIXTURE_TIMES.cancelAt);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 4, ?, 'declare_bingo_directly', 'line_declared', 'bingo_declared')`).run(eventId, FIXTURE_TIMES.legacyDeclareAt);
    db.prepare(`INSERT INTO bingo_awards (event_id, audit_sequence, winner_count, total_cents, share_cents,
      remainder_cents, lot, lot_resolution, presentation_id, presentation_status)
      VALUES (?, 4, 1, 1000, 1000, 0, '', 'not_required', 'b-1', 'pending')`).run(eventId);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 5, ?, 'correct_bingo_declaration', 'bingo_declared', 'line_declared')`).run(eventId, FIXTURE_TIMES.legacyCorrectAt);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 6, ?, 'begin_bingo_check', 'line_declared', 'checking_bingo')`).run(eventId, FIXTURE_TIMES.legacyHeadAt);
    db.prepare("UPDATE events SET phase = 'checking_bingo', lastTransitionAt = ? WHERE id = ?")
      .run(FIXTURE_TIMES.legacyHeadAt, eventId);
  });
}

// Every table, row by row, so a refused or completed step can be compared byte-for-byte (mirrors
// event-store-bingo-lot-resolve.test.ts:59-63). With `withoutPresentation` the four Bingo presentation
// columns are dropped so only non-presentation facts count, as in event-store-bingo-presentation.test.ts:45.
const BINGO_PRESENTATION_COLUMNS = ['presentation_id', 'presentation_status', 'presentation_started_at', 'presentation_deadline'];
export function readRawRows(dbPath, { withoutPresentation = false } = {}) {
  return withDb(dbPath, (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()
      .map((row) => withoutPresentation && name === 'bingo_awards'
        ? Object.fromEntries(Object.entries(row).filter(([key]) => !BINGO_PRESENTATION_COLUMNS.includes(key)))
        : row)])));
}
