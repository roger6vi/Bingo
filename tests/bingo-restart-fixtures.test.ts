// Store-level proof for the BG-07 S2 restart/recovery fixture unit (#30): the Node-only helpers in
// verification/bingo-restart-fixtures.mjs are driven against real temporary databases through
// createEventStore. Same-path reopen and startup reconciliation must keep the award identity and lot fact
// stable, and a held checking_bingo must expose its frozen identity and cancel back to line_declared.
// No Electron is launched and no real profile is touched: every directory is created under the OS temp dir
// with the bingo-fixture- prefix and only those directories are removed.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createEventStore } from '../src/event-store.ts';
import {
  declaredBingoWithLot,
  FIXTURE_TIMES as TIMES,
  heldCheckingBingo,
  readRawRows,
  resolveLot,
} from '../verification/bingo-restart-fixtures.mjs';

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* Already closed by the test. */ } }
  for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-fixture-'));
  directories.push(directory);
  return join(directory, 'event.sqlite');
}
type Store = ReturnType<typeof createEventStore>;
function open(path: string): Store {
  const store = createEventStore(path);
  stores.push(store);
  return store;
}
// Facts a restart or a cancellation must keep exactly: line award, Bingo award, prizes (provenance included).
const kept = (rows: Record<string, unknown[]>) =>
  Object.fromEntries(['line_awards', 'bingo_awards', 'event_prizes'].map((t) => [t, rows[t]]));

test('reopening the same path keeps the award identity, presentation and resolved lot fact exactly', () => {
  const path = fixture();
  const first = declaredBingoWithLot(path);
  stores.push(first.store);
  const committed = resolveLot(first.store);
  assert.equal(committed.fact.resolution, 'resolved');
  const before = { award: first.store.loadBingoAward(), lot: first.store.loadBingoLotResult(),
    audit: first.store.readAudit(), rows: readRawRows(path) };
  first.store.close();
  const reopened = open(path);
  reopened.selectEvent(first.event.id);
  assert.deepEqual({ award: reopened.loadBingoAward(), lot: reopened.loadBingoLotResult(),
    audit: reopened.readAudit() }, { award: before.award, lot: before.lot, audit: before.audit });
  assert.deepEqual(readRawRows(path), before.rows);
});

test('startup reconciliation interrupts started and fails pending without rerolling lots or writing audit', () => {
  const path = fixture();
  const started = declaredBingoWithLot(path, { name: 'A' });
  stores.push(started.store);
  started.store.startBingoPresentation(started.bingo.presentation.id, 100);
  const pending = declaredBingoWithLot(path, { name: 'B', store: started.store });
  const store = started.store;
  const lots = new Map(), audits = new Map();
  for (const event of [started.event, pending.event]) {
    store.selectEvent(event.id);
    // Only the durable lot fact is pinned here: the snapshot's presentation status is exactly what the
    // reconciliation legitimately rotates (started -> interrupted, pending -> failed).
    lots.set(event.id, store.loadBingoLotResult()?.fact);
    audits.set(event.id, store.readAudit());
  }
  const facts = readRawRows(path, { withoutPresentation: true });
  store.close();
  const reopened = open(path);
  assert.deepEqual(readRawRows(path, { withoutPresentation: true }), facts);
  assert.equal(reopened.interruptStartedBingoPresentations(), 1);
  assert.equal(reopened.failPendingBingoPresentations(), 1);
  for (const [event, status] of [[started.event, 'interrupted'], [pending.event, 'failed']] as const) {
    reopened.selectEvent(event.id);
    const award = reopened.loadBingoAward();
    assert.equal(award?.presentation.status, status, status);
    assert.equal(award?.award.lotResolution, 'pending', status);
    assert.equal(award?.award.winnerCount, 2, status);
    assert.deepEqual(reopened.loadBingoLotResult()?.fact, lots.get(event.id), status);
    assert.deepEqual(reopened.readAudit(), audits.get(event.id), status);
  }
  assert.deepEqual(readRawRows(path, { withoutPresentation: true }), facts);
});

test('a held check exposes the frozen identity and cancellation returns to line_declared preserving facts', () => {
  const path = fixture();
  const held = heldCheckingBingo(path);
  stores.push(held.store);
  const identity = held.store.loadLegacyBingoCheck();
  assert.ok(Object.isFrozen(identity));
  assert.deepEqual({ ...identity }, { eventId: held.event.id, phase: 'checking_bingo',
    lastTransitionAt: TIMES.checkAt, auditSequence: 2 });
  const before = { line: held.store.loadLineAward(), prizes: held.store.loadPrizes(),
    calls: held.store.load()?.calledNumbers, rows: readRawRows(path) };
  held.store.cancelLegacyBingoCheck(identity, TIMES.cancelAt);
  assert.equal(held.store.load()?.phase, 'line_declared');
  assert.deepEqual({ line: held.store.loadLineAward(), prizes: held.store.loadPrizes(),
    calls: held.store.load()?.calledNumbers }, { line: before.line, prizes: before.prizes, calls: before.calls });
  assert.deepEqual(kept(readRawRows(path)), kept(before.rows));
  assert.equal(held.store.readAudit().at(-1)?.kind, 'reject_bingo_claim');
});

test('a check re-entered beside a pending line award (owned raw shape) still cancels and preserves facts', () => {
  const path = fixture();
  const held = heldCheckingBingo(path, { lineLotPending: true });
  stores.push(held.store);
  const identity = held.store.loadLegacyBingoCheck();
  const before = readRawRows(path);
  held.store.cancelLegacyBingoCheck(identity, TIMES.cancelAt);
  assert.equal(held.store.load()?.phase, 'line_declared');
  assert.deepEqual(kept(readRawRows(path)), kept(before));
});

test('a legacy Bingo award inside checking_bingo refuses recovery without changing any fact', () => {
  const path = fixture();
  const held = heldCheckingBingo(path, { bingoAwardInCheck: true });
  stores.push(held.store);
  const before = readRawRows(path);
  const refused = (error: Error & { code?: string }) =>
    /not eligible.*award/i.test(error.message) && error.code === 'legacy_bingo_check_not_eligible';
  assert.throws(() => held.store.loadLegacyBingoCheck(), refused);
  const forged = { eventId: held.event.id, phase: 'checking_bingo', lastTransitionAt: TIMES.legacyHeadAt,
    auditSequence: 6 };
  assert.throws(() => held.store.cancelLegacyBingoCheck(forged, TIMES.legacyCancelAt), refused);
  assert.throws(() => held.store.confirmLegacyBingoCancel(forged, TIMES.legacyCancelAt), refused);
  assert.deepEqual(readRawRows(path), before);
});
