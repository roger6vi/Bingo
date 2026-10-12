import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* Already closed by the test. */ } }
  for (const d of directories) fs.rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-bingo-lot-resolve-'));
  directories.push(directory);
  return join(directory, 'event.sqlite');
}
type Store = ReturnType<typeof createEventStore>;
// The BG-06A API is looked up dynamically so the first RED run reports behaviour, not a type error.
type Bingo = Store & { loadBingoLotResult(): any; resolveBingoLot(expected: unknown, result: unknown): any };
function open(path: string): Bingo {
  const store = createEventStore(path) as Bingo;
  stores.push(store);
  return store;
}
function withDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}
const LINE_AT = '2025-01-01T00:00:01.000Z';
const BINGO_AT = '2025-01-01T00:00:02.000Z';
const pick = (n: number) => ({ participantNumber: n, colorId: participantColor(n).id });

// A fully resolved first line followed by a tied pending Bingo award; `complete` closes its presentation.
function tiedBingo(path: string, over: { winners?: number; complete?: boolean } = {}) {
  const store = open(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const n of [7, 3]) store.update((c) => drawManual(c, n));
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 2, LINE_AT);
  store.startLinePresentation(line.presentation.id, 1000);
  store.completeLinePresentation(line.presentation.id, 5000);
  store.resolveLineLot({ eventId: event.id, auditSequence: 1, presentationId: line.presentation.id }, pick(2));
  const bingo = store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), over.winners ?? 2, BINGO_AT);
  if (over.complete !== false) {
    store.startBingoPresentation(bingo.presentation.id, 2000);
    store.completeBingoPresentation(bingo.presentation.id, 6000);
  }
  return { store, event, bingo };
}
function identity(store: Bingo) {
  const read = store.loadBingoLotResult();
  return { eventId: read.eventId, auditSequence: read.auditSequence, presentationId: read.presentation.id };
}
// Full durable dump so every refusal must leave every table byte-identical.
function durable(path: string) {
  return withDb(path, (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()])));
}
const refuses = (action: () => unknown, label?: string) =>
  assert.throws(action, (e: Error) => e instanceof Error && !/not a function/.test(e.message), label);
const untouched = (path: string, before: unknown, label?: string) => assert.deepEqual(durable(path), before, label);

test('BG-06A commits one numbered_v1 result for a tied pending lot and rereads it equal', () => {
  const path = fixture();
  const { store, event } = tiedBingo(path);
  const before = durable(path);
  const request = pick(2);
  const committed = store.resolveBingoLot(identity(store), request);
  (request as { participantNumber: number }).participantNumber = 1;
  assert.deepEqual(committed, store.loadBingoLotResult());
  assert.deepEqual(committed.fact, { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
    participantNumber: 2, colorId: participantColor(2).id });
  assert.ok(Object.isFrozen(committed) && Object.isFrozen(committed.fact) && Object.isFrozen(committed.presentation));
  assert.equal(committed.eventId, event.id);
  // Only the four result columns changed; calls, phase, audit, prizes, line award and presentation are intact.
  const after = durable(path);
  const { bingo_awards: a, ...rest } = after as Record<string, any>;
  const { bingo_awards: b, ...restBefore } = before as Record<string, any>;
  assert.deepEqual(rest, restBefore);
  assert.deepEqual({ ...a[0], lot_resolution: 0, lot_result_origin: 0, lot_participant_number: 0, lot_color_id: 0 },
    { ...b[0], lot_resolution: 0, lot_result_origin: 0, lot_participant_number: 0, lot_color_id: 0 });
  assert.equal(a[0].lot_resolution, 'resolved');
  // A repeated attempt refuses and leaves the committed state untouched.
  const committedState = durable(path);
  refuses(() => store.resolveBingoLot(identity(store), pick(1)), 'already numbered');
  untouched(path, committedState, 'already numbered');
  store.close();
  const reopened = open(path);
  assert.deepEqual(reopened.loadBingoLotResult(), committed);
});

test('BG-06A refuses ineligible requests and leaves storage byte-identical', () => {
  const ineligible: Record<string, (path: string) => Bingo> = {
    // User decision 1: the Bingo lot resolves only once its presentation is completed, same rule as Line.
    'presentation pending (decision 1)': (p) => tiedBingo(p, { complete: false }).store,
    'presentation started (decision 1)': (p) => {
      const t = tiedBingo(p, { complete: false });
      t.store.startBingoPresentation(t.bingo.presentation.id, 9000);
      return t.store;
    },
    'presentation interrupted': (p) => {
      const t = tiedBingo(p, { complete: false });
      t.store.startBingoPresentation(t.bingo.presentation.id, 2000);
      t.store.interruptStartedBingoPresentations();
      return t.store;
    },
    'presentation failed': (p) => {
      const t = tiedBingo(p, { complete: false });
      t.store.failBingoPresentation(t.bingo.presentation.id);
      return t.store;
    },
    'lot not tied': (p) => tiedBingo(p, { winners: 1 }).store,
  };
  for (const [name, make] of Object.entries(ineligible)) {
    const path = fixture();
    const store = make(path);
    const before = durable(path);
    refuses(() => store.resolveBingoLot(identity(store), pick(2)), name);
    untouched(path, before, name);
  }
  // Legacy provenance is frozen: the migration alone may have created it, and it can never be resolved.
  const path = fixture();
  const { store } = tiedBingo(path);
  // Legacy provenance is frozen: the migration alone may have created it, and it can never be resolved. Drop the
  // retarget guard only to write that controlled shape, exactly like the v8/v11 line and bingo fixtures do.
  withDb(path, (db) => {
    db.exec('DROP TRIGGER bingo_awards_no_legacy_update');
    db.exec(`UPDATE bingo_awards SET lot_result_origin = 'legacy_v8', lot_resolution = 'resolved'`);
  });
  const legacyState = durable(path);
  refuses(() => store.resolveBingoLot(identity(store), pick(2)), 'legacy provenance');
  untouched(path, legacyState, 'legacy provenance');
});

test('BG-06A refuses stale or malformed identity and result input without any durable change', () => {
  const path = fixture();
  const { store } = tiedBingo(path);
  const good = identity(store);
  const before = durable(path);
  const bad: Record<string, [unknown, unknown]> = {
    'wrong audit': [{ ...good, auditSequence: 99 }, pick(2)],
    'wrong presentation': [{ ...good, presentationId: 'other' }, pick(2)],
    'wrong event': [{ ...good, eventId: 'other' }, pick(2)],
    'bad audit type': [{ ...good, auditSequence: '1' }, pick(2)],
    'extra identity key': [{ ...good, extra: 1 }, pick(2)],
    'missing identity key': [{ eventId: good.eventId, auditSequence: good.auditSequence }, pick(2)],
    'null identity': [null, pick(2)],
    'array identity': [[], pick(2)],
    'accessor identity': [Object.defineProperty({ ...good }, 'eventId', { get: () => good.eventId, enumerable: true }), pick(2)],
    'number zero': [good, { participantNumber: 0, colorId: participantColor(1).id }],
    'above winners': [good, { participantNumber: 3, colorId: participantColor(3).id }],
    'fractional number': [good, { participantNumber: 1.5, colorId: participantColor(1).id }],
    'string number': [good, { participantNumber: '2', colorId: participantColor(2).id }],
    'wrong color': [good, { participantNumber: 2, colorId: participantColor(1).id }],
    'missing color': [good, { participantNumber: 2 }],
    'extra result key': [good, { ...pick(2), winner: true }],
    'null result': [good, null],
    'array result': [good, []],
    'accessor result': [Object.defineProperty({ colorId: participantColor(2).id }, 'participantNumber',
      { get: () => 2, enumerable: true }), pick(2)],
  };
  for (const [name, [expected, result]] of Object.entries(bad)) {
    refuses(() => store.resolveBingoLot(expected, result), name);
    untouched(path, before, name);
  }
  // A switched active event refuses the old identity, and the old event is untouched.
  store.selectEvent(store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' }).id);
  const switched = durable(path);
  refuses(() => store.resolveBingoLot(good, pick(2)), 'switched event');
  untouched(path, switched, 'switched event');
});

test('line lot resolution is unchanged: the same commit fact and the same refusals', () => {
  const path = fixture();
  const store = open(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
  for (const n of [7, 3]) store.update((c) => drawManual(c, n));
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 2, LINE_AT);
  store.startLinePresentation(line.presentation.id, 1000);
  store.completeLinePresentation(line.presentation.id, 5000);
  const expected = { eventId: event.id, auditSequence: 1, presentationId: line.presentation.id };
  const committed = store.resolveLineLot(expected, pick(2));
  assert.deepEqual(committed, store.loadLineLotResult());
  assert.deepEqual(committed!.fact, { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
    participantNumber: 2, colorId: participantColor(2).id });
  const before = durable(path);
  refuses(() => store.resolveLineLot(expected, pick(1)), 'already numbered');
  refuses(() => store.resolveLineLot({ ...expected, auditSequence: 9 }, pick(2)), 'stale audit');
  assert.deepEqual(store.loadLineLotResult(), committed);
  untouched(path, before, 'line refusals');
});

test('a database with missing or malformed bingo provenance guards is rejected on open without writing', () => {
  const directory = fs.realpathSync(join(fixture(), '..'));
  const corrupt = (name: string, sql: string) => {
    const file = join(directory, `guards-${name}.sqlite`);
    createEventStore(file).close();
    withDb(file, (db) => db.exec(sql));
    const before = durable(file);
    assert.throws(() => createEventStore(file), /bingo_awards provenance guard/i, name);
    assert.deepEqual(durable(file), before, name);
  };
  corrupt('missing', 'DROP TRIGGER bingo_awards_no_legacy_update');
  corrupt('malformed', `DROP TRIGGER bingo_awards_no_legacy_insert;
    CREATE TRIGGER bingo_awards_no_legacy_insert BEFORE UPDATE ON bingo_awards
    BEGIN SELECT RAISE(ABORT, 'replaced'); END`);
});
