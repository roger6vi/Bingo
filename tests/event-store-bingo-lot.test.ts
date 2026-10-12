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
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-bingo-lot-'));
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
// Full durable dump so a migration or a rejected read must leave every untouched table byte-identical.
function durable(path: string) {
  return withDb(path, (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()])));
}
const schemaOf = (db: DatabaseSync) => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
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

test('a fresh database carries the bingo lot provenance columns and anti-legacy guards', () => {
  const path = fixture();
  createEventStore(path).close();
  assert.ok(EVENT_SCHEMA_VERSION >= 11, 'schema version');
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'bingo_awards'").get()?.sql);
    for (const fragment of ['lot_result_origin', 'lot_participant_number', 'lot_color_id', "'numbered_v1'"]) {
      assert.ok(sql.includes(fragment), fragment);
    }
    for (const name of ['bingo_awards_no_legacy_insert', 'bingo_awards_no_legacy_update']) {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(name)?.n, 1, name);
    }
  });
});

// A bingo_awards table exactly as v10 wrote it, test-local so the fixture stays frozen: no provenance columns or guards.
const range = (name: string, low: number, high: number) =>
  `CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN ${low} AND ${high})`;
const timeCheck = (name: string) =>
  `CHECK (${name} IS NULL OR typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})`;
const V10_BINGO_AWARDS = `CREATE TABLE bingo_awards (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES events(id),
  audit_sequence INTEGER NOT NULL ${range('audit_sequence', 1, Number.MAX_SAFE_INTEGER)},
  winner_count INTEGER NOT NULL ${range('winner_count', 1, Number.MAX_SAFE_INTEGER)},
  total_cents INTEGER NOT NULL ${range('total_cents', 0, 10_000_000)},
  share_cents INTEGER NOT NULL ${range('share_cents', 0, 10_000_000)},
  remainder_cents INTEGER NOT NULL ${range('remainder_cents', 0, 10_000_000)},
  lot TEXT NOT NULL CHECK (typeof(lot) = 'text' AND lot = trim(lot) AND length(lot) <= 120),
  lot_resolution TEXT NOT NULL CHECK (lot_resolution IN ('not_required', 'pending', 'resolved')),
  presentation_id TEXT NOT NULL UNIQUE CHECK (typeof(presentation_id) = 'text' AND length(trim(presentation_id)) > 0),
  presentation_status TEXT NOT NULL CHECK (presentation_status IN ('pending', 'failed', 'started', 'completed', 'interrupted')),
  presentation_started_at INTEGER ${timeCheck('presentation_started_at')},
  presentation_deadline INTEGER ${timeCheck('presentation_deadline')},
  CHECK (share_cents = total_cents / winner_count AND remainder_cents = total_cents % winner_count),
  CHECK (CASE WHEN lot = '' OR winner_count < 2 THEN lot_resolution = 'not_required'
    ELSE lot_resolution IN ('pending', 'resolved') END),
  CHECK (CASE WHEN presentation_status IN ('pending', 'failed')
    THEN presentation_started_at IS NULL AND presentation_deadline IS NULL
    ELSE presentation_started_at IS NOT NULL AND presentation_deadline IS NOT NULL AND
      presentation_deadline > presentation_started_at END),
  FOREIGN KEY (event_id, audit_sequence) REFERENCES phase_audit(event_id, sequence)
)`;
const AWARD_COLUMNS = ['event_id', 'audit_sequence', 'winner_count', 'total_cents', 'share_cents', 'remainder_cents',
  'lot', 'lot_resolution', 'presentation_id', 'presentation_status', 'presentation_started_at', 'presentation_deadline'];

// Two settled events whose tied Bingo awards are rewritten as a closed v10 database: one pending lot, one resolved.
function frozenV10(path: string): string[] {
  const store = open(path);
  const ids = [{ name: 'A', resolved: false }, { name: 'B', resolved: true }].map(({ name, resolved }) => {
    const event = store.createEvent({ name, date: '2025-01-01', place: 'X' });
    store.selectEvent(event.id);
    store.updateEventPrizes(event.id, { line: { amount: 5, lot: 'Cesta' }, bingo: { amount: 10, lot: 'Jamón' } });
    for (const n of [7, 3]) store.update((c) => drawManual(c, n));
    const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 2, LINE_AT);
    store.startLinePresentation(line.presentation.id, 1000);
    store.completeLinePresentation(line.presentation.id, 5000);
    store.resolveLineLot({ eventId: event.id, auditSequence: 1, presentationId: line.presentation.id }, pick(2));
    const bingo = store.declareBingoDirectly(store.loadBingoDeclarationBaseline(), 2, BINGO_AT);
    store.startBingoPresentation(bingo.presentation.id, 2000);
    store.completeBingoPresentation(bingo.presentation.id, 6000);
    return { id: event.id, resolved };
  });
  store.close();
  withDb(path, (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    const rows = db.prepare(`SELECT ${AWARD_COLUMNS.join(', ')} FROM bingo_awards ORDER BY rowid`).all();
    db.exec(`DROP TABLE bingo_awards; ${V10_BINGO_AWARDS}`);
    for (const [index, row] of rows.entries()) {
      db.prepare(`INSERT INTO bingo_awards (${AWARD_COLUMNS.join(', ')})
        VALUES (${AWARD_COLUMNS.map((n) => `:${n}`).join(', ')})`)
        .run({ ...row, lot_resolution: ids[index].resolved ? 'resolved' : 'pending' } as never);
    }
    db.exec('PRAGMA user_version = 10');
  });
  return ids.map(({ id }) => id);
}

test('a genuine v10 to v11 migration preserves bingo rows, labels resolved provenance and installs guards', () => {
  const path = fixture();
  const ids = frozenV10(path);
  const dump = () => withDb(path, (db) => db.prepare('SELECT * FROM bingo_awards ORDER BY presentation_id').all());
  // The v10 file before any open: every award row and every surrounding table, to compare after the migration.
  const before = durable(path);
  function read(): unknown[] {
    const store = open(path);
    try {
      return ids.map((id) => {
        store.selectEvent(id);
        const lot = store.loadBingoLotResult()!;
        return { ...lot, fact: { ...lot.fact } };
      });
    } finally { store.close(); }
  }
  const first = read();
  withDb(path, (db) => {
    // Opening fully migrates the database, so it reports the current version; the v11 provenance facts follow.
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.ok(EVENT_SCHEMA_VERSION >= 11, 'schema version');
    assert.match(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'bingo_awards'").get()?.sql),
      /lot_result_origin/);
    for (const row of dump()) {
      assert.deepEqual([row.lot_result_origin, row.lot_participant_number, row.lot_color_id],
        [row.lot_resolution === 'resolved' ? 'legacy_v8' : 'none', null, null], row.presentation_id);
    }
  });
  assert.deepEqual((first[0] as { fact: unknown }).fact, { origin: 'none', resolution: 'pending' });
  assert.deepEqual((first[1] as { fact: unknown }).fact,
    { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' });
  const rows = dump();
  withDb(path, (db) => {
    // The v11 guards survived the migration: legacy provenance cannot be forged or retargeted.
    assert.throws(() => db.exec(`UPDATE bingo_awards SET lot = 'Otro' WHERE lot_resolution = 'resolved'`), /legacy/i);
    assert.throws(() => db.exec(`INSERT INTO bingo_awards SELECT * FROM bingo_awards WHERE lot_resolution = 'resolved'`), /legacy/i);
  });
  assert.deepEqual(read(), first);
  assert.deepEqual(dump(), rows);
  // Every original field and row survives; only the three provenance columns are added, and no other table moves.
  const after = durable(path);
  const { bingo_awards: migrated, ...rest } = after as Record<string, any>;
  const { bingo_awards: original, ...restBefore } = before as Record<string, any>;
  assert.deepEqual(rest, restBefore);
  assert.deepEqual(migrated.map(({ lot_result_origin: o, lot_participant_number: n, lot_color_id: c, ...row }) => row),
    original.map((row) => ({ ...row })));
});

// The rebuild re-checks every constraint and foreign key, so any malformed v10 row aborts (and rolls back) the whole
// migration instead of being repaired; the closed v10 file keeps its schema, version and rows exactly as they were.
test('a failed v10 to v11 rebuild rolls back schema, version and rows without writing', () => {
  for (const corrupt of ['share_cents = 1', "event_id = 'ghost'"]) {
    const path = fixture();
    frozenV10(path);
    withDb(path, (db) => db.exec(`PRAGMA ignore_check_constraints = ON; PRAGMA foreign_keys = OFF;
      UPDATE bingo_awards SET ${corrupt} WHERE rowid = (SELECT MIN(rowid) FROM bingo_awards)`));
    const before = durable(path);
    let schema: unknown;
    withDb(path, (db) => { schema = schemaOf(db); });
    assert.throws(() => createEventStore(path), /constraint|CHECK|FOREIGN/i, corrupt);
    withDb(path, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 10, corrupt);
      assert.deepEqual(schemaOf(db), schema, corrupt);
    });
    assert.deepEqual(durable(path), before, corrupt);
  }
});

const CORRUPT: Record<string, string> = {
  'unknown origin': "lot_result_origin = 'future'",
  'empty origin': "lot_result_origin = ''",
  'none resolved': "lot_resolution = 'resolved'",
  'none with number': 'lot_participant_number = 1',
  'legacy pending': "lot_result_origin = 'legacy_v8'",
  'legacy with number': "lot_result_origin = 'legacy_v8', lot_resolution = 'resolved', lot_participant_number = 1",
  'numbered pending': `lot_result_origin = 'numbered_v1', lot_resolution = 'pending',
    lot_participant_number = 2, lot_color_id = '${participantColor(2).id}'`,
  'numbered not completed': `lot_result_origin = 'numbered_v1', lot_resolution = 'resolved',
    lot_participant_number = 2, lot_color_id = '${participantColor(2).id}', presentation_status = 'interrupted'`,
  'numbered above winners': `lot_result_origin = 'numbered_v1', lot_resolution = 'resolved',
    lot_participant_number = 3, lot_color_id = '${participantColor(3).id}'`,
  'unknown color': `lot_result_origin = 'numbered_v1', lot_resolution = 'resolved',
    lot_participant_number = 2, lot_color_id = 'teal'`,
};

test('validated bingo lot reads reject corrupt provenance without rewriting rows', () => {
  for (const [name, set] of Object.entries(CORRUPT)) {
    const path = fixture();
    const { store } = tiedBingo(path);
    withDb(path, (db) => {
      db.exec('PRAGMA ignore_check_constraints = 1');
      // Only the legacy-forgery guard blocks writing legacy rows; other states keep the store reopenable.
      if (set.includes("'legacy_v8'")) {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'bingo_awards'").all()) {
          db.exec(`DROP TRIGGER ${row.name}`);
        }
      }
      db.exec(`UPDATE bingo_awards SET ${set}`);
    });
    const before = durable(path);
    assert.throws(() => store.loadBingoLotResult(), /Invalid stored bingo award/, name);
    assert.throws(() => store.loadBingoAward(), /Invalid stored bingo award/, name);
    assert.doesNotThrow(() => store.load(), name);
    // The rejected reads rewrite nothing: every table keeps its exact rows.
    assert.deepEqual(durable(path), before, name);
  }
});
