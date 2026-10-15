import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawDigital, drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* Already closed by the test. */ } }
  for (const d of directories) fs.rmSync(d, { recursive: true, force: true });
});
function open(path: string) {
  const store = createEventStore(path);
  stores.push(store);
  return store;
}
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-bingo-presentation-'));
  directories.push(directory);
  return join(directory, 'event.sqlite');
}
function withDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}
type Store = ReturnType<typeof createEventStore>;
const LINE_AT = '2025-01-01T00:00:01.000Z';
const BINGO_AT = '2025-01-01T00:00:02.000Z';
const PRESENTATION = ['presentation_id', 'presentation_status', 'presentation_started_at', 'presentation_deadline'];

// A new active event with a delivered line and a direct Bingo; two winners leave the Bingo lot pending (tied).
function declaredBingo(store: Store, name: string, winners = 2) {
  const event = store.createEvent({ name, date: '2025-01-01', place: 'X' });
  store.selectEvent(event.id);
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: '' }, bingo: { amount: 10, lot: 'Jamón' } });
  store.update((c) => drawManual(c, 7));
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 1, LINE_AT);
  store.startLinePresentation(line.presentation.id, 1000);
  store.completeLinePresentation(line.presentation.id, 5000);
  return { event, bingo: store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), winners, BINGO_AT) };
}
// Every table, row by row; `facts` drops only the Bingo presentation columns so anything else changing is visible.
function dump(path: string, facts = false) {
  return withDb(path, (db) => JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${String(name)} ORDER BY rowid`).all().map((row) =>
      facts && name === 'bingo_awards'
        ? Object.fromEntries(Object.entries(row).filter(([key]) => !PRESENTATION.includes(key))) : row)])));
}
const rows = (path: string) => withDb(path, (db) => db.prepare(`SELECT event_id AS e, presentation_id AS id,
  presentation_status AS status, presentation_started_at AS startedAt, presentation_deadline AS deadlineAt
  FROM bingo_awards ORDER BY rowid`).all().map((row) => ({ ...row })));

test('pending start then complete at the deadline keeps bingo_declared, both draws blocked and the tied lot pending', () => {
  const path = fixture();
  const store = open(path);
  const { bingo } = declaredBingo(store, 'A');
  const facts = dump(path, true);
  assert.equal(bingo.presentation.status, 'pending');
  const started = store.startBingoPresentation(bingo.presentation.id, 10_000);
  assert.deepEqual({ ...started.presentation }, { id: bingo.presentation.id, status: 'started', startedAt: 10_000, deadlineAt: 14_000 });
  const before = dump(path);
  assert.throws(() => store.completeBingoPresentation(bingo.presentation.id, 13_999), /deadline not reached/i);
  assert.equal(dump(path), before);
  const done = store.completeBingoPresentation(bingo.presentation.id, 14_000);
  assert.deepEqual({ ...done.presentation }, { id: bingo.presentation.id, status: 'completed', startedAt: 10_000, deadlineAt: 14_000 });
  assert.deepEqual({ ...store.loadBingoAward()?.presentation }, { ...done.presentation });
  assert.equal(store.loadBingoAward()?.award.lotResolution, 'pending');
  assert.equal(store.load()?.phase, 'bingo_declared');
  assert.throws(() => store.update((c) => drawManual(c, 9)), /not allowed/i);
  assert.throws(() => store.update((c) => drawDigital(c, () => 0)), /not allowed/i);
  assert.throws(() => store.completeBingoPresentation(bingo.presentation.id, 20_000), /invalid presentation transition/i);
  assert.equal(dump(path, true), facts);
});

test('pending fails, a manual retry is pending under a new id, the old id is dead and started cannot fail', () => {
  const path = fixture();
  const store = open(path);
  const { bingo } = declaredBingo(store, 'A');
  const facts = dump(path, true);
  const failed = store.failBingoPresentation(bingo.presentation.id);
  assert.deepEqual({ ...failed.presentation }, { id: bingo.presentation.id, status: 'failed', startedAt: null, deadlineAt: null });
  const retried = store.retryBingoPresentation(bingo.presentation.id);
  assert.equal(retried.presentation.status, 'pending');
  assert.notEqual(retried.presentation.id, bingo.presentation.id);
  assert.throws(() => store.startBingoPresentation(bingo.presentation.id, 1), /not the current one/i);
  const id = retried.presentation.id;
  store.startBingoPresentation(id, 50);
  const started = dump(path);
  // Same graph as the line: a started run only completes or is interrupted at startup.
  assert.throws(() => store.failBingoPresentation(id), /invalid presentation transition: started via fail/i);
  assert.equal(dump(path), started);
  assert.equal(store.completeBingoPresentation(id, 4050).presentation.status, 'completed');
  assert.equal(store.load()?.phase, 'bingo_declared');
  assert.equal(dump(path, true), facts);
});

test('an interrupted run replays only on explicit request, under a new id, and never completes the old one', () => {
  const path = fixture();
  const store = open(path);
  const { bingo } = declaredBingo(store, 'A');
  store.startBingoPresentation(bingo.presentation.id, 100);
  assert.equal(store.interruptStartedBingoPresentations(), 1);
  assert.deepEqual({ ...store.loadBingoAward()?.presentation },
    { id: bingo.presentation.id, status: 'interrupted', startedAt: 100, deadlineAt: 4100 });
  assert.throws(() => store.completeBingoPresentation(bingo.presentation.id, 9000), /invalid presentation transition/i);
  const replayed = store.replayBingoPresentation(bingo.presentation.id);
  assert.deepEqual({ ...replayed.presentation, id: 'x' }, { id: 'x', status: 'pending', startedAt: null, deadlineAt: null });
  assert.notEqual(replayed.presentation.id, bingo.presentation.id);
  assert.throws(() => store.completeBingoPresentation(bingo.presentation.id, 9000), /not the current one/i);
});

test('stale ids, illegal transitions and bad times are refused without writing anything', () => {
  const path = fixture();
  const store = open(path);
  const { bingo } = declaredBingo(store, 'A');
  const id = bingo.presentation.id;
  const before = dump(path);
  const refusals: Array<[() => unknown, RegExp]> = [
    [() => store.startBingoPresentation('other', 1), /not the current one/i],
    [() => store.startBingoPresentation('', 1), /invalid bingo presentation id/i],
    [() => store.startBingoPresentation(id, -1), /safe epoch/i],
    [() => store.startBingoPresentation(id, 1.5), /safe epoch/i],
    [() => store.startBingoPresentation(id, Number.MAX_SAFE_INTEGER), /safe epoch/i],
    [() => store.startBingoPresentation(id, '1'), /safe epoch/i],
    [() => store.retryBingoPresentation(id), /invalid presentation transition/i],
    [() => store.replayBingoPresentation(id), /invalid presentation transition/i],
    [() => store.completeBingoPresentation(id, 1e9), /invalid presentation transition/i],
    [() => store.completeBingoPresentation(id, -5), /safe epoch/i],
  ];
  for (const [action, pattern] of refusals) {
    assert.throws(action, pattern);
    assert.equal(dump(path), before);
  }
  store.startBingoPresentation(id, 1);
  const started = dump(path);
  assert.throws(() => store.startBingoPresentation(id, 2), /invalid presentation transition/i);
  assert.throws(() => store.retryBingoPresentation(id), /invalid presentation transition/i);
  assert.equal(dump(path), started);
});

test('restart: open never plays or rewrites; explicit reconciliation fails pending and interrupts started across events', () => {
  const path = fixture();
  const store = open(path);
  const a = declaredBingo(store, 'A');
  store.startBingoPresentation(a.bingo.presentation.id, 100);
  const b = declaredBingo(store, 'B', 1);
  const c = declaredBingo(store, 'C');
  store.startBingoPresentation(c.bingo.presentation.id, 200);
  store.completeBingoPresentation(c.bingo.presentation.id, 4200);
  const d = declaredBingo(store, 'D');
  store.failBingoPresentation(d.bingo.presentation.id);
  const e = declaredBingo(store, 'E');
  store.startBingoPresentation(e.bingo.presentation.id, 300);
  store.close();
  const initial = rows(path);
  const reopened = open(path);
  reopened.selectEvent(a.event.id);
  assert.deepEqual(rows(path), initial);
  assert.equal(reopened.loadBingoAward()?.presentation.status, 'started');
  const facts = dump(path, true);
  assert.equal(reopened.interruptStartedBingoPresentations(), 2);
  assert.equal(reopened.failPendingBingoPresentations(), 1);
  const expected = initial.map((row) => ({ ...row,
    status: row.status === 'started' ? 'interrupted' : row.status === 'pending' ? 'failed' : row.status }));
  assert.deepEqual(rows(path), expected);
  assert.deepEqual(rows(path).map((row) => row.status), ['interrupted', 'failed', 'completed', 'failed', 'interrupted']);
  assert.equal(dump(path, true), facts);
  const settled = dump(path);
  assert.equal(reopened.interruptStartedBingoPresentations(), 0);
  assert.equal(reopened.failPendingBingoPresentations(), 0);
  assert.equal(dump(path), settled);
  assert.equal(b.bingo.award.lotResolution, 'not_required');
});

test('a corrupt later row rolls the whole reconciliation back, for started and pending batches', () => {
  for (const status of ['started', 'pending'] as const) {
    const path = fixture();
    const store = open(path);
    const ids = ['A', 'B'].map((name, index) => {
      const { id } = declaredBingo(store, name).bingo.presentation;
      if (status === 'started') store.startBingoPresentation(id, index * 10);
      return id;
    });
    withDb(path, (db) => db.exec(`PRAGMA ignore_check_constraints = 1;
      UPDATE bingo_awards SET share_cents = 1 WHERE presentation_id = '${ids[1]}'`));
    const before = dump(path);
    const reconcile = status === 'started'
      ? () => store.interruptStartedBingoPresentations() : () => store.failPendingBingoPresentations();
    assert.throws(reconcile, /invalid stored bingo award/i);
    assert.equal(dump(path), before);
    assert.deepEqual(rows(path).map((row) => row.status), [status, status]);
  }
});
