import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { createEventStore } from '../src/event-store.ts';
import { participantColor } from '../src/line-lot-contract.ts';

const directories: string[] = [];
after(() => { for (const d of directories) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-lot-'));
  directories.push(directory);
  return join(directory, 'event.sqlite');
}

const base = { audit_sequence: 1, winner_count: 3, total_cents: 1000, share_cents: 333, remainder_cents: 1,
  lot: 'Jamón', lot_resolution: 'pending', presentation_id: 'p-1', presentation_status: 'pending',
  presentation_started_at: null, presentation_deadline: null,
  lot_result_origin: 'none', lot_participant_number: null, lot_color_id: null };
const completed = { presentation_status: 'completed', presentation_started_at: 1000, presentation_deadline: 5000 };
const numbered = (n: number, color = participantColor(n).id) => ({ lot_resolution: 'resolved',
  lot_result_origin: 'numbered_v1', lot_participant_number: n, lot_color_id: color, ...completed });

function declareRaw(path: string, eventId: string) {
  const at = '2025-01-01T00:00:01.000Z';
  const db = new DatabaseSync(path);
  try {
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 1, ?, 'declare_line_directly', 'drawing', 'line_declared')`).run(eventId, at);
    db.prepare("UPDATE events SET phase = 'line_declared', lastTransitionAt = ? WHERE id = ?").run(at, eventId);
  } finally { db.close(); }
}
function withDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}

// Raw award on a directly declared event. Guards and CHECKs are bypassed so corrupt states can exist.
function setup(path: string, change: Record<string, unknown> = {}, id = 'p-1') {
  const store = createEventStore(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  declareRaw(path, event.id);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA ignore_check_constraints = 1');
    // Only the legacy-forgery guard blocks writing legacy rows; other states keep the store reopenable.
    if (change.lot_result_origin === 'legacy_v8') {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'line_awards'")
        .all()) db.exec(`DROP TRIGGER ${row.name}`);
    }
    const row = { ...base, ...change, presentation_id: id, event_id: event.id };
    db.prepare(`INSERT INTO line_awards (${Object.keys(row).join(', ')})
      VALUES (${Object.keys(row).map((k) => `:${k}`).join(', ')})`).run(row as never);
  } finally { db.close(); }
  return { store, event };
}

test('lot result read is null without an active event or award', () => {
  const store = createEventStore(fixture());
  try {
    assert.equal(store.loadLineLotResult(), null);
    store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    assert.equal(store.loadLineLotResult(), null);
  } finally { store.close(); }
});

test('pending and not_required expose no result with the award and presentation identity', () => {
  for (const [change, resolution] of [[{}, 'pending'],
    [{ lot: '', lot_resolution: 'not_required' }, 'not_required']] as const) {
    const { store, event } = setup(fixture(), change);
    try {
      const read = store.loadLineLotResult()!;
      assert.deepEqual(read, { eventId: event.id, auditSequence: 1, winnerCount: 3, lot: change.lot ?? 'Jamón',
        presentation: { id: 'p-1', status: 'pending' }, fact: { origin: 'none', resolution } });
      assert.ok(Object.isFrozen(read) && Object.isFrozen(read.fact) && Object.isFrozen(read.presentation));
    } finally { store.close(); }
  }
});

// A line_awards table exactly as v8 wrote it, test-local so the fixture stays frozen: no result columns or guards.
const range = (name: string, low: number, high: number) =>
  `CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN ${low} AND ${high})`;
const timeCheck = (name: string) => `CHECK (${name} IS NULL OR typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})`;
const V8_LINE_AWARDS = `CREATE TABLE line_awards (
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
const COLUMNS = Object.keys(base).filter((k) => !k.startsWith('lot_') || k === 'lot' || k === 'lot_resolution');

// Two directly declared events with awards, rewritten as a closed v8 database whose lots are resolved.
function frozenV8(path: string): string[] {
  const store = createEventStore(path);
  const ids = [{}, completed].map((shape, index) => {
    const event = store.createEvent({ name: `E${index}`, date: '2025-01-01', place: 'X' });
    declareRaw(path, event.id);
    withDb(path, (db) => {
      const row = { ...base, ...shape, presentation_id: `p-${index}`, event_id: event.id };
      const names = ['event_id', ...COLUMNS];
      db.prepare(`INSERT INTO line_awards (${names.join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`)
        .run(Object.fromEntries(names.map((n) => [n, (row as Record<string, unknown>)[n]])) as never);
    });
    return event.id;
  });
  store.close();
  withDb(path, (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    const rows = db.prepare(`SELECT event_id, ${COLUMNS.join(', ')} FROM line_awards`).all();
    db.exec(`DROP TABLE line_awards; ${V8_LINE_AWARDS}`);
    for (const row of rows) {
      db.prepare(`INSERT INTO line_awards (${Object.keys(row).join(', ')})
        VALUES (${Object.keys(row).map((n) => `:${n}`).join(', ')})`).run({ ...row, lot_resolution: 'resolved' } as never);
    }
    db.exec('PRAGMA user_version = 8');
  });
  return ids;
}

test('a genuine v8 to v9 migration keeps legacy resolved facts with an unknown winner across reopen', () => {
  const path = fixture();
  const ids = frozenV8(path);
  const dump = () => withDb(path, (db) => db.prepare('SELECT * FROM line_awards ORDER BY presentation_id').all());
  function read(): unknown[] {
    const store = createEventStore(path);
    try {
      return ids.map((id) => {
        store.selectEvent(id);
        const lot = store.loadLineLotResult()!;
        assert.deepEqual(lot.fact, { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' });
        assert.equal(store.loadLineAward()!.award.lotResolution, 'resolved');
        return { ...lot, fact: { ...lot.fact } };
      });
    } finally { store.close(); }
  }
  const first = read();
  assert.deepEqual(first.map((r) => (r as { presentation: { status: string } }).presentation.status), ['pending', 'completed']);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
    assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'line_awards'").get()?.sql), /lot_result_origin/);
    for (const row of dump()) assert.deepEqual([row.lot_result_origin, row.lot_participant_number, row.lot_color_id],
      ['legacy_v8', null, null]);
    // The v9 guards survived the migration: legacy provenance cannot be retargeted or forged.
    assert.throws(() => db.exec("UPDATE line_awards SET lot = 'Otro' WHERE presentation_id = 'p-0'"), /legacy/i);
    assert.throws(() => db.exec("UPDATE line_awards SET lot_result_origin = 'numbered_v1', lot_participant_number = 1, lot_color_id = 'red' WHERE presentation_id = 'p-0'"), /legacy/i);
  });
  const rows = dump();
  assert.deepEqual(read(), first);
  assert.deepEqual(dump(), rows);
});

test('numbered results decode boundaries and repeated colors as detached frozen facts', () => {
  const max = Number.MAX_SAFE_INTEGER;
  for (const [winners, n] of [[3, 1], [7, 7], [max, max], [max, 1]] as const) {
    const { store } = setup(fixture(), { winner_count: winners, share_cents: Math.floor(1000 / winners),
      remainder_cents: 1000 % winners, ...numbered(n) });
    try {
      const fact = store.loadLineLotResult()!.fact;
      assert.deepEqual(fact, { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
        participantNumber: n, colorId: participantColor(n).id });
      assert.ok(Object.isFrozen(fact));
      assert.notEqual(store.loadLineLotResult(), store.loadLineLotResult());
    } finally { store.close(); }
  }
  assert.equal(participantColor(1).id, participantColor(7).id);
});

test('corrupt, contradictory or forged provenance fails targeted reads but never rewrites rows', () => {
  const corrupt: Record<string, Record<string, unknown>> = {
    'empty origin': { lot_result_origin: '' }, 'unknown origin': { lot_result_origin: 'future' },
    'none resolved': { lot_resolution: 'resolved' },
    'none with number': { lot_participant_number: 1 }, 'none with color': { lot_color_id: 'red' },
    'legacy pending': { lot_result_origin: 'legacy_v8' },
    'legacy with number': { lot_resolution: 'resolved', lot_result_origin: 'legacy_v8', lot_participant_number: 1 },
    'legacy with color': { lot_resolution: 'resolved', lot_result_origin: 'legacy_v8', lot_color_id: 'red' },
    'numbered pending': { ...numbered(1), lot_resolution: 'pending' },
    'numbered not completed': { ...numbered(1), presentation_status: 'interrupted' },
    'numbered no lot': { ...numbered(1), lot: '', lot_resolution: 'not_required' },
    'numbered one winner': { ...numbered(1), winner_count: 1, share_cents: 1000, remainder_cents: 0 },
    'numbered missing number': { ...numbered(1), lot_participant_number: null },
    'numbered missing color': { ...numbered(1), lot_color_id: null },
    'zero': numbered(0, 'red'), 'negative': numbered(-1, 'red'), 'fractional': numbered(1.5, 'red'),
    'above winners': numbered(4, 'blue'), 'unsafe': numbered(2 ** 53, 'red'),
    'wrong color': numbered(1, 'blue'), 'unknown color': numbered(1, 'teal'),
  };
  for (const [name, change] of Object.entries(corrupt)) {
    const { store } = setup(fixture(), change);
    try {
      assert.throws(() => store.loadLineLotResult(), /Invalid stored line award/, name);
      assert.throws(() => store.loadLineAward(), /Invalid stored line award/, name);
      assert.doesNotThrow(() => store.load(), name);
    } finally { store.close(); }
  }
});

test('restart reads the same facts and only the active event is read', () => {
  const path = fixture();
  const first = setup(path, numbered(2));
  const expected = first.store.loadLineLotResult();
  first.store.close();
  const reopened = createEventStore(path);
  try {
    assert.deepEqual(reopened.loadLineLotResult(), expected);
    // Selecting an event without an award hides the other event's facts; selecting back restores them.
    const other = reopened.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    reopened.selectEvent(other.id);
    assert.equal(reopened.loadLineLotResult(), null);
    reopened.selectEvent(first.event.id);
    assert.deepEqual(reopened.loadLineLotResult(), expected);
  } finally { reopened.close(); }
});

// LOT-02C: the guarded atomic writer. Every refusal must leave the complete durable state byte-identical.
function durable(path: string) {
  return withDb(path, (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()])));
}
type Store = ReturnType<typeof createEventStore>;
function identity(store: Store, over: Record<string, unknown> = {}) {
  const read = store.loadLineLotResult()!;
  return { eventId: read.eventId, auditSequence: read.auditSequence, presentationId: read.presentation.id, ...over };
}
const writer = (store: Store) => store as Store & { resolveLineLot(expected: unknown, result: unknown): unknown };
const refuses = (action: () => unknown, label?: string) => assert.throws(action, (e: Error) => e instanceof Error && !/not a function/.test(e.message), label);
const pick = (n: number) => ({ participantNumber: n, colorId: participantColor(n).id });

test('LOT-02C commits boundary and repeated-color results and returns the committed detached snapshot', () => {
  const max = Number.MAX_SAFE_INTEGER;
  for (const [winners, n] of [[3, 2], [7, 7], [max, max], [max, 1]] as const) {
    const path = fixture();
    const { store, event } = setup(path, { ...completed, winner_count: winners, share_cents: Math.floor(1000 / winners),
      remainder_cents: 1000 % winners });
    try {
      const before = durable(path);
      const request = pick(n);
      const committed = writer(store).resolveLineLot(identity(store), request) as ReturnType<Store['loadLineLotResult']>;
      (request as { participantNumber: number }).participantNumber = 1;
      assert.deepEqual(committed, store.loadLineLotResult());
      assert.deepEqual(committed!.fact, { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1,
        participantNumber: n, colorId: participantColor(n).id });
      assert.ok(Object.isFrozen(committed) && Object.isFrozen(committed!.fact) && Object.isFrozen(committed!.presentation));
      assert.equal(committed!.eventId, event.id);
      // Only the four result columns changed; calls, phase, audit, prize arithmetic and presentation are intact.
      const after = durable(path);
      const { line_awards: a, ...rest } = after;
      const { line_awards: b, ...restBefore } = before;
      assert.deepEqual(rest, restBefore);
      assert.deepEqual({ ...a[0], lot_resolution: 0, lot_result_origin: 0, lot_participant_number: 0, lot_color_id: 0 },
        { ...b[0], lot_resolution: 0, lot_result_origin: 0, lot_participant_number: 0, lot_color_id: 0 });
      assert.equal(a[0].lot_resolution, 'resolved');
    } finally { store.close(); }
  }
  assert.equal(participantColor(7).id, participantColor(1).id);
});

test('LOT-02C refuses stale, wrong, malformed or ineligible requests without any durable change', () => {
  const states: Record<string, Record<string, unknown>> = {
    pending: {}, started: { presentation_status: 'started', presentation_started_at: 1000, presentation_deadline: 5000 },
    failed: { presentation_status: 'failed' }, interrupted: { ...completed, presentation_status: 'interrupted' },
    'no lot': { ...completed, lot: '', lot_resolution: 'not_required' },
    'one winner': { ...completed, winner_count: 1, share_cents: 1000, remainder_cents: 0, lot_resolution: 'not_required' },
    legacy: { ...completed, lot_resolution: 'resolved', lot_result_origin: 'legacy_v8' },
    'already numbered': numbered(2),
  };
  for (const [name, change] of Object.entries(states)) {
    const path = fixture();
    const { store } = setup(path, change);
    try {
      const before = durable(path);
      refuses(() => writer(store).resolveLineLot(identity(store), pick(2)), name);
      assert.deepEqual(durable(path), before, name);
    } finally { store.close(); }
  }
  const path = fixture();
  const { store, event } = setup(path, completed);
  try {
    const bad: Record<string, [unknown, unknown]> = {
      'wrong audit': [identity(store, { auditSequence: 2 }), pick(2)],
      'wrong presentation': [identity(store, { presentationId: 'p-2' }), pick(2)],
      'wrong event': [identity(store, { eventId: 'other' }), pick(2)],
      'bad audit type': [identity(store, { auditSequence: '1' }), pick(2)],
      'unsafe audit': [identity(store, { auditSequence: 2 ** 53 }), pick(2)],
      'extra identity key': [identity(store, { extra: 1 }), pick(2)],
      'missing identity key': [{ eventId: event.id, auditSequence: 1 }, pick(2)],
      'null identity': [null, pick(2)], 'array identity': [[], pick(2)],
      'accessor identity': [Object.defineProperty({ ...identity(store) }, 'eventId', { get: () => event.id, enumerable: true }), pick(2)],
      'number zero': [identity(store), { participantNumber: 0, colorId: 'red' }], 'above winners': [identity(store), { participantNumber: 4, colorId: 'yellow' }],
      'fractional': [identity(store), { participantNumber: 1.5, colorId: 'red' }],
      'string number': [identity(store), { participantNumber: '2', colorId: 'blue' }],
      'unsafe number': [identity(store), { participantNumber: 2 ** 53, colorId: 'red' }],
      'wrong color': [identity(store), { participantNumber: 2, colorId: 'red' }],
      'missing color': [identity(store), { participantNumber: 2 }],
      'extra result key': [identity(store), { ...pick(2), winner: true }],
      'null result': [identity(store), null], 'array result': [identity(store), []],
      'accessor result': [identity(store), Object.defineProperty({ colorId: 'blue' }, 'participantNumber', { get: () => 2, enumerable: true })],
    };
    const before = durable(path);
    for (const [name, [expected, result]] of Object.entries(bad)) {
      refuses(() => writer(store).resolveLineLot(expected, result), name);
      assert.deepEqual(durable(path), before, name);
    }
    // A switched active event refuses the old identity, and the old event is untouched.
    const expected = identity(store);
    store.selectEvent(store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' }).id);
    const switched = durable(path);
    refuses(() => writer(store).resolveLineLot(expected, pick(2)));
    assert.deepEqual(durable(path), switched);
  } finally { store.close(); }
});

test('LOT-02C a repeated attempt and a stale second connection fail after the first commit', () => {
  const path = fixture();
  const { store: first } = setup(path, completed);
  const second = createEventStore(path);
  try {
    const expected = identity(first);
    assert.equal(identity(second).presentationId, expected.presentationId);
    writer(first).resolveLineLot(expected, pick(3));
    const committed = durable(path);
    refuses(() => writer(second).resolveLineLot(expected, pick(2)));
    refuses(() => writer(first).resolveLineLot(expected, pick(3)));
    assert.deepEqual(durable(path), committed);
    assert.deepEqual(second.loadLineLotResult()!.fact, first.loadLineLotResult()!.fact);
  } finally { first.close(); second.close(); }
});

test('LOT-02C a held writer lock refuses without change and the same request then succeeds', () => {
  const path = fixture();
  const { store } = setup(path, completed);
  const blocker = new DatabaseSync(path);
  try {
    const expected = identity(store);
    const before = durable(path);
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(() => writer(store).resolveLineLot(expected, pick(2)), /locked|busy/i);
    blocker.exec('ROLLBACK');
    assert.deepEqual(durable(path), before);
    assert.equal((writer(store).resolveLineLot(expected, pick(2)) as { fact: { participantNumber: number } }).fact.participantNumber, 2);
  } finally { blocker.close(); store.close(); }
});

test('LOT-02C an update failure or tampered readback rolls back everything', () => {
  const triggers = {
    'update failure': "CREATE TRIGGER t BEFORE UPDATE OF lot_resolution ON line_awards BEGIN SELECT RAISE(ABORT, 'injected'); END",
    // Number 1 shares number 7's color, so this tamper passes every CHECK and only the readback can catch it.
    'tampered number': `CREATE TRIGGER t AFTER UPDATE OF lot_resolution ON line_awards
      BEGIN UPDATE line_awards SET lot_participant_number = 1 WHERE event_id = NEW.event_id; END`,
  };
  for (const [name, sql] of Object.entries(triggers)) {
    const path = fixture();
    const { store } = setup(path, { ...completed, winner_count: 7, share_cents: 142, remainder_cents: 6 });
    try {
      const expected = identity(store);
      withDb(path, (db) => db.exec(sql));
      const before = durable(path);
      refuses(() => writer(store).resolveLineLot(expected, pick(7)), name);
      assert.deepEqual(durable(path), before, name);
      withDb(path, (db) => db.exec('DROP TRIGGER t'));
      assert.equal((writer(store).resolveLineLot(expected, pick(7)) as { fact: { participantNumber: number } }).fact.participantNumber, 7);
    } finally { store.close(); }
  }
});

test('LOT-02C the committed result survives reopening and a fresh process', () => {
  const path = fixture();
  const { store } = setup(path, completed);
  const committed = writer(store).resolveLineLot(identity(store), pick(2));
  store.close();
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.loadLineLotResult(), committed); } finally { reopened.close(); }
  const script = `import { createEventStore } from ${JSON.stringify(new URL('../src/event-store.ts', import.meta.url).href)};
    const s = createEventStore(${JSON.stringify(path)}); process.stdout.write(JSON.stringify(s.loadLineLotResult())); s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), committed);
});
