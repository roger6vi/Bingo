import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createEventStore, EVENT_SCHEMA_VERSION } from '../src/event-store.ts';
import { DEFAULT_THEME, THEME_IDS } from '../src/theme.ts';

// Theme allow-list and default frozen into the v2–v4 schemas.
const LEGACY_THEME_IDS = ['pixel-classic', 'high-contrast'];
const LEGACY_DEFAULT_THEME = 'pixel-classic';

// Fixture directories are removed once, after every test in this file has closed its stores. Removing
// a directory inside a per-test hook races that test's own `store.close()` hooks (hooks run in
// registration order), and Windows refuses to delete a SQLite file that is still open.
const fixtureDirectories: string[] = [];
after(() => {
  for (const directory of fixtureDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(_t?: unknown) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-'));
  fixtureDirectories.push(directory);
  return join(directory, 'event.sqlite');
}

function withDb(path: string, action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try { action(db); } finally { db.close(); }
}

test('only explicit creation creates the current event; duplicates fail and reopening preserves ordered calls', (t) => {
  const path = fixture(t);
  const first = createEventStore(path);
  try {
    assert.equal(first.load(), null);
    const initial = first.create();
    assert.deepEqual(initial.calledNumbers, []);
    assert.throws(() => first.create(), /exist|already/i);
    const once = first.update((event) => drawManual(event, 90));
    assert.deepEqual(once.calledNumbers, [90]);
    assert.deepEqual(first.update((event) => drawManual(event, 1)).calledNumbers, [90, 1]);
    assert.deepEqual(initial.calledNumbers, []);
  } finally { first.close(); }

  const reopened = createEventStore(path);
  try {
    assert.deepEqual(reopened.load()?.calledNumbers, [90, 1]);
    assert.throws(() => reopened.create(), /exist|already/i);
    assert.deepEqual(reopened.update((event) => drawManual(event, 45)).calledNumbers, [90, 1, 45]);
  } finally { reopened.close(); }
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION));
});

test('a fresh Node process recovers exact history and appends to it', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    store.update((event) => drawManual(event, 87));
    store.update((event) => drawManual(event, 3));
  } finally { store.close(); }
  // Import by URL so the child uses the same TypeScript loader as the test runner.
  const script = `
    const { createEventStore } = await import(process.argv[2]);
    const store = createEventStore(process.argv[1]);
    try {
      const before = store.load()?.calledNumbers;
      const after = store.update((event) => ({ calledNumbers: [...event.calledNumbers, 90] })).calledNumbers;
      process.stdout.write(JSON.stringify({ before, after }));
    } finally { store.close(); }
  `;
  const output = execFileSync(process.execPath, [
    '--input-type=module', '--eval', script, path,
    new URL('../src/event-store.ts', import.meta.url).href,
  ], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { before: [87, 3], after: [87, 3, 90] });
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [87, 3, 90]); }
  finally { reopened.close(); }
});

test('simultaneous first opens never observe a partially initialized database', async (t) => {
  const path = fixture(t);
  const release = join(fs.realpathSync(join(path, '..')), 'release');
  const moduleUrl = new URL('../src/event-store.ts', import.meta.url).href;
  const script = `
    const fs = require('node:fs');
    if (process.argv[3] === 'pause') {
      const sqlite = require('node:sqlite');
      const Original = sqlite.DatabaseSync;
      sqlite.DatabaseSync = class extends Original {
        constructor(path) {
          super(path);
          process.send({ opened: true });
          while (!fs.existsSync(process.argv[2])) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      };
      require('node:module').syncBuiltinESMExports();
    }
    process.on('message', async (message) => {
      if (message !== 'start') return;
      try {
        const { createEventStore } = await import(process.argv[1]);
        const store = createEventStore(process.argv[3] === 'pause' ? process.argv[4] : process.argv[2]);
        try {
          const db = new (require('node:sqlite').DatabaseSync)(
            process.argv[3] === 'pause' ? process.argv[4] : process.argv[2]);
          try { process.send({ version: db.prepare('PRAGMA user_version').get().user_version,
            empty: store.load() === null }); }
          finally { db.close(); }
        } finally { store.close(); }
      } catch (error) { process.send({ error: String(error) }); }
      process.exit();
    });
    process.send({ ready: true });
  `;
  const children: ReturnType<typeof spawn>[] = [];
  function child(mode: 'pause' | 'normal') {
    const proc = spawn(process.execPath, ['--eval', script, moduleUrl,
      mode === 'pause' ? release : path, mode, path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(proc);
    return proc;
  }
  function message(proc: ReturnType<typeof spawn>, key: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${key}`)), 10000);
      const onMessage = (value: Record<string, unknown>) => {
        if (key in value || 'error' in value) {
          clearTimeout(timer);
          proc.off('message', onMessage);
          resolve(value);
        }
      };
      proc.on('message', onMessage);
      proc.once('exit', (code) => {
        if (code !== 0) { clearTimeout(timer); reject(new Error(`Opener exited ${code}`)); }
      });
    });
  }
  t.after(() => { for (const proc of children) proc.kill(); });
  const first = child('pause');
  assert.equal((await message(first, 'ready')).ready, true);
  const opened = message(first, 'opened');
  first.send('start');
  assert.equal((await opened).opened, true);
  const second = child('normal');
  assert.equal((await message(second, 'ready')).ready, true);
  const result = message(second, 'version');
  second.send('start');
  const secondResult = await result;
  const firstResultPending = message(first, 'version');
  fs.writeFileSync(release, 'go');
  const firstResult = await firstResultPending;
  assert.deepEqual(secondResult, { version: EVENT_SCHEMA_VERSION, empty: true });
  assert.deepEqual(firstResult, { version: EVENT_SCHEMA_VERSION, empty: true });
  assert.deepEqual(fs.readdirSync(join(path, '..')).sort(), ['event.sqlite', 'release']);
});

test('invalid and duplicate transitions leave disk unchanged after reopening', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.throws(() => store.update((event) => drawManual(event, 1)), /event|exist/i);
    store.create();
    store.update((event) => drawManual(event, 90));
    for (const invalid of [0, 91, 1.5, 90]) {
      assert.throws(() => store.update((event) => drawManual(event, invalid)), /invalid|already called/i);
    }
    assert.throws(() => store.update(() => ({ calledNumbers: [90, 90] })), /invalid|already called|duplicate/i);
    assert.throws(() => store.update(() => ({ calledNumbers: [] })), /invalid event transition/i);
    assert.throws(() => store.update(() => ({ calledNumbers: [1, 90] })), /invalid event transition/i);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [90]); }
  finally { reopened.close(); }
});

test('a transition cannot mutate its supplied history to bypass append-only validation', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    store.update((event) => drawManual(event, 90));
    assert.throws(() => store.update((event) => {
      (event.calledNumbers as number[])[0] = 1;
      return { calledNumbers: [...event.calledNumbers, 45] };
    }), /invalid event transition/i);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [90]); }
  finally { reopened.close(); }
});

test('failed SQL write rolls back and does not poison subsequent transitions', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    store.update((event) => drawManual(event, 12));
    withDb(path, (db) => db.exec(`CREATE TRIGGER refuse_write BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`));
    assert.throws(() => store.update((event) => drawManual(event, 7)), /injected write failure/);
    assert.deepEqual(store.load()?.calledNumbers, [12]);
    withDb(path, (db) => db.exec('DROP TRIGGER refuse_write'));
    assert.deepEqual(store.update((event) => drawManual(event, 7)).calledNumbers, [12, 7]);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [12, 7]); }
  finally { reopened.close(); }
});

test('malformed stored history and read errors fail closed without replacing the row', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try { store.create(); } finally { store.close(); }
  for (const history of ['not json', '[1,1]', '[0]', '[1.5]', '[91]', '{}']) {
    withDb(path, (db) => db.prepare('UPDATE events SET history = ?').run(history));
    assert.throws(() => createEventStore(path), /invalid|history|event/i);
    withDb(path, (db) => assert.equal(db.prepare('SELECT history FROM events').get()?.history, history));
  }
  withDb(path, (db) => db.exec('PRAGMA foreign_keys = OFF; DROP TABLE events'));
  assert.throws(() => createEventStore(path), /schema|table|invalid/i);
});

test('unsupported version and existing unknown database never initialize as the current version', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec(`PRAGMA user_version = ${EVENT_SCHEMA_VERSION + 1}`));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION + 1));

  const unknown = join(fs.realpathSync(join(path, '..')), 'unknown.sqlite');
  withDb(unknown, (db) => db.exec('CREATE TABLE unrelated (value INTEGER)'));
  assert.throws(() => createEventStore(unknown), /schema|unknown|version/i);
  withDb(unknown, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'unrelated'").get()?.name, 'unrelated');
  });
  const empty = join(fs.realpathSync(join(path, '..')), 'existing-empty.sqlite');
  fs.writeFileSync(empty, '');
  assert.throws(() => createEventStore(empty), /schema|unknown|version|existing/i);
  assert.equal(fs.statSync(empty).size, 0);
  const malformed = join(fs.realpathSync(join(path, '..')), 'malformed.sqlite');
  const bytes = Buffer.from('not a sqlite database');
  fs.writeFileSync(malformed, bytes);
  assert.throws(() => createEventStore(malformed), /database|malformed|schema/i);
  assert.deepEqual(fs.readFileSync(malformed), bytes);
});

test('version-1 schemas missing mandatory constraints are rejected without alteration', (t) => {
  const path = fixture(t);
  const directory = fs.realpathSync(join(path, '..'));
  const deficient = [
    ['no-primary-key', 'id INTEGER CHECK (id = 1), history TEXT NOT NULL'],
    ['no-singleton-check', 'id INTEGER PRIMARY KEY, history TEXT NOT NULL'],
    ['nullable-history', 'id INTEGER PRIMARY KEY CHECK (id = 1), history TEXT'],
  ] as const;
  for (const [name, columns] of deficient) {
    const file = join(directory, `${name}.sqlite`);
    withDb(file, (db) => {
      db.exec(`CREATE TABLE current_event (${columns}); PRAGMA user_version = 1`);
      db.prepare('INSERT INTO current_event (id, history) VALUES (1, ?)').run('[90]');
    });
    assert.throws(() => createEventStore(file), /invalid event schema/i, name);
    withDb(file, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'current_event'").get()?.sql,
        `CREATE TABLE current_event (${columns})`);
      const row = db.prepare('SELECT id, history FROM current_event').get();
      assert.equal(row?.id, 1);
      assert.equal(row?.history, '[90]');
    });
  }
  const equivalent = join(directory, 'equivalent.sqlite');
  withDb(equivalent, (db) => db.exec(`CREATE TABLE current_event (
    id integer primary key check (( id = 1 )), history text not null
  ); PRAGMA user_version = 1`));
  const compatible = createEventStore(equivalent);
  try { assert.deepEqual(compatible.create().calledNumbers, []); }
  finally { compatible.close(); }
});

function v1(path: string, history = '[90,1]') {
  withDb(path, (db) => {
    db.exec(`CREATE TABLE current_event (
      id INTEGER PRIMARY KEY CHECK (id = 1), history TEXT NOT NULL
    ); PRAGMA user_version = 1`);
    db.prepare('INSERT INTO current_event (id, history) VALUES (1, ?)').run(history);
  });
}

test('valid v1 migrates once to v4, preserves ordered calls, and rejects a persisted injected audit row', (t) => {
  const path = fixture(t);
  v1(path);
  let eventId: string | undefined;
  for (let open = 0; open < 2; open++) {
    const store = createEventStore(path);
    try {
      assert.deepEqual(store.load(), { calledNumbers: open === 0 ? [90, 1] : [90, 1, 45],
        phase: 'drawing', lastTransitionAt: null });
      if (open === 0) assert.deepEqual(store.update((event) => drawManual(event, 45)),
        { calledNumbers: [90, 1, 45], phase: 'drawing', lastTransitionAt: null });
    } finally { store.close(); }
  }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    const row = db.prepare('SELECT id, name, date, place, history FROM events').get();
    eventId = row?.id;
    assert.equal(row?.name, 'Evento actual');
    assert.equal(row?.place, 'Sin especificar');
    assert.match(row?.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row?.history, '[90,1,45]');
    assert.equal(db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id, eventId);
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 0);
    assert.throws(() => db.exec(`INSERT INTO phase_audit
      (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES ('${eventId}', 1, '2025-01-01T00:00:00.000Z', 'begin_line_check', 'drawing', 'checking_line');
      UPDATE phase_audit SET kind = 'finish'`), /audit|immutable|update/i);
    // The INSERT committed before the rejected UPDATE; it must remain on disk.
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 1);
  });
  assert.throws(() => createEventStore(path), /invalid phase audit/i);
});

test('valid v1 migrates directly to v4, preserving ordered calls with the default theme and placeholder metadata', (t) => {
  const path = fixture(t);
  v1(path, '[90,1]');
  const store = createEventStore(path);
  try {
    assert.deepEqual(store.load(), { calledNumbers: [90, 1], phase: 'drawing', lastTransitionAt: null });
    assert.equal(store.loadTheme(), DEFAULT_THEME);
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    const row = db.prepare('SELECT theme, name, place FROM events').get();
    assert.equal(row?.theme, DEFAULT_THEME);
    assert.equal(row?.name, 'Evento actual');
    assert.equal(row?.place, 'Sin especificar');
  });
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [90, 1]); }
  finally { reopened.close(); }
});

function v2(path: string, options: { history?: string; phase?: string; lastTransitionAt?: string | null;
  audit?: readonly { sequence: number; transitionAt: string; kind: string; from_phase: string; to_phase: string }[] } = {}) {
  const { history = '[90,1]', phase = 'drawing', lastTransitionAt = null, audit = [] } = options;
  withDb(path, (db) => {
    db.exec(`CREATE TABLE current_event (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      history TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'drawing' CHECK (phase IN ('drawing', 'checking_line', 'line_declared',
        'checking_bingo', 'bingo_declared', 'finished')),
      lastTransitionAt TEXT
    );
    CREATE TABLE phase_audit (
      sequence INTEGER PRIMARY KEY,
      transitionAt TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL
    );
    CREATE TRIGGER phase_audit_no_update BEFORE UPDATE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    CREATE TRIGGER phase_audit_no_delete BEFORE DELETE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    PRAGMA user_version = 2;`);
    db.prepare('INSERT INTO current_event (id, history, phase, lastTransitionAt) VALUES (1, ?, ?, ?)')
      .run(history, phase, lastTransitionAt);
    for (const entry of audit) {
      db.prepare(`INSERT INTO phase_audit (sequence, transitionAt, kind, from_phase, to_phase)
        VALUES (?, ?, ?, ?, ?)`).run(entry.sequence, entry.transitionAt, entry.kind, entry.from_phase, entry.to_phase);
    }
  });
}

test('valid v2 migrates to v4, preserving history, phase, and audit with the default theme and placeholder metadata', (t) => {
  const path = fixture(t);
  v2(path, { history: '[90,1]', phase: 'checking_line', lastTransitionAt: '2025-01-01T00:00:00.000Z',
    audit: [{ sequence: 1, transitionAt: '2025-01-01T00:00:00.000Z', kind: 'begin_line_check',
      from_phase: 'drawing', to_phase: 'checking_line' }] });
  const store = createEventStore(path);
  try {
    assert.deepEqual(store.load(), { calledNumbers: [90, 1], phase: 'checking_line',
      lastTransitionAt: '2025-01-01T00:00:00.000Z' });
    assert.equal(store.readAudit().length, 1);
    assert.equal(store.loadTheme(), DEFAULT_THEME);
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    const row = db.prepare('SELECT id, theme, name, place FROM events').get();
    assert.equal(row?.theme, DEFAULT_THEME);
    assert.equal(row?.name, 'Evento actual');
    assert.equal(row?.place, 'Sin especificar');
    assert.equal(db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id, row?.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit WHERE event_id = ?').get(row?.id)?.count, 1);
  });
});

test('migrating to v4 is idempotent: reopening a migrated database keeps the same event id and never re-migrates', (t) => {
  const path = fixture(t);
  v1(path, '[90,1]');
  const first = createEventStore(path);
  let firstId: string | undefined;
  try {
    first.update((event) => drawManual(event, 45));
  } finally { first.close(); }
  withDb(path, (db) => { firstId = db.prepare('SELECT id FROM events').get()?.id; });
  const second = createEventStore(path);
  try { assert.deepEqual(second.load()?.calledNumbers, [90, 1, 45]); }
  finally { second.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT count(*) AS count FROM events').get()?.count, 1);
    assert.equal(db.prepare('SELECT id FROM events').get()?.id, firstId);
    assert.equal(db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id, firstId);
  });
});

function v3(path: string, options: { history?: string; phase?: string; lastTransitionAt?: string | null;
  theme?: string } = {}) {
  const { history = '[90,1]', phase = 'drawing', lastTransitionAt = null, theme = LEGACY_DEFAULT_THEME } = options;
  withDb(path, (db) => {
    db.exec(`CREATE TABLE current_event (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      history TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'drawing' CHECK (phase IN ('drawing', 'checking_line', 'line_declared',
        'checking_bingo', 'bingo_declared', 'finished')),
      lastTransitionAt TEXT,
      theme TEXT NOT NULL DEFAULT '${LEGACY_DEFAULT_THEME}' CHECK (theme IN (${LEGACY_THEME_IDS.map((id) => `'${id}'`).join(', ')}))
    );
    CREATE TABLE phase_audit (
      sequence INTEGER PRIMARY KEY,
      transitionAt TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL
    );
    CREATE TRIGGER phase_audit_no_update BEFORE UPDATE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    CREATE TRIGGER phase_audit_no_delete BEFORE DELETE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    PRAGMA user_version = 3;`);
    db.prepare('INSERT INTO current_event (id, history, phase, lastTransitionAt, theme) VALUES (1, ?, ?, ?, ?)')
      .run(history, phase, lastTransitionAt, theme);
  });
}

test('a failed v3 to v4 migration leaves the v3 database completely unchanged', (t) => {
  const path = fixture(t);
  v3(path, { history: '[90,1]', theme: 'high-contrast' });
  // A malformed legacy audit row (a sequence gap) fails validation before any v4 table
  // is created or written, so the migration never touches the v3 tables at all.
  withDb(path, (db) => db.exec(`INSERT INTO phase_audit (sequence, transitionAt, kind, from_phase, to_phase)
    VALUES (2, '2025-01-01T00:00:00.000Z', 'begin_line_check', 'drawing', 'checking_line')`));
  assert.throws(() => createEventStore(path), /invalid phase audit/i);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'events'").get()?.count, 0);
    assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, '[90,1]');
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 1);
  });
});

test('an events table with rows and no active pointer is rejected, as is a dangling pointer', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  let eventId: string | undefined;
  try {
    store.create();
  } finally { store.close(); }
  withDb(path, (db) => { eventId = db.prepare('SELECT id FROM events').get()?.id; });

  const missingPointer = join(fs.realpathSync(join(path, '..')), 'missing-pointer.sqlite');
  fs.copyFileSync(path, missingPointer);
  withDb(missingPointer, (db) => db.exec('DELETE FROM active_event'));
  assert.throws(() => createEventStore(missingPointer), /active event|pointer/i);

  const danglingPointer = join(fs.realpathSync(join(path, '..')), 'dangling-pointer.sqlite');
  fs.copyFileSync(path, danglingPointer);
  withDb(danglingPointer, (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE active_event SET event_id = ? WHERE slot = 1').run(randomUUID());
  });
  assert.throws(() => createEventStore(danglingPointer), /active event|dangling|pointer/i);
  void eventId;
});

test('phase audit sequences are scoped per event and an inactive event never affects the active one', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  let activeId: string | undefined;
  try {
    store.create();
    store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z');
  } finally { store.close(); }
  withDb(path, (db) => {
    activeId = db.prepare('SELECT id FROM events').get()?.id;
    const otherId = randomUUID();
    db.prepare(`INSERT INTO events (id, name, date, place, history, phase, lastTransitionAt, theme, createdAt)
      VALUES (?, 'Otro evento', '2024-01-01', 'Otro lugar', '[]', 'drawing', NULL, ?, '2024-01-01T00:00:00.000Z')`)
      .run(otherId, DEFAULT_THEME);
    // Same sequence number 1 as the active event's audit row: the composite key must allow this.
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 1, '2024-01-01T00:00:00.000Z', 'begin_line_check', 'drawing', 'checking_line')`).run(otherId);
  });
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.load()?.phase, 'checking_line');
    assert.equal(reopened.readAudit().length, 1);
    assert.equal(reopened.readAudit()[0].from_phase, 'drawing');
  } finally { reopened.close(); }
  void activeId;
});

test('an unsupported future version is rejected outright', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec(`PRAGMA user_version = ${EVENT_SCHEMA_VERSION + 1}`));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION + 1));
});

test('fresh v4 starts in drawing with null timestamp, the default theme, and guarded empty audit', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.equal(store.load(), null);
    assert.equal(store.loadTheme(), DEFAULT_THEME);
    assert.deepEqual(store.create(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null });
    assert.equal(store.loadTheme(), DEFAULT_THEME);
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    const row = db.prepare('SELECT id, theme, name, place, date FROM events').get();
    assert.equal(row?.theme, DEFAULT_THEME);
    assert.equal(row?.name, 'Evento actual');
    assert.equal(row?.place, 'Sin especificar');
    assert.match(row?.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id, row?.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 0);
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='phase_audit_no_delete'").get());
  });
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null }); }
  finally { reopened.close(); }
});

test('v4 rejects missing and wrong phase defaults before creating a current event', (t) => {
  const path = fixture(t);
  const directory = fs.realpathSync(join(path, '..'));
  for (const [name, defaultSql] of [['missing', ''], ['wrong', "DEFAULT 'finished'"]] as const) {
    const file = join(directory, `${name}.sqlite`);
    const fresh = createEventStore(file);
    fresh.close();
    withDb(file, (db) => {
      const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'events'").get()?.sql;
      assert.ok(typeof schema === 'string');
      assert.match(schema, /DEFAULT 'drawing'/);
      db.exec('DROP TABLE events');
      db.exec(schema.replace("DEFAULT 'drawing'", defaultSql));
    });
    assert.throws(() => createEventStore(file), /invalid event schema/i, name);
    withDb(file, (db) => {
      assert.equal(db.prepare('SELECT count(*) AS count FROM events').get()?.count, 0);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    });
  }
});

test('v4 rejects missing, wrong, or nullable theme column definitions before creating a current event', (t) => {
  const path = fixture(t);
  const directory = fs.realpathSync(join(path, '..'));
  for (const [name, mutate] of [
    ['missing-default', (sql: string) => sql.replace(`DEFAULT '${DEFAULT_THEME}'`, '')],
    ['wrong-default', (sql: string) => sql.replace(`DEFAULT '${DEFAULT_THEME}'`, "DEFAULT 'other'")],
    ['nullable', (sql: string) => sql.replace('theme TEXT NOT NULL', 'theme TEXT')],
  ] as const) {
    const file = join(directory, `${name}.sqlite`);
    const fresh = createEventStore(file);
    fresh.close();
    withDb(file, (db) => {
      const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'events'").get()?.sql;
      assert.ok(typeof schema === 'string');
      assert.match(schema, new RegExp(`DEFAULT '${DEFAULT_THEME}'`));
      db.exec('DROP TABLE events');
      db.exec(mutate(schema));
    });
    assert.throws(() => createEventStore(file), /invalid event schema/i, name);
    withDb(file, (db) => {
      assert.equal(db.prepare('SELECT count(*) AS count FROM events').get()?.count, 0);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    });
  }
});

test('invalid v1 history and failed migration leave version and row unchanged', (t) => {
  const path = fixture(t);
  v1(path, '[90,90]');
  assert.throws(() => createEventStore(path), /invalid|history/i);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, '[90,90]');
    db.exec("UPDATE current_event SET history = '[90,1]'");
    db.exec(`CREATE TRIGGER reject_migration BEFORE UPDATE ON current_event
      BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END`);
  });
  assert.throws(() => createEventStore(path), /migration interrupted/);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sqlite_schema WHERE name = \'phase_audit\'').get()?.count, 0);
    db.exec('DROP TRIGGER reject_migration');
  });
  const store = createEventStore(path);
  try { assert.deepEqual(store.load()?.calledNumbers, [90, 1]); }
  finally { store.close(); }
});

test('opening valid v4 under an independent writer lock reads the same ordered snapshot without mutation', (t) => {
  const path = fixture(t);
  const initial = createEventStore(path);
  try {
    initial.create();
    initial.update((event) => drawManual(event, 90));
    initial.update((event) => drawManual(event, 1));
  } finally { initial.close(); }
  withDb(path, (writer) => {
    const before = writer.prepare('SELECT id, history, phase, lastTransitionAt FROM events').all();
    writer.exec('BEGIN IMMEDIATE');
    try {
      const reopened = createEventStore(path);
      try {
        assert.deepEqual(reopened.load(), { calledNumbers: [90, 1], phase: 'drawing', lastTransitionAt: null });
      } finally { reopened.close(); }
      assert.deepEqual(writer.prepare('SELECT id, history, phase, lastTransitionAt FROM events').all(), before);
      assert.equal(writer.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
      assert.equal(writer.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 0);
    } finally { writer.exec('ROLLBACK'); }
  });
  const final = createEventStore(path);
  try { assert.deepEqual(final.load(), { calledNumbers: [90, 1], phase: 'drawing', lastTransitionAt: null }); }
  finally { final.close(); }
});

test('migration contention leaves v1 intact until the winner can commit', (t) => {
  const path = fixture(t);
  v1(path);
  withDb(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => createEventStore(path), /locked|busy/i); }
    finally { db.exec('ROLLBACK'); }
  });
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, '[90,1]');
  });
  const winner = createEventStore(path);
  const concurrent = createEventStore(path);
  try {
    assert.deepEqual(winner.load(), concurrent.load());
    assert.deepEqual(winner.load()?.calledNumbers, [90, 1]);
  } finally { winner.close(); concurrent.close(); }
});

test('malformed v4 phase, missing audit guards, and inconsistent empty audit fail closed', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try { store.create(); } finally { store.close(); }
  withDb(path, (db) => db.exec("UPDATE events SET phase = 'line_declared'"));
  assert.throws(() => createEventStore(path), /invalid|audit|phase/i);
  withDb(path, (db) => {
    db.exec("UPDATE events SET phase = 'drawing'");
    db.exec('DROP TRIGGER phase_audit_no_delete');
  });
  assert.throws(() => createEventStore(path), /invalid|audit|schema/i);
});

test('legal intent transitions append one ordered audit row each and draws preserve phase', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    const steps = [
      ['begin_line_check', 'checking_line'], ['reject_line_claim', 'drawing'],
      ['begin_line_check', 'checking_line'], ['declare_line', 'line_declared'],
      ['begin_bingo_check', 'checking_bingo'], ['reject_bingo_claim', 'line_declared'],
      ['begin_bingo_check', 'checking_bingo'], ['declare_bingo', 'bingo_declared'],
      ['correct_bingo_declaration', 'line_declared'], ['correct_line_declaration', 'drawing'],
      ['begin_line_check', 'checking_line'], ['declare_line', 'line_declared'],
      ['begin_bingo_check', 'checking_bingo'], ['declare_bingo', 'bingo_declared'],
      ['finish', 'finished'],
    ] as const;
    let from = 'drawing';
    for (const [index, [kind, to]] of steps.entries()) {
      const at = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
      assert.equal(store.transitionPhase(kind, at).phase, to);
      assert.deepEqual(store.readAudit()[index], {
        sequence: index + 1, transitionAt: at, kind, from_phase: from, to_phase: to,
      });
      from = to;
      if (to === 'line_declared') {
        const count = store.readAudit().length;
        assert.equal(store.update((event) => drawManual(event, index + 1)).phase, to);
        assert.equal(store.readAudit().length, count);
      }
    }
    assert.equal(store.load()?.lastTransitionAt, new Date(Date.UTC(2025, 0, 1, 0, 0, 14)).toISOString());
    assert.throws(() => store.transitionPhase('finish', '2025-01-01T00:01:00.000Z'), /invalid phase transition/i);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.load()?.phase, 'finished');
    assert.equal(reopened.readAudit().length, 15);
  } finally { reopened.close(); }
});

test('illegal intents, noncanonical or regressive clocks and callback phase forgery never change state', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    for (const kind of ['declare_line', 'finish', 'begin_bingo_check'] as const) {
      assert.throws(() => store.transitionPhase(kind, '2025-01-01T00:00:00.000Z'), /invalid phase transition/i);
    }
    const at = '2025-01-01T00:00:00.000Z';
    assert.throws(() => store.transitionPhase('begin_line_check', '2025-01-01'), /timestamp|time/i);
    store.transitionPhase('begin_line_check', at);
    const before = store.load();
    const audit = store.readAudit();
    for (const time of [at, '2024-12-31T23:59:59.999Z', 'garbage', '2025-01-01T01:00:00+01:00']) {
      assert.throws(() => store.transitionPhase('declare_line', time), /timestamp|time/i);
    }
    assert.throws(() => store.transitionPhase('begin_line_check', '2025-01-01T00:00:01.000Z'), /invalid phase transition/i);
    assert.throws(() => store.update(() => ({ calledNumbers: [1], phase: 'drawing', lastTransitionAt: null })), /phase|transition/i);
    assert.throws(() => store.update((event) => {
      (event as { phase: string }).phase = 'drawing';
      return { calledNumbers: [1] };
    }), /phase|transition/i);
    assert.deepEqual(store.load(), before);
    assert.deepEqual(store.readAudit(), audit);
    assert.throws(() => store.update((event) => drawManual(event, 1)), /draw not allowed/i);
    assert.deepEqual(store.readAudit(), audit);
  } finally { store.close(); }
});

test('phase audit reads are defensive and fresh process recovers state and next sequence', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z');
    const entries = store.readAudit();
    (entries[0] as { kind: string }).kind = 'finish';
    (entries as unknown[]).push({});
    assert.equal(store.readAudit()[0].kind, 'begin_line_check');
    assert.equal(store.readAudit().length, 1);
  } finally { store.close(); }
  const script = `
    const { createEventStore } = await import(process.argv[2]);
    const store = createEventStore(process.argv[1]);
    try {
      const before = { state: store.load(), audit: store.readAudit() };
      store.transitionPhase('declare_line', '2025-01-01T00:00:01.000Z');
      process.stdout.write(JSON.stringify({ before, after: store.readAudit() }));
    } finally { store.close(); }
  `;
  const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script,
    path, new URL('../src/event-store.ts', import.meta.url).href], { encoding: 'utf8' }));
  assert.equal(output.before.state.phase, 'checking_line');
  assert.equal(output.before.audit.length, 1);
  assert.deepEqual(output.after.map((entry: { sequence: number }) => entry.sequence), [1, 2]);
  const reopened = createEventStore(path);
  try { assert.equal(reopened.load()?.phase, 'line_declared'); }
  finally { reopened.close(); }
});

test('audit replay rejects gaps, illegal edges, malformed timestamps, and mismatched current state', (t) => {
  const path = fixture(t);
  const directory = fs.realpathSync(join(path, '..'));
  const cases = [
    ['gap', "UPDATE phase_audit SET sequence = 3"],
    ['illegal', "UPDATE phase_audit SET kind = 'finish'"],
    ['source', "UPDATE phase_audit SET from_phase = 'line_declared'"],
    ['target', "UPDATE phase_audit SET to_phase = 'finished'"],
    ['time', "UPDATE phase_audit SET transitionAt = '2025-01-01'"],
    ['phase', "UPDATE events SET phase = 'drawing'"],
    ['last-time', "UPDATE events SET lastTransitionAt = NULL"],
  ] as const;
  for (const [name, tamper] of cases) {
    const file = join(directory, `${name}.sqlite`);
    const store = createEventStore(file);
    try {
      store.create();
      store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z');
    } finally { store.close(); }
    withDb(file, (db) => {
      if (tamper.startsWith('UPDATE phase_audit')) db.exec('DROP TRIGGER phase_audit_no_update');
      db.exec(tamper);
      if (tamper.startsWith('UPDATE phase_audit')) db.exec(`CREATE TRIGGER phase_audit_no_update BEFORE UPDATE ON phase_audit
        BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END`);
    });
    assert.throws(() => createEventStore(file), /invalid phase audit/i, name);
  }
});

test('phase writes roll back state and audit on either SQL failure and under a writer lock', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const other = createEventStore(path);
  try {
    store.create();
    for (const [name, trigger] of [
      ['state', `CREATE TRIGGER fail_phase BEFORE UPDATE OF phase ON events
        BEGIN SELECT RAISE(ABORT, 'state failed'); END`],
      ['audit', `CREATE TRIGGER fail_phase BEFORE INSERT ON phase_audit
        BEGIN SELECT RAISE(ABORT, 'audit failed'); END`],
    ] as const) {
      withDb(path, (db) => db.exec(trigger));
      assert.throws(() => store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z'),
        new RegExp(`${name} failed`));
      assert.equal(store.load()?.phase, 'drawing');
      assert.deepEqual(store.readAudit(), []);
      withDb(path, (db) => db.exec('DROP TRIGGER fail_phase'));
    }
    withDb(path, (db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        assert.throws(() => store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z'), /locked|busy/i);
      } finally { db.exec('ROLLBACK'); }
    });
    other.transitionPhase('begin_line_check', '2025-01-01T00:00:01.000Z');
    assert.throws(() => store.transitionPhase('begin_line_check', '2025-01-01T00:00:02.000Z'),
      /invalid phase transition/i);
    assert.equal(store.load()?.phase, 'checking_line');
    assert.equal(store.readAudit().length, 1);
  } finally { store.close(); other.close(); }
});

test('contention fails without overwriting a newer state, and stale store reads inside transaction', (t) => {
  const path = fixture(t);
  const stale = createEventStore(path);
  const writer = createEventStore(path);
  try {
    stale.create();
    writer.update((event) => drawManual(event, 24));
    assert.deepEqual(stale.update((event) => drawManual(event, 6)).calledNumbers, [24, 6]);
    withDb(path, (db) => {
      db.exec('BEGIN IMMEDIATE');
      try { assert.throws(() => stale.update((event) => drawManual(event, 8)), /locked|busy/i); }
      finally { db.exec('ROLLBACK'); }
    });
    assert.deepEqual(writer.load()?.calledNumbers, [24, 6]);
  } finally { stale.close(); writer.close(); }
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load()?.calledNumbers, [24, 6]); }
  finally { reopened.close(); }
});

// A v4 database exactly as the v4 schema wrote it, with two events, one active, and audit rows.
function v4(path: string, themes: { active: string; other: string }) {
  const ids = { active: randomUUID(), other: randomUUID() };
  withDb(path, (db) => {
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      place TEXT NOT NULL CHECK (length(trim(place)) > 0),
      history TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'drawing' CHECK (phase IN ('drawing', 'checking_line', 'line_declared',
        'checking_bingo', 'bingo_declared', 'finished')),
      lastTransitionAt TEXT,
      theme TEXT NOT NULL DEFAULT '${LEGACY_DEFAULT_THEME}' CHECK (theme IN (${LEGACY_THEME_IDS.map((id) => `'${id}'`).join(', ')})),
      createdAt TEXT NOT NULL
    );
    CREATE TABLE active_event (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      event_id TEXT NOT NULL REFERENCES events(id)
    );
    CREATE TABLE phase_audit (
      event_id TEXT NOT NULL REFERENCES events(id),
      sequence INTEGER NOT NULL,
      transitionAt TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      PRIMARY KEY (event_id, sequence)
    );
    CREATE TRIGGER phase_audit_no_update BEFORE UPDATE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    CREATE TRIGGER phase_audit_no_delete BEFORE DELETE ON phase_audit
      BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END;
    PRAGMA user_version = 4;`);
    const insert = db.prepare(`INSERT INTO events (id, name, date, place, history, phase, lastTransitionAt, theme, createdAt)
      VALUES (?, ?, '2026-08-15', 'Plaza', ?, ?, ?, ?, ?)`);
    insert.run(ids.active, 'Verbena', '[90,1]', 'checking_line', '2026-01-01T00:00:01.000Z', themes.active, '2026-01-01T00:00:00.000Z');
    insert.run(ids.other, 'Fiesta', '[]', 'drawing', null, themes.other, '2026-01-02T00:00:00.000Z');
    db.prepare('INSERT INTO active_event (slot, event_id) VALUES (1, ?)').run(ids.active);
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 1, '2026-01-01T00:00:01.000Z', 'begin_line_check', 'drawing', 'checking_line')`).run(ids.active);
  });
  return ids;
}

const schemaOf = (db: DatabaseSync) => db.prepare(`SELECT type, name, sql FROM sqlite_schema
  WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all()
  .map((row) => ({ ...row, sql: String(row.sql).replace(/[\s"`\[\]]/g, '') }));

test('v4 migrates retired pixel-classic to jules in one transaction, keeping events, pointer, audit and guards', (t) => {
  const path = fixture(t);
  const ids = v4(path, { active: 'pixel-classic', other: 'high-contrast' });
  const store = createEventStore(path);
  try {
    assert.equal(store.loadTheme(), 'jules');
    assert.deepEqual(store.load()?.calledNumbers, [90, 1]);
    assert.equal(store.load()?.phase, 'checking_line');
    assert.equal(store.readAudit().length, 1);
    assert.deepEqual(store.listEvents().map(({ id, name, active }) => ({ id, name, active })),
      [{ id: ids.active, name: 'Verbena', active: true }, { id: ids.other, name: 'Fiesta', active: false }]);
  } finally { store.close(); }
  const fresh = join(fs.realpathSync(join(path, '..')), 'fresh.sqlite');
  createEventStore(fresh).close();
  withDb(fresh, (freshDb) => withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT id, theme FROM events ORDER BY createdAt').all().map((row) => ({ ...row })),
      [{ id: ids.active, theme: 'jules' }, { id: ids.other, theme: 'high-contrast' }]);
    assert.deepEqual(schemaOf(db), schemaOf(freshDb), 'the migrated schema equals a fresh one');
    assert.throws(() => db.exec("UPDATE events SET theme = 'pixel-classic'"), /CHECK/);
    assert.throws(() => db.exec('DELETE FROM phase_audit'), /immutable/);
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES ('missing', 1, '2026-01-01T00:00:00.000Z', 'begin_line_check', 'drawing', 'checking_line')`).run(), /FOREIGN KEY/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_temp_schema").get()?.count, 0);
  }));
});

test('a v3 database reaches the current schema with its stored theme migrated', (t) => {
  for (const [stored, expected] of [['pixel-classic', 'jules'], ['high-contrast', 'high-contrast']]) {
    const path = fixture(t);
    v3(path, { theme: stored });
    const store = createEventStore(path);
    try { assert.equal(store.loadTheme(), expected, stored); } finally { store.close(); }
    withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION));
  }
});

test('an unknown stored v4 theme fails closed and leaves the v4 database unchanged', (t) => {
  const path = fixture(t);
  v4(path, { active: 'pixel-classic', other: 'high-contrast' });
  withDb(path, (db) => {
    db.exec('PRAGMA ignore_check_constraints = 1');
    db.exec("UPDATE events SET theme = 'legacy-blue' WHERE name = 'Fiesta'");
  });
  const before = { schema: '', rows: '' };
  withDb(path, (db) => {
    before.schema = JSON.stringify(schemaOf(db));
    before.rows = JSON.stringify(db.prepare('SELECT * FROM events ORDER BY id').all());
  });
  assert.throws(() => createEventStore(path), /CHECK constraint failed/);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.equal(JSON.stringify(schemaOf(db)), before.schema);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM events ORDER BY id').all()), before.rows);
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM active_event').get()?.count, 1);
  });
});

test('a v4 theme migration blocked by another writer leaves the database at v4 and succeeds later', (t) => {
  const path = fixture(t);
  v4(path, { active: 'pixel-classic', other: 'pixel-classic' });
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => createEventStore(path), /locked|busy/i); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.deepEqual(db.prepare('SELECT DISTINCT theme FROM events').all().map((row) => row.theme), ['pixel-classic']);
  });
  const store = createEventStore(path);
  try { assert.equal(store.loadTheme(), 'jules'); } finally { store.close(); }
});

test('the theme allow-list matches the generated semantic token themes', () => {
  const themes = fs.readdirSync(new URL('../tokens/semantic/', import.meta.url))
    .map((file) => file.replace(/\.json$/, '')).sort();
  assert.deepEqual([...THEME_IDS].sort(), themes);
});

test('a saved theme defaults to jules and recovers each registered theme after reopening', (t) => {
  const path = fixture(t);
  const initial = createEventStore(path);
  try { initial.create(); assert.equal(initial.loadTheme(), 'jules'); }
  finally { initial.close(); }
  for (const theme of ['high-contrast', 'light', 'jules'] as const) {
    const store = createEventStore(path);
    try { assert.equal(store.saveTheme(theme), theme); } finally { store.close(); }
    const reopened = createEventStore(path);
    try { assert.equal(reopened.loadTheme(), theme); } finally { reopened.close(); }
  }
});

test('saveTheme rejects CSS, URLs, paths, unknown names, and non-strings without writing', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  store.create();
  store.saveTheme('high-contrast');
  for (const value of ['body{color:red}', 'https://example.com/theme.css', '../generated/high-contrast.css',
    '/etc/passwd', 'High-Contrast', 'dark', '', ' light', 'pixel-classic', null, 1, { theme: 'light' }]) {
    assert.throws(() => store.saveTheme(value), /Unknown theme/);
  }
  assert.equal(store.loadTheme(), 'high-contrast');
});

test('saveTheme requires an existing current event and never writes an unknown value', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  assert.throws(() => store.saveTheme('dark'), /Unknown theme/);
  assert.equal(store.loadTheme(), DEFAULT_THEME);
  assert.throws(() => store.saveTheme('high-contrast'), /event|exist/i);
  store.create();
  assert.equal(store.saveTheme('high-contrast'), 'high-contrast');
});

test('a locked write leaves the last committed theme unchanged', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  store.create();
  store.saveTheme('high-contrast');
  const other = new DatabaseSync(path);
  other.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => store.saveTheme('light'), /locked|busy/i); }
  finally { other.exec('ROLLBACK'); other.close(); }
  assert.equal(store.loadTheme(), 'high-contrast');
});

test('a tampered stored theme value is rejected rather than applied', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try { store.create(); } finally { store.close(); }
  withDb(path, (db) => {
    db.exec('PRAGMA ignore_check_constraints = 1');
    db.exec("UPDATE events SET theme = 'legacy-blue'");
  });
  const reopened = createEventStore(path);
  try { assert.throws(() => reopened.loadTheme(), /invalid|theme/i); }
  finally { reopened.close(); }
});

test('theme allow-list changes require a schema version bump', (t) => {
  // The events-table CHECK is built from THEME_IDS; when adding a theme, bump the schema version,
  // add a migration that rebuilds the CHECK, and update this pairing.
  const path = fixture(t);
  createEventStore(path).close();
  withDb(path, (db) => assert.deepEqual(
    { version: db.prepare('PRAGMA user_version').get()?.user_version, themes: [...THEME_IDS] },
    { version: EVENT_SCHEMA_VERSION, themes: ['jules', 'light', 'high-contrast'] },
    'THEME_IDS changed without a matching event schema migration',
  ));
});

test('createEvent validates metadata, trims name and place, and never writes on failure', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const before = store.listEvents();
  const long = 'a'.repeat(121);
  const invalid = [
    { name: '', date: '2025-01-01', place: 'Club' },
    { name: '   ', date: '2025-01-01', place: 'Club' },
    { name: long, date: '2025-01-01', place: 'Club' },
    { name: 'Bingo', date: '2025-01-01', place: '' },
    { name: 'Bingo', date: '2025-01-01', place: '   ' },
    { name: 'Bingo', date: '2025-01-01', place: long },
    { name: 1, date: '2025-01-01', place: 'Club' },
    { name: 'Bingo', date: '2025-01-01', place: 1 },
    { name: 'Bingo', date: '2026-02-30', place: 'Club' },
    { name: 'Bingo', date: '2025-1-1', place: 'Club' },
    { name: 'Bingo', date: '01-01-2025', place: 'Club' },
    { name: 'Bingo', date: 20250101, place: 'Club' },
    { name: 'Bingo', date: null, place: 'Club' },
  ] as const;
  for (const meta of invalid) {
    assert.throws(() => store.createEvent(meta as { name: unknown; date: unknown; place: unknown }), /invalid|event/i);
  }
  assert.deepEqual(store.listEvents(), before);
  const created = store.createEvent({ name: '  Gran Bingo  ', date: '2025-06-15', place: '  Club Central  ' });
  assert.equal(created.name, 'Gran Bingo');
  assert.equal(created.place, 'Club Central');
  assert.equal(created.date, '2025-06-15');
  assert.equal(created.phase, 'drawing');
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(store.listEvents().length, before.length + 1);
});

test('the first createEvent on an empty v4 store becomes active; later ones do not', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const first = store.createEvent({ name: 'First', date: '2025-01-01', place: 'A' });
  assert.equal(first.active, true);
  const second = store.createEvent({ name: 'Second', date: '2025-01-02', place: 'B' });
  assert.equal(second.active, false);
  const summaries = store.listEvents();
  assert.equal(summaries.find((event) => event.id === first.id)?.active, true);
  assert.equal(summaries.find((event) => event.id === second.id)?.active, false);
});

test('listEvents orders by createdAt then id and returns frozen copies', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  const list = store.listEvents();
  assert.deepEqual(list.map((event) => event.id), [a, b].sort((x, y) =>
    x.createdAt === y.createdAt ? (x.id < y.id ? -1 : 1) : (x.createdAt < y.createdAt ? -1 : 1)).map((e) => e.id));
  assert.throws(() => { (list[0] as { name: string }).name = 'tampered'; });
  assert.notEqual(store.listEvents()[0], list[0]);
});

test('selectEvent switches the active event and rejects unknown or non-string ids without changing state', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  assert.equal(store.listEvents().find((e) => e.id === a.id)?.active, true);
  const selected = store.selectEvent(b.id);
  assert.equal(selected.id, b.id);
  assert.equal(selected.active, true);
  assert.equal(store.listEvents().find((e) => e.id === a.id)?.active, false);
  assert.equal(store.listEvents().find((e) => e.id === b.id)?.active, true);
  const noop = store.selectEvent(b.id);
  assert.equal(noop.active, true);
  for (const bad of [randomUUID(), 42, null, undefined, {}, '']) {
    assert.throws(() => store.selectEvent(bad as unknown), /invalid|unknown|event/i);
  }
  assert.equal(store.listEvents().find((e) => e.id === b.id)?.active, true);
});

test('events are fully isolated: history, phase, theme, and audit never bleed across selection', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.update((event) => drawManual(event, 5));
  store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z');
  store.saveTheme('high-contrast');
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.selectEvent(b.id);
  assert.deepEqual(store.load(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null });
  assert.equal(store.loadTheme(), DEFAULT_THEME);
  assert.deepEqual(store.readAudit(), []);
  store.selectEvent(a.id);
  assert.deepEqual(store.load(), { calledNumbers: [5], phase: 'checking_line', lastTransitionAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(store.loadTheme(), 'high-contrast');
  assert.equal(store.readAudit().length, 1);
});

test('the selected event survives closing and reopening the store, including a fresh process', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.selectEvent(b.id);
  store.close();
  const reopened = createEventStore(path);
  try { assert.equal(reopened.listEvents().find((e) => e.id === b.id)?.active, true); }
  finally { reopened.close(); }
  const script = `
    const { createEventStore } = await import(process.argv[2]);
    const store = createEventStore(process.argv[1]);
    try { process.stdout.write(JSON.stringify(store.listEvents().find((e) => e.active)?.id)); }
    finally { store.close(); }
  `;
  const output = execFileSync(process.execPath, [
    '--input-type=module', '--eval', script, path,
    new URL('../src/event-store.ts', import.meta.url).href,
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(output), b.id);
  void a;
});

test('a second connection observes selection made by another connection on its next transaction', (t) => {
  const path = fixture(t);
  const conn1 = createEventStore(path);
  const conn2 = createEventStore(path);
  t.after(() => { conn1.close(); conn2.close(); });
  const a = conn1.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = conn1.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  assert.deepEqual(conn2.load(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null });
  conn1.selectEvent(b.id);
  conn2.update((event) => drawManual(event, 33));
  assert.deepEqual(conn2.load()?.calledNumbers, [33]);
  assert.deepEqual(conn1.load()?.calledNumbers, [33]);
  const reopenedA = conn1.selectEvent(a.id);
  assert.deepEqual(reopenedA, { ...reopenedA, id: a.id });
  assert.deepEqual(conn2.load()?.calledNumbers, []);
});

test('createEvent and selectEvent fail atomically under a concurrent writer lock, leaving state unchanged', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const before = store.listEvents();
  withDb(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => store.createEvent({ name: 'C', date: '2025-01-03', place: 'Z' }), /locked|busy/i);
      assert.throws(() => store.selectEvent(a.id), /locked|busy/i);
    } finally { db.exec('ROLLBACK'); }
  });
  assert.deepEqual(store.listEvents(), before);
});

test('selectEvent refuses an event whose persisted state is corrupt and keeps the current selection', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const corrupt = [
    { name: 'history', sql: "UPDATE events SET history = '[7,7]' WHERE id = ?" },
    { name: 'phase', sql: "UPDATE events SET phase = 'line_declared' WHERE id = ?" },
  ];
  for (const { name, sql } of corrupt) {
    const b = store.createEvent({ name: `B-${name}`, date: '2025-01-02', place: 'Y' });
    withDb(path, (db) => { db.prepare(sql).run(b.id); });
    assert.throws(() => store.selectEvent(b.id), /invalid/i, name);
    assert.equal(store.listEvents().find((e) => e.id === a.id)?.active, true, name);
    assert.deepEqual(store.load()?.calledNumbers, [], name);
  }
  store.close();
  const reopened = createEventStore(path);
  try { assert.equal(reopened.listEvents().find((e) => e.id === a.id)?.active, true); }
  finally { reopened.close(); }
});

test('updateEventMeta edits only the active event with createEvent rules and survives reopening', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.update((event) => drawManual(event, 12));
  store.transitionPhase('begin_line_check', '2025-01-01T00:00:00.000Z');
  store.saveTheme('high-contrast');
  const before = { event: store.load(), audit: store.readAudit(), theme: store.loadTheme() };
  const updated = store.updateEventMeta(a.id, { name: '  Verbena  ', date: '2026-08-15', place: ' Plaza Mayor ' });
  const expected = { ...a, phase: 'checking_line', name: 'Verbena', date: '2026-08-15', place: 'Plaza Mayor' };
  assert.deepEqual({ ...updated }, expected);
  assert.equal(Object.isFrozen(updated), true);
  assert.deepEqual({ event: store.load(), audit: store.readAudit(), theme: store.loadTheme() }, before);
  assert.deepEqual(store.listEvents().find((event) => event.id === b.id), b, 'another event is untouched');
  store.close();
  const reopened = createEventStore(path);
  try {
    assert.deepEqual(reopened.listEvents().find((event) => event.active), expected);
  } finally { reopened.close(); }
});

test('updateEventMeta rejects invalid metadata, ids, and inactive events without writing', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  const before = store.listEvents();
  const valid = { name: 'N', date: '2025-03-01', place: 'P' };
  const long = 'a'.repeat(121);
  for (const meta of [{ ...valid, name: '  ' }, { ...valid, name: long }, { ...valid, place: '' },
    { ...valid, place: long }, { ...valid, date: '2026-02-30' }, { ...valid, date: '2025-1-1' },
    { ...valid, name: 1 }, { ...valid, date: null }, null]) {
    assert.throws(() => store.updateEventMeta(a.id, meta as never), /invalid/i);
  }
  for (const id of [b.id, randomUUID(), 42, null, '']) {
    assert.throws(() => store.updateEventMeta(id as unknown, valid), /invalid|active/i);
  }
  assert.equal(store.updateEventMeta(a.id, { ...valid, name: 'a'.repeat(120) }).name.length, 120);
  store.updateEventMeta(a.id, { name: 'A', date: '2025-01-01', place: 'X' });
  assert.deepEqual(store.listEvents(), before);
});

test('updateEventMeta fails atomically under a concurrent writer lock', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const before = store.listEvents();
  withDb(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => store.updateEventMeta(a.id, { name: 'N', date: '2025-03-01', place: 'P' }), /locked|busy/i);
    } finally { db.exec('ROLLBACK'); }
  });
  assert.deepEqual(store.listEvents(), before);
});

const prizes = (lineAmount: number, lineLot: string, bingoAmount: number, bingoLot: string) =>
  ({ line: { amount: lineAmount, lot: lineLot }, bingo: { amount: bingoAmount, lot: bingoLot } });
const NONE = prizes(0, '', 0, '');

// Rebuilds a v5 database from a fresh one: the prize and line award tables are the only later additions.
function v5(path: string) {
  const store = createEventStore(path);
  try {
    store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    store.update((event) => drawManual(event, 7));
  } finally { store.close(); }
  withDb(path, (db) => db.exec('DROP TABLE line_awards; DROP TABLE event_prizes; PRAGMA user_version = 5'));
}

test('v5 migrates through v6 to v7 once, adding empty event_prizes and line_awards tables and keeping every event unchanged', (t) => {
  const path = fixture(t);
  v5(path);
  let before: unknown;
  withDb(path, (db) => { before = db.prepare('SELECT * FROM events').all(); });
  const store = createEventStore(path);
  try {
    assert.deepEqual(store.load()?.calledNumbers, [7]);
    assert.deepEqual(store.loadPrizes()?.prizes, NONE);
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT * FROM events').all(), before);
    assert.equal(db.prepare('SELECT count(*) AS count FROM event_prizes').get()?.count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM line_awards').get()?.count, 0);
  });
  createEventStore(path).close();
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION));
});

test('a failed v5 prize migration leaves the v5 database unchanged', (t) => {
  const path = fixture(t);
  v5(path);
  // An object already named event_prizes makes the CREATE TABLE fail inside the migration transaction.
  withDb(path, (db) => db.exec('CREATE VIEW event_prizes AS SELECT 1'));
  assert.throws(() => createEventStore(path), /event_prizes|already exists/i);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name = 'event_prizes'").get()?.type, 'view');
    assert.equal(db.prepare('SELECT history FROM events').get()?.history, '[7]');
  });
});

test('a v1/v2/v3 database migrates in one transaction all the way to the current schema with empty event_prizes', (t) => {
  const path = fixture(t);
  v3(path);
  const store = createEventStore(path);
  try { assert.deepEqual(store.loadPrizes()?.prizes, NONE); } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT count(*) AS count FROM event_prizes').get()?.count, 0);
  });
});

test('the current schema rejects a missing or malformed event_prizes table without writing', (t) => {
  const path = fixture(t);
  const directory = fs.realpathSync(join(path, '..'));
  for (const [name, sql] of [
    ['missing', null],
    ['unbounded', 'CREATE TABLE event_prizes (event_id TEXT PRIMARY KEY, lineAmount INTEGER, lineLot TEXT, bingoAmount INTEGER, bingoLot TEXT)'],
  ] as const) {
    const file = join(directory, `${name}.sqlite`);
    createEventStore(file).close();
    withDb(file, (db) => {
      db.exec('DROP TABLE event_prizes');
      if (sql !== null) db.exec(sql);
    });
    assert.throws(() => createEventStore(file), /invalid event schema: event_prizes/i, name);
    withDb(file, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION));
  }
});

test('updateEventPrizes trims lots, stays scoped to its event, touches nothing else, and survives reopening', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.update((event) => drawManual(event, 12));
  store.saveTheme('high-contrast');
  assert.deepEqual(store.loadPrizes(), { eventId: a.id, prizes: NONE });
  const before = { event: store.load(), theme: store.loadTheme(), events: store.listEvents() };
  const saved = store.updateEventPrizes(a.id, prizes(150, '  Jamón ibérico ', 0, 'Cesta de Navidad'));
  assert.deepEqual(saved, prizes(150, 'Jamón ibérico', 0, 'Cesta de Navidad'));
  assert.equal(Object.isFrozen(saved) && Object.isFrozen(saved.line), true);
  assert.deepEqual({ event: store.load(), theme: store.loadTheme(), events: store.listEvents() }, before);
  store.selectEvent(b.id);
  assert.deepEqual(store.loadPrizes(), { eventId: b.id, prizes: NONE });
  store.updateEventPrizes(b.id, prizes(0, '', 500, ''));
  store.selectEvent(a.id);
  store.close();
  const reopened = createEventStore(path);
  try {
    assert.deepEqual(reopened.loadPrizes(), { eventId: a.id, prizes: prizes(150, 'Jamón ibérico', 0, 'Cesta de Navidad') });
    reopened.selectEvent(b.id);
    assert.deepEqual(reopened.loadPrizes(), { eventId: b.id, prizes: prizes(0, '', 500, '') });
    // Saving again replaces the row rather than adding one.
    reopened.updateEventPrizes(b.id, NONE);
    assert.deepEqual(reopened.loadPrizes()?.prizes, NONE);
  } finally { reopened.close(); }
  withDb(path, (db) => assert.equal(db.prepare('SELECT count(*) AS count FROM event_prizes').get()?.count, 2));
});

test('loadPrizes is null without an active event and updateEventPrizes then has nothing to write', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  assert.equal(store.loadPrizes(), null);
  assert.throws(() => store.updateEventPrizes(randomUUID(), NONE), /active/i);
});

test('updateEventPrizes rejects invalid prizes, ids, and inactive events without writing', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.updateEventPrizes(a.id, prizes(10, 'Lote', 20, ''));
  const committed = store.loadPrizes();
  const bad: unknown[] = [null, 'x', [], {}, { line: NONE.line }, { ...NONE, extra: NONE.line },
    Object.assign(Object.create(null), NONE), { line: { amount: 1 }, bingo: NONE.bingo },
    { line: { ...NONE.line, extra: 1 }, bingo: NONE.bingo }];
  for (const amount of [-1, 100_001, 1.5, Number.NaN, Infinity, '5', null, 10n]) {
    bad.push({ line: { amount, lot: '' }, bingo: NONE.bingo }, { line: NONE.line, bingo: { amount, lot: '' } });
  }
  for (const lot of ['a'.repeat(121), 7, null, undefined]) bad.push({ line: NONE.line, bingo: { amount: 0, lot } });
  bad.forEach((value, index) => assert.throws(() => store.updateEventPrizes(a.id, value), /invalid/i, `case ${index}`));
  for (const id of [b.id, randomUUID(), 42, null, '']) {
    assert.throws(() => store.updateEventPrizes(id as unknown, NONE), /invalid|active/i);
  }
  assert.deepEqual(store.loadPrizes(), committed);
  // Bounds: 100 000 € and a 120-character lot after trimming.
  const max = store.updateEventPrizes(a.id, prizes(100_000, ` ${'l'.repeat(120)} `, 0, ''));
  assert.deepEqual(max, prizes(100_000, 'l'.repeat(120), 0, ''));
  withDb(path, (db) => assert.equal(db.prepare('SELECT count(*) AS count FROM event_prizes WHERE event_id = ?').get(b.id)?.count, 0));
});

test('the prize table CHECKs reject out-of-range, fractional, and non-integer amounts written directly', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.close();
  withDb(path, (db) => {
    const insert = db.prepare(`INSERT INTO event_prizes (event_id, lineAmount, lineLot, bingoAmount, bingoLot)
      VALUES (?, ?, ?, ?, ?)`);
    for (const row of [[-1, ''], [100_001, ''], [1.5, ''], ['cinco', ''], [null, ''], [0, 'l'.repeat(121)], [0, null]]) {
      assert.throws(() => insert.run(a.id, row[0], row[1], 0, ''), /constraint/i, String(row));
    }
    assert.throws(() => insert.run(randomUUID(), 0, '', 0, ''), /constraint/i, 'unknown event');
  });
});

test('tampered stored prizes fail closed on read and keep a corrupt event from becoming active', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  const b = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
  store.updateEventPrizes(a.id, prizes(5, '', 0, ''));
  withDb(path, (db) => {
    db.exec('PRAGMA ignore_check_constraints = 1');
    db.prepare("INSERT INTO event_prizes VALUES (?, 1.5, ' padded ', 0, '')").run(b.id);
  });
  assert.throws(() => store.selectEvent(b.id), /invalid stored prizes/i);
  assert.deepEqual(store.loadPrizes(), { eventId: a.id, prizes: prizes(5, '', 0, '') });
  withDb(path, (db) => {
    db.exec('PRAGMA ignore_check_constraints = 1');
    db.prepare("UPDATE event_prizes SET bingoLot = ? WHERE event_id = ?").run('l'.repeat(121), a.id);
  });
  assert.throws(() => store.loadPrizes(), /invalid stored prizes/i);
  // Startup never reads prizes, so a bad prize row cannot keep the application from opening.
  createEventStore(path).close();
});

test('updateEventPrizes fails atomically under a concurrent writer lock', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  t.after(() => store.close());
  const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  withDb(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => store.updateEventPrizes(a.id, prizes(1, '', 2, '')), /locked|busy/i); }
    finally { db.exec('ROLLBACK'); }
  });
  assert.deepEqual(store.loadPrizes()?.prizes, NONE);
});

// A v6 database exactly as v6 wrote it: the current schema without the line award table.
function v6(path: string) {
  const store = createEventStore(path);
  try {
    const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    store.update((e) => drawManual(e, 7));
    store.transitionPhase('begin_line_check', '2025-01-01T00:00:01.000Z');
    store.updateEventPrizes(event.id, prizes(150, 'Jamón', 20, ''));
  } finally { store.close(); }
  withDb(path, (db) => db.exec('DROP TABLE line_awards; PRAGMA user_version = 6'));
}

const lineAwards = (db: DatabaseSync) => db.prepare('SELECT count(*) AS count FROM line_awards').get()?.count;

test('a fresh database is schema v9 with an empty line_awards table', (t) => {
  const path = fixture(t);
  createEventStore(path).close();
  assert.equal(EVENT_SCHEMA_VERSION, 9);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
    assert.equal(lineAwards(db), 0);
  });
});

test('v6 migrates through v7 and v8 to v9 once, keeping prizes, audit, history and the active drawing event; no awards appear', (t) => {
  const path = fixture(t);
  v6(path);
  let before: unknown;
  withDb(path, (db) => {
    before = [db.prepare('SELECT * FROM events').all(), db.prepare('SELECT * FROM event_prizes').all(),
      db.prepare('SELECT * FROM phase_audit').all(), db.prepare('SELECT * FROM active_event').all()];
  });
  const store = createEventStore(path);
  try {
    assert.deepEqual(store.load()?.calledNumbers, [7]);
    assert.equal(store.load()?.phase, 'checking_line');
    assert.equal(store.readAudit().length, 1);
    assert.deepEqual(store.loadPrizes()?.prizes, prizes(150, 'Jamón', 20, ''));
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
    assert.deepEqual([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT * FROM event_prizes').all(),
      db.prepare('SELECT * FROM phase_audit').all(), db.prepare('SELECT * FROM active_event').all()], before);
    assert.equal(lineAwards(db), 0);
  });
  createEventStore(path).close();
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9));
});

test('every older schema reaches exactly the fresh v9 schema', (t) => {
  const fresh = fixture(t);
  createEventStore(fresh).close();
  let expected: unknown;
  withDb(fresh, (db) => { expected = schemaOf(db); });
  const sources: Record<string, (path: string) => void> = {
    v1: (path) => v1(path), v2: (path) => v2(path), v3: (path) => v3(path),
    v4: (path) => { v4(path, { active: 'pixel-classic', other: 'high-contrast' }); }, v5, v6,
  };
  for (const [name, build] of Object.entries(sources)) {
    const path = fixture(t);
    build(path);
    createEventStore(path).close();
    withDb(path, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9, name);
      assert.deepEqual(schemaOf(db), expected, name);
    });
  }
});

test('a failed v6 to v7 migration leaves the v6 database unchanged', (t) => {
  const path = fixture(t);
  v6(path);
  // An object already named line_awards makes the CREATE TABLE fail inside the migration transaction.
  withDb(path, (db) => db.exec('CREATE VIEW line_awards AS SELECT 1'));
  assert.throws(() => createEventStore(path), /line_awards|already exists/i);
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6);
    assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name = 'line_awards'").get()?.type, 'view');
    assert.equal(db.prepare('SELECT count(*) AS count FROM event_prizes').get()?.count, 1);
  });
});

test('v9 rejects a missing or unconstrained line_awards table without writing', (t) => {
  const directory = fs.realpathSync(join(fixture(t), '..'));
  for (const [name, sql] of [
    ['missing', null],
    ['unconstrained', 'CREATE TABLE line_awards (event_id TEXT PRIMARY KEY, audit_sequence INTEGER, winner_count INTEGER)'],
  ] as const) {
    const file = join(directory, `awards-${name}.sqlite`);
    createEventStore(file).close();
    withDb(file, (db) => {
      db.exec('DROP TABLE line_awards');
      if (sql !== null) db.exec(sql);
    });
    assert.throws(() => createEventStore(file), /invalid event schema: line_awards/i, name);
    withDb(file, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9));
  }
});


// A v7 line_awards table exactly as v7 wrote it: no 'interrupted' presentation status.
const v7Range = (name: string, low: number, high: number) => `CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN ${low} AND ${high})`;
const V7_LINE_AWARDS = `CREATE TABLE line_awards (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES events(id),
  audit_sequence INTEGER NOT NULL ${v7Range('audit_sequence', 1, Number.MAX_SAFE_INTEGER)},
  winner_count INTEGER NOT NULL ${v7Range('winner_count', 1, Number.MAX_SAFE_INTEGER)},
  total_cents INTEGER NOT NULL ${v7Range('total_cents', 0, 10_000_000)},
  share_cents INTEGER NOT NULL ${v7Range('share_cents', 0, 10_000_000)},
  remainder_cents INTEGER NOT NULL ${v7Range('remainder_cents', 0, 10_000_000)},
  lot TEXT NOT NULL CHECK (typeof(lot) = 'text' AND lot = trim(lot) AND length(lot) <= 120),
  lot_resolution TEXT NOT NULL CHECK (lot_resolution IN ('not_required', 'pending', 'resolved')),
  presentation_id TEXT NOT NULL UNIQUE CHECK (typeof(presentation_id) = 'text' AND length(trim(presentation_id)) > 0),
  presentation_status TEXT NOT NULL CHECK (presentation_status IN ('pending', 'failed', 'started', 'completed')),
  presentation_started_at INTEGER CHECK (presentation_started_at IS NULL OR
    typeof(presentation_started_at) = 'integer' AND presentation_started_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}),
  presentation_deadline INTEGER CHECK (presentation_deadline IS NULL OR
    typeof(presentation_deadline) = 'integer' AND presentation_deadline BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}),
  CHECK (share_cents = total_cents / winner_count AND remainder_cents = total_cents % winner_count),
  CHECK (CASE WHEN lot = '' OR winner_count < 2 THEN lot_resolution = 'not_required'
    ELSE lot_resolution IN ('pending', 'resolved') END),
  CHECK (CASE WHEN presentation_status IN ('pending', 'failed')
    THEN presentation_started_at IS NULL AND presentation_deadline IS NULL
    ELSE presentation_started_at IS NOT NULL AND presentation_deadline IS NOT NULL AND
      presentation_deadline > presentation_started_at END),
  FOREIGN KEY (event_id, audit_sequence) REFERENCES phase_audit(event_id, sequence)
)`;
const ORIGINAL_AWARD_COLUMNS = 'event_id, audit_sequence, winner_count, total_cents, share_cents, remainder_cents, lot, lot_resolution, presentation_id, presentation_status, presentation_started_at, presentation_deadline';
const V8_LINE_AWARDS = V7_LINE_AWARDS.replace("'completed'))", "'completed', 'interrupted'))");
const numberedResult = { lot_resolution: 'resolved', lot_result_origin: 'numbered_v1',
  lot_participant_number: 1, lot_color_id: 'red' };
const timedRun = { presentation_started_at: 1000, presentation_deadline: 5000 };
const SHAPES: Record<string, Record<string, unknown>> = { pending: {}, failed: { presentation_status: 'failed' },
  started: { presentation_status: 'started', ...timedRun }, completed: { presentation_status: 'completed', ...timedRun },
  interrupted: { presentation_status: 'interrupted', ...timedRun } };

// One directly declared event per status, written raw so every status exists independent of the lifecycle API.
function seedAwards(path: string, statuses: string[]) {
  const store = createEventStore(path);
  const ids = statuses.map((status, index) => {
    const event = store.createEvent({ name: `E${index}`, date: '2025-01-01', place: 'X' });
    rawDirect(path, event.id);
    insertAward(path, event.id, { ...SHAPES[status], presentation_id: `p-${index}` });
    return event.id;
  });
  return { store, ids };
}

// Rewrites the current database as a v7 one: same rows, the v7 table, user_version 7.
function downgradeToV7(path: string, corrupt = '') {
  withDb(path, (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    const rows = db.prepare(`SELECT ${ORIGINAL_AWARD_COLUMNS} FROM line_awards`).all();
    db.exec(`DROP TABLE line_awards; ${V7_LINE_AWARDS}`);
    for (const row of rows) {
      const names = Object.keys(row);
      db.prepare(`INSERT INTO line_awards (${names.join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`).run(row as never);
    }
    if (corrupt !== '') db.exec(`PRAGMA ignore_check_constraints = 1; ${corrupt}`);
    db.exec('PRAGMA user_version = 7');
  });
}

// Frozen v8 rows are copied without current result columns or current provenance guards.
function frozenV8(path: string, resolved = true) {
  const { store } = seedAwards(path, ['pending', 'failed', 'started', 'completed', 'interrupted']);
  store.close();
  withDb(path, (db) => {
    const rows = db.prepare(`SELECT ${ORIGINAL_AWARD_COLUMNS} FROM line_awards`).all();
    db.exec(`DROP TABLE line_awards; ${V8_LINE_AWARDS}`);
    for (const row of rows) {
      const names = Object.keys(row);
      db.prepare(`INSERT INTO line_awards (${names.join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`)
        .run({ ...row, lot: 'Jamón', lot_resolution: resolved ? 'resolved' : 'pending' } as never);
    }
    db.exec("UPDATE events SET history = '[7,42]'");
    db.prepare('INSERT INTO event_prizes (event_id, lineAmount, lineLot, bingoAmount, bingoLot) VALUES (?, 10, ?, 20, ?)')
      .run(rows[0].event_id as string, 'Jamón', 'Cesta');
    db.exec('PRAGMA user_version = 8');
  });
}

const resultRows = (db: DatabaseSync) => db.prepare(`SELECT lot_resolution, lot_result_origin,
  lot_participant_number, lot_color_id FROM line_awards ORDER BY presentation_id`).all();

test('LOT-02A frozen v8 resolved rows preserve all facts, remain readable and reopen idempotently', (t) => {
  const path = fixture(t);
  frozenV8(path);
  const before = dump(path);
  const oldSql = awardsSql(path);
  assert.doesNotMatch(oldSql, /lot_result_origin/);
  const fresh = fixture(t);
  createEventStore(fresh).close();
  let expected: unknown;
  withDb(fresh, (db) => { expected = schemaOf(db); });
  for (let open = 0; open < 2; open++) {
    const store = createEventStore(path);
    try {
      assert.deepEqual(dump(path), before);
      for (const event of store.listEvents()) {
        store.selectEvent(event.id);
        const award = store.loadLineAward();
        assert.equal(award?.award.lotResolution, 'resolved');
        assert.equal(award?.presentation.id, `p-${event.name.slice(1)}`);
        assert.equal(award?.presentation.status, ['pending', 'failed', 'started', 'completed', 'interrupted'][Number(event.name.slice(1))]);
      }
    } finally { store.close(); }
    // Restore the original pointer changed only by this test's explicit event selection.
    withDb(path, (db) => {
      const original = (before as Array<Array<Record<string, unknown>>>)[4][0];
      db.prepare('UPDATE active_event SET event_id = ?').run(original.event_id as string);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
      assert.deepEqual(schemaOf(db), expected);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const row of resultRows(db)) assert.deepEqual({ ...row }, { lot_resolution: 'resolved',
        lot_result_origin: 'legacy_v8', lot_participant_number: null, lot_color_id: null });
    });
    assert.deepEqual(dump(path), before);
  }
  withDb(path, (db) => {
    db.exec("UPDATE line_awards SET presentation_status = 'started', presentation_started_at = 2000, presentation_deadline = 6000 WHERE presentation_id = 'p-0'");
    db.exec("UPDATE line_awards SET presentation_status = 'completed' WHERE presentation_id = 'p-0'");
    for (const set of ["lot_result_origin = 'none', lot_resolution = 'pending'", "lot_result_origin = 'numbered_v1', lot_participant_number = 1, lot_color_id = 'red'",
      'winner_count = 4, share_cents = 250, remainder_cents = 0', "lot = 'Otro'", 'audit_sequence = 2', "event_id = 'ghost'"]) {
      assert.throws(() => db.exec(`UPDATE line_awards SET ${set} WHERE presentation_id = 'p-0'`), /legacy/i, set);
    }
    assert.throws(() => db.exec(`INSERT INTO line_awards SELECT * FROM line_awards WHERE presentation_id = 'p-0'`), /legacy/i);
  });
  const lifecycle = createEventStore(path);
  try {
    for (const [name, id, intent] of [['E1', 'p-1', 'retry'], ['E4', 'p-4', 'replay']] as const) {
      lifecycle.selectEvent(lifecycle.listEvents().find((e) => e.name === name)!.id);
      const pending = intent === 'retry' ? lifecycle.retryLinePresentation(id) : lifecycle.replayLinePresentation(id);
      assert.notEqual(pending.presentation.id, id);
      lifecycle.startLinePresentation(pending.presentation.id, 10000);
      const completed = lifecycle.completeLinePresentation(pending.presentation.id, 14000);
      assert.equal(completed.award.lotResolution, 'resolved');
      assert.equal(completed.presentation.status, 'completed');
    }
  } finally { lifecycle.close(); }
});

test('LOT-02A v8 pending rows get no result; failed rebuild rolls back schema, version and rows', (t) => {
  const pending = fixture(t);
  frozenV8(pending, false);
  createEventStore(pending).close();
  withDb(pending, (db) => {
    for (const row of resultRows(db)) assert.deepEqual({ ...row }, { lot_resolution: 'pending',
      lot_result_origin: 'none', lot_participant_number: null, lot_color_id: null });
  });
  for (const corrupt of ['share_cents = 1', "event_id = 'ghost'"]) {
    const path = fixture(t);
    frozenV8(path);
    withDb(path, (db) => db.exec(`PRAGMA ignore_check_constraints = ON; PRAGMA foreign_keys = OFF;
      UPDATE line_awards SET ${corrupt} WHERE presentation_id = 'p-0'`));
    const before = dump(path);
    let schema: unknown;
    withDb(path, (db) => { schema = schemaOf(db); });
    assert.throws(() => createEventStore(path), /constraint|CHECK|FOREIGN/i);
    withDb(path, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 8);
      assert.deepEqual(schemaOf(db), schema);
    });
    assert.deepEqual(dump(path), before);
  }
});

test('LOT-02A fresh and migrated provenance reject NULL bypasses, forged legacy and wrong v1 mapping', (t) => {
  for (const migrated of [false, true]) {
    const path = fixture(t);
    if (migrated) {
      frozenV8(path, false);
      createEventStore(path).close();
      withDb(path, (db) => db.exec('DELETE FROM line_awards'));
    }
    const { store, event } = directEvent(path);
    store.close();
    const valid = { lot: 'Jamón', ...numberedResult, ...SHAPES.completed };
    const invalid = [
      { lot_result_origin: null }, { lot_result_origin: 'future' }, { lot_result_origin: 'legacy_v8' },
      { lot_participant_number: null }, { lot_color_id: null }, { lot_color_id: 'blue' },
      { lot_participant_number: 0 }, { lot_participant_number: 4 }, { lot_participant_number: 1.5 },
      { lot_participant_number: Number.MAX_SAFE_INTEGER + 2 }, { lot_participant_number: 'one' },
      { lot_color_id: 'future' }, { lot_result_origin: 'none' }, { lot: '' },
      { lot_resolution: 'pending' }, { lot_resolution: 'not_required' },
      { presentation_status: 'pending', presentation_started_at: null, presentation_deadline: null },
      { ...SHAPES.failed, presentation_started_at: null, presentation_deadline: null },
      SHAPES.started, SHAPES.interrupted,
    ];
    for (const change of invalid) assert.throws(() => insertAward(path, event.id, { ...valid, ...change }), /constraint|CHECK|legacy/i);
    for (const resolution of ['pending', 'not_required']) {
      for (const change of [{ lot_participant_number: 1 }, { lot_color_id: 'red' }, { ...numberedResult, lot_resolution: resolution }]) {
        assert.throws(() => insertAward(path, event.id, { lot: resolution === 'pending' ? 'Jamón' : '',
          lot_resolution: resolution, ...change }), /constraint|CHECK/i);
      }
    }
    insertAward(path, event.id, { lot: 'Jamón', lot_resolution: 'pending' });
    withDb(path, (db) => {
      assert.throws(() => db.exec(`UPDATE line_awards SET lot_resolution = 'resolved', lot_result_origin = 'legacy_v8'
        WHERE event_id = '${event.id}'`), /legacy/i);
      db.prepare('DELETE FROM line_awards WHERE event_id = ?').run(event.id);
    });
    // Palette v1 is durable, including repeated colors and the full safe-integer boundary.
    for (const [number, color] of [[1, 'red'], [2, 'blue'], [3, 'green'], [4, 'yellow'], [5, 'purple'],
      [6, 'orange'], [7, 'red'], [Number.MAX_SAFE_INTEGER, 'red']] as const) {
      insertAward(path, event.id, { ...valid, winner_count: Number.MAX_SAFE_INTEGER, share_cents: 0,
        remainder_cents: 1000, lot_participant_number: number, lot_color_id: color });
      withDb(path, (db) => {
        assert.throws(() => db.prepare('UPDATE line_awards SET lot_color_id = ? WHERE event_id = ?')
          .run(color === 'blue' ? 'red' : 'blue', event.id), /CHECK/i);
      });
      withDb(path, (db) => db.prepare('DELETE FROM line_awards WHERE event_id = ?').run(event.id));
    }
    for (const guard of ['line_awards_no_legacy_insert', 'line_awards_no_legacy_update']) {
      let sql = '';
      withDb(path, (db) => {
        sql = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(guard)?.sql as string;
        db.exec(`DROP TRIGGER ${guard}`);
      });
      assert.throws(() => createEventStore(path), /schema.*guard/i);
      withDb(path, (db) => db.exec(sql));
    }
  }
});

const awardsSql = (path: string) => {
  let sql: unknown;
  withDb(path, (db) => { sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'line_awards'").get()?.sql; });
  return String(sql);
};

test('v7 migrates through v8 to v9 once, keeping every award row, id, time and status; opening interrupts nothing', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['pending', 'failed', 'started', 'completed']);
  store.close();
  downgradeToV7(path);
  assert.doesNotMatch(awardsSql(path), /interrupted/);
  const before = JSON.stringify(dump(path));
  const reopened = createEventStore(path);
  try {
    assert.equal(JSON.stringify(dump(path)), before);
    assert.equal(reopened.selectEvent(ids[2]).id, ids[2]);
    assert.deepEqual(reopened.loadLineAward()?.presentation, { id: 'p-2', status: 'started', startedAt: 1000, deadlineAt: 5000 });
  } finally { reopened.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(db.prepare('SELECT presentation_status AS s FROM line_awards ORDER BY presentation_id').all().map((r) => r.s),
      ['pending', 'failed', 'started', 'completed']);
  });
  createEventStore(path).close();
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9));
});

test('a migrated v7 awards table equals the fresh v9 table and enforces the same foreign key and unique id', (t) => {
  const fresh = fixture(t);
  createEventStore(fresh).close();
  const path = fixture(t);
  const { store } = seedAwards(path, ['started']);
  store.close();
  downgradeToV7(path);
  createEventStore(path).close();
  assert.equal(awardsSql(path).replace(/\s/g, ''), awardsSql(fresh).replace(/\s/g, ''));
  withDb(path, (db) => {
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => db.exec(`INSERT INTO line_awards (${ORIGINAL_AWARD_COLUMNS}) SELECT 'ghost', audit_sequence, winner_count, total_cents,
      share_cents, remainder_cents, lot, lot_resolution, 'other', presentation_status, presentation_started_at,
      presentation_deadline FROM line_awards`), /FOREIGN/i);
    assert.throws(() => db.exec("UPDATE line_awards SET presentation_status = 'interrupted', presentation_started_at = NULL"), /CHECK/i);
    assert.throws(() => db.exec("UPDATE line_awards SET presentation_status = 'bogus'"), /CHECK/i);
    db.exec("UPDATE line_awards SET presentation_status = 'interrupted'");
  });
});

test('a failed v7 to v8 migration leaves the v7 database and rows unchanged and never normalizes corruption', (t) => {
  for (const [name, corrupt] of [
    ['check violation', "UPDATE line_awards SET share_cents = 1"],
    ['dangling event', "PRAGMA foreign_keys = OFF; UPDATE line_awards SET event_id = 'gone'"],
  ] as const) {
    const path = fixture(t);
    const { store } = seedAwards(path, ['started']);
    store.close();
    downgradeToV7(path, corrupt);
    const before = JSON.stringify(dump(path));
    assert.throws(() => createEventStore(path), /constraint|CHECK|FOREIGN/i, name);
    withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7, name));
    assert.doesNotMatch(awardsSql(path), /interrupted/, name);
    assert.equal(JSON.stringify(dump(path)), before, name);
  }
  const path = fixture(t);
  createEventStore(path).close();
  downgradeToV7(path);
  withDb(path, (db) => db.exec('DROP TABLE line_awards; CREATE TABLE line_awards (event_id TEXT PRIMARY KEY); PRAGMA user_version = 7'));
  assert.throws(() => createEventStore(path), /invalid event schema: line_awards/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7));
});

test('the line_awards table enforces its row constraints on directly written rows', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.transitionPhase('begin_line_check', '2025-01-01T00:00:01.000Z');
  store.close();
  const base = { event_id: event.id, audit_sequence: 1, winner_count: 3, total_cents: 1000, share_cents: 333,
    remainder_cents: 1, lot: '', lot_resolution: 'not_required', presentation_id: 'p-1',
    presentation_status: 'pending', presentation_started_at: null, presentation_deadline: null };
  const MAX = Number.MAX_SAFE_INTEGER;
  const started = { presentation_status: 'started', presentation_started_at: 1000, presentation_deadline: 5000 };
  const lot = { lot: 'Jamón', lot_resolution: 'pending' };
  const invalid: Record<string, Record<string, unknown>> = {
    'zero winners': { winner_count: 0, share_cents: 1000, remainder_cents: 0 },
    'fractional winners': { winner_count: 2.5 },
    'text winners': { winner_count: 'three' },
    'total above maximum': { total_cents: 10_000_001 },
    'negative total': { total_cents: -1, share_cents: 0, remainder_cents: 0 },
    'wrong share': { share_cents: 334 },
    'wrong remainder': { remainder_cents: 2 },
    'assigned remainder': { share_cents: 334, remainder_cents: 0 },
    'untrimmed lot': { lot: ' Jamón ', lot_resolution: 'pending' },
    'overlong lot': { lot: 'l'.repeat(121), lot_resolution: 'pending' },
    'unknown resolution': { lot_resolution: 'maybe' },
    'lot without pending tie': { lot: 'Jamón' },
    'pending without lot': { lot_resolution: 'pending' },
    'pending lone winner': { ...lot, winner_count: 1, total_cents: 1000, share_cents: 1000, remainder_cents: 0 },
    'blank presentation id': { presentation_id: '   ' },
    'unknown status': { presentation_status: 'running' },
    'pending with times': { presentation_started_at: 1000, presentation_deadline: 5000 },
    'started without times': { presentation_status: 'started' },
    'started with one time': { ...started, presentation_deadline: null },
    'deadline not after start': { ...started, presentation_deadline: 1000 },
    'negative start': { ...started, presentation_started_at: -1 },
    'unsafe deadline': { ...started, presentation_deadline: MAX + 2 },
    'fractional time': { ...started, presentation_started_at: 1000.5 },
    'interrupted without times': { presentation_status: 'interrupted' },
    'interrupted with one time': { ...started, presentation_status: 'interrupted', presentation_deadline: null },
    'failed with times': { presentation_status: 'failed', presentation_started_at: 1000, presentation_deadline: 5000 },
    'missing audit row': { audit_sequence: 2 },
    'unknown event': { event_id: 'missing' },
    // A NULL key would bypass both foreign keys, so even an otherwise valid row must be rejected.
    'null event': { event_id: null },
    'null event with unknown audit row': { event_id: null, audit_sequence: 99 },
  };
  withDb(path, (db) => {
    db.exec('PRAGMA foreign_keys = ON');
    const insert = (row: Record<string, unknown>) => db.prepare(`INSERT INTO line_awards
      (event_id, audit_sequence, winner_count, total_cents, share_cents, remainder_cents, lot, lot_resolution,
       presentation_id, presentation_status, presentation_started_at, presentation_deadline,
       lot_result_origin, lot_participant_number, lot_color_id)
      VALUES (:event_id, :audit_sequence, :winner_count, :total_cents, :share_cents, :remainder_cents, :lot,
       :lot_resolution, :presentation_id, :presentation_status, :presentation_started_at, :presentation_deadline,
       :lot_result_origin, :lot_participant_number, :lot_color_id)`)
      .run({ lot_result_origin: 'none', lot_participant_number: null, lot_color_id: null, ...row } as never);
    for (const [name, change] of Object.entries(invalid)) {
      assert.throws(() => insert({ ...base, ...change }), /constraint|CHECK|FOREIGN/i, name);
    }
    assert.equal(lineAwards(db), 0);
    // Boundary values and every status/lot shape the later writer may need are accepted, one row per event.
    for (const [name, change] of Object.entries({
      'maximum winners': { winner_count: MAX, share_cents: 0, remainder_cents: 1000 },
      'pending tie': lot,
      'resolved tie': { ...lot, ...numberedResult, ...SHAPES.completed },
      'failed': { presentation_status: 'failed' },
      'completed': { ...started, presentation_status: 'completed' },
      'interrupted keeps its times': { ...started, presentation_status: 'interrupted' },
    })) {
      insert({ ...base, ...change });
      db.prepare('DELETE FROM line_awards').run();
      assert.equal(lineAwards(db), 0, name);
    }
    insert(base);
    assert.throws(() => insert({ ...base, presentation_id: 'p-2' }), /constraint|UNIQUE|PRIMARY/i, 'second award');
    db.prepare("INSERT INTO events (id, name, date, place, history, createdAt) VALUES ('e2', 'B', '2025-01-02', 'Y', '[]', '2025')").run();
    db.prepare("INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase) VALUES ('e2', 1, '2025', 'begin_line_check', 'drawing', 'checking_line')").run();
    assert.throws(() => insert({ ...base, event_id: 'e2' }), /constraint|UNIQUE/i, 'reused presentation id');
  });
});

// ---- loadLineAward: validated read of the active event's first-line award ----
const awardRow = { audit_sequence: 1, winner_count: 3, total_cents: 1000, share_cents: 333, remainder_cents: 1,
  lot: '', lot_resolution: 'not_required', presentation_id: 'p-1', presentation_status: 'pending',
  presentation_started_at: null, presentation_deadline: null };

function insertAward(path: string, eventId: string, change: Record<string, unknown> = {}, bypass = false) {
  withDb(path, (db) => {
    if (bypass) db.exec('PRAGMA ignore_check_constraints = 1; PRAGMA foreign_keys = OFF');
    db.prepare(`INSERT INTO line_awards (event_id, audit_sequence, winner_count, total_cents, share_cents,
      remainder_cents, lot, lot_resolution, presentation_id, presentation_status, presentation_started_at,
      presentation_deadline, lot_result_origin, lot_participant_number, lot_color_id)
      VALUES (:event_id, :audit_sequence, :winner_count, :total_cents, :share_cents,
      :remainder_cents, :lot, :lot_resolution, :presentation_id, :presentation_status,
      :presentation_started_at, :presentation_deadline, :lot_result_origin, :lot_participant_number, :lot_color_id)`)
      .run({ ...awardRow, lot_result_origin: 'none', lot_participant_number: null, lot_color_id: null,
        ...change, event_id: eventId } as never);
  });
}

// Raw setup of a direct-declared state (audit row + event phase), independent of the atomic writer.
function rawDirect(path: string, eventId: string, at = '2025-01-01T00:00:01.000Z') {
  withDb(path, (db) => {
    db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
      VALUES (?, 1, ?, 'declare_line_directly', 'drawing', 'line_declared')`).run(eventId, at);
    db.prepare("UPDATE events SET phase = 'line_declared', lastTransitionAt = ? WHERE id = ?").run(at, eventId);
  });
}

// An event whose only audit row is the direct drawing -> line_declared intent, written raw.
function directEvent(path: string, name = 'A') {
  const store = createEventStore(path);
  const event = store.createEvent({ name, date: '2025-01-01', place: 'X' });
  rawDirect(path, event.id);
  return { store, event };
}

test('loadLineAward is null without an active event, for a fresh drawing event and for legacy declared audits', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.equal(store.loadLineAward(), null);
    store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    assert.equal(store.loadLineAward(), null);
    for (const [intent, at] of [['begin_line_check', 2], ['declare_line', 3], ['begin_bingo_check', 4],
      ['declare_bingo', 5], ['finish', 6]] as const) {
      store.transitionPhase(intent, `2025-01-01T00:00:0${at}.000Z`);
      assert.equal(store.loadLineAward(), null, intent);
    }
  } finally { store.close(); }
  const migrated = fixture(t);
  v6(migrated);
  const reopened = createEventStore(migrated);
  try { assert.equal(reopened.loadLineAward(), null); } finally { reopened.close(); }
});

test('loadLineAward returns the validated award, frozen and independent of prize edits', (t) => {
  const path = fixture(t);
  const { store, event } = directEvent(path);
  try {
    store.updateEventPrizes(event.id, { line: { amount: 10, lot: '' }, bingo: { amount: 0, lot: '' } });
    insertAward(path, event.id);
    const loaded = store.loadLineAward();
    assert.deepEqual(loaded, { eventId: event.id,
      award: { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: '', lotResolution: 'not_required' },
      presentation: { id: 'p-1', status: 'pending', startedAt: null, deadlineAt: null } });
    assert.ok(loaded && Object.isFrozen(loaded) && Object.isFrozen(loaded.award) && Object.isFrozen(loaded.presentation));
    store.updateEventPrizes(event.id, { line: { amount: 99, lot: 'Otro' }, bingo: { amount: 0, lot: '' } });
    assert.equal(store.loadLineAward()?.award.totalCents, 1000);
    assert.notEqual(store.loadLineAward(), loaded);
  } finally { store.close(); }
});

test('loadLineAward accepts every valid presentation and lot shape without changing status over time', (t) => {
  const path = fixture(t);
  const { store, event } = directEvent(path);
  const MAX = Number.MAX_SAFE_INTEGER;
  const started = { presentation_status: 'started', presentation_started_at: 1000, presentation_deadline: 5000 };
  const lot = { lot: 'Jamón', lot_resolution: 'pending' };
  const cases: Array<[string, Record<string, unknown>, (value: NonNullable<ReturnType<typeof store.loadLineAward>>) => void]> = [
    ['failed', { presentation_status: 'failed' }, (v) => assert.equal(v.presentation.status, 'failed')],
    ['started past its deadline stays started', { ...started, presentation_deadline: 2000 },
      (v) => assert.deepEqual(v.presentation, { id: 'p-1', status: 'started', startedAt: 1000, deadlineAt: 2000 })],
    ['completed keeps its deadline', { ...started, presentation_status: 'completed' },
      (v) => assert.deepEqual(v.presentation, { id: 'p-1', status: 'completed', startedAt: 1000, deadlineAt: 5000 })],
    ['pending tied lot', lot, (v) => assert.deepEqual([v.award.lot, v.award.lotResolution], ['Jamón', 'pending'])],
    ['resolved tied lot', { ...lot, ...numberedResult, ...SHAPES.completed }, (v) => assert.equal(v.award.lotResolution, 'resolved')],
    ['lone winner lot', { ...lot, lot_resolution: 'not_required', winner_count: 1, share_cents: 1000, remainder_cents: 0 },
      (v) => assert.deepEqual([v.award.lot, v.award.lotResolution, v.award.remainderCents], ['Jamón', 'not_required', 0])],
    ['even split', { winner_count: 4, share_cents: 250, remainder_cents: 0 },
      (v) => assert.deepEqual([v.award.shareCents, v.award.remainderCents, v.award.lotResolution], [250, 0, 'not_required'])],
    ['maximum winners', { winner_count: MAX, share_cents: 0, remainder_cents: 1000 },
      (v) => assert.deepEqual([v.award.winnerCount, v.award.shareCents, v.award.remainderCents], [MAX, 0, 1000])],
  ];
  try {
    for (const [name, change, check] of cases) {
      withDb(path, (db) => db.exec('DELETE FROM line_awards'));
      insertAward(path, event.id, change);
      const loaded = store.loadLineAward();
      assert.ok(loaded, name);
      check(loaded);
    }
  } finally { store.close(); }
});

test('loadLineAward reads only the active event and never mixes events', (t) => {
  const path = fixture(t);
  const { store, event } = directEvent(path, 'A');
  try {
    const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    insertAward(path, event.id);
    assert.equal(store.loadLineAward()?.eventId, event.id);
    store.selectEvent(other.id);
    assert.equal(store.loadLineAward(), null);
    store.selectEvent(event.id);
    assert.equal(store.loadLineAward()?.eventId, event.id);
  } finally { store.close(); }
});

test('loadLineAward fails closed on corrupted rows instead of returning null or coercing', (t) => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const started = { presentation_status: 'started', presentation_started_at: 1000, presentation_deadline: 5000 };
  const lot = { lot: 'Jamón', lot_resolution: 'pending' };
  const corrupt: Record<string, Record<string, unknown>> = {
    'wrong share': { share_cents: 334 },
    'assigned remainder': { share_cents: 334, remainder_cents: 0 },
    'wrong remainder': { remainder_cents: 2 },
    'zero winners': { winner_count: 0, share_cents: 1000, remainder_cents: 0 },
    'fractional winners': { winner_count: 2.5 },
    'text winners': { winner_count: 'three' },
    'winners beyond safe integer': { winner_count: MAX + 2 },
    'negative total': { total_cents: -1, share_cents: 0, remainder_cents: 0 },
    'total above maximum': { total_cents: 10_000_100, share_cents: 3_333_366, remainder_cents: 2 },
    'not whole euros': { total_cents: 1050, share_cents: 350, remainder_cents: 0 },
    'untrimmed lot': { lot: ' Jamón ', lot_resolution: 'pending' },
    'lot with JS-only whitespace': { lot: '\u00a0Jamón', lot_resolution: 'pending' },
    'overlong lot': { lot: 'l'.repeat(121), lot_resolution: 'pending' },
    'unknown resolution': { lot_resolution: 'maybe' },
    'lot without tie': { lot: 'Jamón' },
    'pending without lot': { lot_resolution: 'pending' },
    'pending lone winner': { ...lot, winner_count: 1, share_cents: 1000, remainder_cents: 0 },
    'resolved without lot': { lot_resolution: 'resolved' },
    'resolved lone winner': { ...lot, lot_resolution: 'resolved', winner_count: 1, share_cents: 1000, remainder_cents: 0 },
    'empty presentation id': { presentation_id: '' },
    'blank presentation id': { presentation_id: ' \u00a0 ' },
    'unknown status': { presentation_status: 'running' },
    'pending with times': { presentation_started_at: 1000, presentation_deadline: 5000 },
    'failed with times': { presentation_status: 'failed', presentation_started_at: 1000, presentation_deadline: 5000 },
    'started without times': { presentation_status: 'started' },
    'started with one time': { ...started, presentation_deadline: null },
    'completed without deadline': { ...started, presentation_status: 'completed', presentation_deadline: null },
    'deadline not after start': { ...started, presentation_deadline: 1000 },
    'negative start': { ...started, presentation_started_at: -1 },
    'fractional time': { ...started, presentation_started_at: 1000.5 },
    'time beyond safe integer': { ...started, presentation_deadline: MAX + 2 },
    'audit row missing': { audit_sequence: 5 },
  };
  for (const [name, change] of Object.entries(corrupt)) {
    const path = fixture(t);
    const { store, event } = directEvent(path);
    try {
      insertAward(path, event.id, change, true);
      assert.throws(() => store.loadLineAward(), /invalid stored line award/i, name);
    } finally { store.close(); }
  }
});

test('loadLineAward requires the exact direct intent in the linked audit row', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    store.transitionPhase('begin_line_check', '2025-01-01T00:00:01.000Z');
    store.transitionPhase('declare_line', '2025-01-01T00:00:02.000Z');
    insertAward(path, event.id, { audit_sequence: 1 });
    assert.throws(() => store.loadLineAward(), /invalid stored line award/i, 'checking intent');
    withDb(path, (db) => db.exec('DELETE FROM line_awards'));
    insertAward(path, event.id, { audit_sequence: 2 });
    assert.throws(() => store.loadLineAward(), /invalid stored line award/i, 'legacy declare_line');
    withDb(path, (db) => db.exec('DELETE FROM line_awards'));
    assert.equal(store.loadLineAward(), null);
  } finally { store.close(); }
});

test('loadLineAward accepts an award after normal progression and rejects a tampered audit', (t) => {
  const path = fixture(t);
  const { store, event } = directEvent(path);
  try {
    insertAward(path, event.id, { presentation_status: 'completed', presentation_started_at: 1000,
      presentation_deadline: 5000 });
    store.transitionPhase('begin_bingo_check', '2025-01-01T00:00:02.000Z');
    assert.equal(store.loadLineAward()?.award.winnerCount, 3);
    withDb(path, (db) => {
      db.exec('DROP TRIGGER phase_audit_no_update');
      db.exec("UPDATE phase_audit SET to_phase = 'finished' WHERE sequence = 1");
    });
    assert.throws(() => store.loadLineAward(), /invalid/i);
  } finally { store.close(); }
});

test('loadLineAward never writes and leaves ordinary reads unchanged', (t) => {
  const path = fixture(t);
  const { store, event } = directEvent(path);
  try {
    insertAward(path, event.id);
    let before: unknown;
    withDb(path, (db) => { before = [db.prepare('SELECT * FROM line_awards').all(), db.prepare('SELECT * FROM phase_audit').all()]; });
    store.loadLineAward();
    withDb(path, (db) => assert.deepEqual([db.prepare('SELECT * FROM line_awards').all(),
      db.prepare('SELECT * FROM phase_audit').all()], before));
    assert.equal(store.load()?.phase, 'line_declared');
    assert.equal(store.readAudit().length, 1);
    assert.equal(store.loadPrizes()?.eventId, event.id);
  } finally { store.close(); }
});

// ---- loadLineDeclarationBaseline: frozen read-only baseline for a future direct first-line declaration (FL-03a1) ----
const T1 = '2025-01-01T00:00:01.000Z';
const T2 = '2025-01-01T00:00:02.000Z';
const T3 = '2025-01-01T00:00:03.000Z';

function openDrawing(t: unknown, line = { amount: 10, lot: '' }) {
  const path = fixture(t);
  const store = createEventStore(path);
  const event = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(event.id, { line, bingo: { amount: 0, lot: '' } });
  return { path, store, event };
}

const dump = (path: string) => {
  let state: unknown;
  withDb(path, (db) => {
    state = ['events', 'phase_audit', 'line_awards', 'event_prizes', 'active_event']
      .map((table) => db.prepare(`SELECT ${table === 'line_awards' ? ORIGINAL_AWARD_COLUMNS : '*'} FROM ${table}`).all());
  });
  return state;
};

test('loadLineDeclarationBaseline returns one frozen snapshot of the full ordered draw, phase head and line prize', (t) => {
  const { path, store, event } = openDrawing(t, { amount: 10, lot: 'Jamón' });
  try {
    store.update((e) => drawManual(drawManual(e, 7), 42));
    const baseline = store.loadLineDeclarationBaseline();
    assert.deepEqual(baseline, { eventId: event.id, calledNumbers: [7, 42], phase: 'drawing', lastTransitionAt: null,
      auditSequence: 0, linePrize: { amount: 10, lot: 'Jamón' } });
    assert.ok(Object.isFrozen(baseline) && Object.isFrozen(baseline.calledNumbers) && Object.isFrozen(baseline.linePrize));
    assert.throws(() => (baseline.calledNumbers as number[]).push(1), TypeError);
    assert.notEqual(store.loadLineDeclarationBaseline(), baseline);
    const before = dump(path);
    store.loadLineDeclarationBaseline();
    assert.deepEqual(dump(path), before);
  } finally { store.close(); }
});

test('the baseline follows every draw, prize edit and phase head, and records the audit length', (t) => {
  const { store, event } = openDrawing(t);
  try {
    const first = store.loadLineDeclarationBaseline();
    store.update((e) => drawManual(e, 5));
    assert.deepEqual(store.loadLineDeclarationBaseline().calledNumbers, [5]);
    store.updateEventPrizes(event.id, { line: { amount: 11, lot: 'Cesta' }, bingo: { amount: 0, lot: '' } });
    assert.deepEqual(store.loadLineDeclarationBaseline().linePrize, { amount: 11, lot: 'Cesta' });
    store.transitionPhase('begin_line_check', T1);
    store.transitionPhase('reject_line_claim', T2);
    const head = store.loadLineDeclarationBaseline();
    assert.deepEqual([head.lastTransitionAt, head.auditSequence], [T2, 2]);
    assert.deepEqual(first.calledNumbers, []);
  } finally { store.close(); }
});

test('the baseline reads the active event only', (t) => {
  const { store, event } = openDrawing(t);
  try {
    const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    store.update((e) => drawManual(e, 3));
    assert.deepEqual(store.loadLineDeclarationBaseline().calledNumbers, [3]);
    store.selectEvent(other.id);
    const baseline = store.loadLineDeclarationBaseline();
    assert.deepEqual([baseline.eventId, baseline.calledNumbers], [other.id, []]);
  } finally { store.close(); }
});

test('the baseline is ineligible without an event, outside drawing, or with an attached award', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.throws(() => store.loadLineDeclarationBaseline(), /not eligible|no current event|does not exist/i);
    store.create();
    assert.deepEqual(store.loadLineDeclarationBaseline().linePrize, { amount: 0, lot: '' });
    store.transitionPhase('begin_line_check', T1);
    assert.throws(() => store.loadLineDeclarationBaseline(), /not eligible/i);
    store.transitionPhase('declare_line', T2);
    assert.throws(() => store.loadLineDeclarationBaseline(), /not eligible/i);
  } finally { store.close(); }
  const awarded = openDrawing(t);
  try {
    rawDirect(awarded.path, awarded.event.id, T1);
    insertAward(awarded.path, awarded.event.id);
    assert.throws(() => awarded.store.loadLineDeclarationBaseline(), /not eligible/i);
  } finally { awarded.store.close(); }
});

test('a legacy declaration corrected back to drawing without an award stays eligible', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    store.create();
    store.transitionPhase('begin_line_check', T1);
    store.transitionPhase('declare_line', T2);
    assert.equal(store.transitionPhase('correct_line_declaration', T3).phase, 'drawing');
    const baseline = store.loadLineDeclarationBaseline();
    assert.deepEqual([baseline.phase, baseline.lastTransitionAt, baseline.auditSequence], ['drawing', T3, 3]);
  } finally { store.close(); }
});

test('a prior direct declaration audit is ineligible even when corrected back to drawing without an award', (t) => {
  const { path, store, event } = openDrawing(t);
  try {
    rawDirect(path, event.id, T1);
    assert.equal(store.transitionPhase('correct_line_declaration', T2).phase, 'drawing');
    assert.throws(() => store.loadLineDeclarationBaseline(), /not eligible/i);
  } finally { store.close(); }
});

test('the baseline snapshot read does not leave a write transaction blocked', (t) => {
  const { path, store } = openDrawing(t);
  t.after(() => store.close());
  store.loadLineDeclarationBaseline();
  withDb(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  });
  assert.throws(() => { store.transitionPhase('begin_line_check', T1); store.loadLineDeclarationBaseline(); }, /not eligible/i);
  store.transitionPhase('reject_line_claim', T2);
  assert.equal(store.loadLineDeclarationBaseline().auditSequence, 2);
});

const setAward = (path: string, set: string) => withDb(path, (db) => db.exec(`UPDATE line_awards SET ${set}`));
const STARTED = "presentation_status = 'started', presentation_started_at = 1000, presentation_deadline = 5000";
const LOT = { lot: 'Jamón', lot_resolution: 'pending' };

test('the generic transition can no longer write a direct declaration, but old direct audits still replay', (t) => {
  const { path, store, event } = openDrawing(t);
  try {
    const before = dump(path);
    assert.throws(() => store.transitionPhase('declare_line_directly', T1), /atomic|award|direct/i);
    assert.deepEqual(dump(path), before);
    rawDirect(path, event.id);
    assert.equal(store.readAudit()[0].kind, 'declare_line_directly');
    assert.equal(store.load()?.phase, 'line_declared');
  } finally { store.close(); }
});

test('legacy line correction without an award stays legal; with an attached award it fails closed', (t) => {
  const legacy = fixture(t);
  const old = createEventStore(legacy);
  try {
    old.create();
    old.transitionPhase('begin_line_check', T1);
    old.transitionPhase('declare_line', T2);
    assert.equal(old.transitionPhase('correct_line_declaration', T3).phase, 'drawing');
  } finally { old.close(); }
  const { path, store, event } = openDrawing(t);
  try {
    rawDirect(path, event.id, T1);
    insertAward(path, event.id, { winner_count: 2, share_cents: 500, remainder_cents: 0 });
    const stored = store.loadLineAward();
    const before = dump(path);
    assert.throws(() => store.transitionPhase('correct_line_declaration', T2), /award|correction/i);
    assert.deepEqual(dump(path), before);
    assert.deepEqual(store.loadLineAward(), stored);
  } finally { store.close(); }
});

test('begin_bingo_check requires a completed presentation and a settled lot for an award; legacy is unchanged', (t) => {
  const legacy = fixture(t);
  const old = createEventStore(legacy);
  try {
    old.create();
    old.transitionPhase('begin_line_check', T1);
    old.transitionPhase('declare_line', T2);
    assert.equal(old.transitionPhase('begin_bingo_check', T3).phase, 'checking_bingo');
  } finally { old.close(); }
  const { path, store, event } = openDrawing(t, { amount: 10, lot: 'Jamón' });
  try {
    rawDirect(path, event.id, T1);
    insertAward(path, event.id, LOT);
    const before = dump(path);
    const blocked: Array<[string, string]> = [
      ['pending presentation', 'presentation_status = presentation_status'],
      ['failed', "presentation_status = 'failed'"],
      ['started', STARTED],
      ['completed with a pending lot', STARTED.replace('started', 'completed')],
    ];
    for (const [name, set] of blocked) {
      setAward(path, set);
      assert.throws(() => store.transitionPhase('begin_bingo_check', T2), /line|delivery|presentation|lot/i, name);
    }
    assert.equal(store.load()?.phase, 'line_declared');
    assert.equal(store.readAudit().length, 1);
    setAward(path, "lot_resolution = 'resolved', lot_result_origin = 'numbered_v1', lot_participant_number = 1, lot_color_id = 'red'");
    assert.equal(store.transitionPhase('begin_bingo_check', T2).phase, 'checking_bingo');
    assert.notDeepEqual(dump(path), before);
  } finally { store.close(); }
  const cash = openDrawing(t);
  try {
    rawDirect(cash.path, cash.event.id, T1);
    insertAward(cash.path, cash.event.id);
    assert.throws(() => cash.store.transitionPhase('begin_bingo_check', T2), /line|delivery|presentation/i);
    setAward(cash.path, STARTED.replace('started', 'completed'));
    assert.equal(cash.store.transitionPhase('begin_bingo_check', T2).phase, 'checking_bingo');
  } finally { cash.store.close(); }
});

test('draws are rejected before the callback while the presentation is pending, failed or started, even after restart', (t) => {
  const { path, store, event } = openDrawing(t, { amount: 10, lot: 'Jamón' });
  rawDirect(path, event.id, T1);
  insertAward(path, event.id, LOT);
  store.close();
  let calls = 0;
  const attempt = (s: ReturnType<typeof createEventStore>) => s.update((e) => { calls += 1; return drawManual(e, 12); });
  for (const set of ['presentation_status = presentation_status', "presentation_status = 'failed'", STARTED]) {
    setAward(path, set);
    const reopened = createEventStore(path);
    try {
      const before = dump(path);
      assert.throws(() => attempt(reopened), /draw|presentation|line/i, set);
      assert.equal(calls, 0, set);
      assert.deepEqual(dump(path), before, set);
    } finally { reopened.close(); }
  }
  setAward(path, STARTED.replace('started', 'completed'));
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.loadLineAward()?.award.lotResolution, 'pending');
    assert.deepEqual(attempt(reopened).calledNumbers, [12]);
    assert.equal(calls, 1);
    assert.equal(reopened.load()?.phase, 'line_declared');
  } finally { reopened.close(); }
});

test('selectEvent refuses a target whose line award is corrupt and keeps the selection; a valid locked event stays locked', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    const a = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    const bad = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    const good = store.createEvent({ name: 'C', date: '2025-01-03', place: 'Z' });
    rawDirect(path, bad.id);
    insertAward(path, bad.id, { share_cents: 334 }, true);
    const before = dump(path);
    assert.throws(() => store.selectEvent(bad.id), /invalid stored line award/i);
    assert.deepEqual(dump(path), before);
    assert.equal(store.listEvents().find((e) => e.id === a.id)?.active, true);
    rawDirect(path, good.id);
    insertAward(path, good.id, { presentation_id: 'p-good' });
    assert.equal(store.selectEvent(good.id).active, true);
    assert.equal(store.loadLineAward()?.presentation.status, 'pending');
    assert.throws(() => store.update((e) => drawManual(e, 1)), /draw|presentation|line/i);
    store.selectEvent(a.id);
    store.selectEvent(good.id);
    assert.throws(() => store.update((e) => drawManual(e, 1)), /draw|presentation|line/i);
  } finally { store.close(); }
});

test('declareLineDirectly commits phase, direct audit and a pending cash award atomically', (t) => {
  const { path, store, event } = openDrawing(t);
  try {
    store.update((e) => drawManual(drawManual(e, 7), 42));
    const baseline = store.loadLineDeclarationBaseline();
    assert.deepEqual(baseline, { eventId: event.id, calledNumbers: [7, 42], phase: 'drawing', lastTransitionAt: null,
      auditSequence: 0, linePrize: { amount: 10, lot: '' } });
    assert.ok(Object.isFrozen(baseline) && Object.isFrozen(baseline.calledNumbers) && Object.isFrozen(baseline.linePrize));
    const stored = store.declareLineDirectly(baseline, 3, T1);
    assert.match(stored.presentation.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(stored, { eventId: event.id,
      award: { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: '', lotResolution: 'not_required' },
      presentation: { id: stored.presentation.id, status: 'pending', startedAt: null, deadlineAt: null } });
    assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.award) && Object.isFrozen(stored.presentation));
    assert.deepEqual(store.loadLineAward(), stored);
    assert.deepEqual(store.load(), { calledNumbers: [7, 42], phase: 'line_declared', lastTransitionAt: T1 });
    assert.deepEqual(store.readAudit(), [{ sequence: 1, transitionAt: T1, kind: 'declare_line_directly',
      from_phase: 'drawing', to_phase: 'line_declared' }]);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.loadLineAward()?.award.winnerCount, 3);
    assert.equal(reopened.load()?.phase, 'line_declared');
  } finally { reopened.close(); }
});

test('declareLineDirectly freezes a lot as pending only for a tie of two or more winners', (t) => {
  for (const [winners, resolution] of [[3, 'pending'], [2, 'pending'], [1, 'not_required']] as const) {
    const { store } = openDrawing(t, { amount: 10, lot: ' Jamón ' });
    try {
      const stored = store.declareLineDirectly(store.loadLineDeclarationBaseline(), winners, T1);
      assert.deepEqual([stored.award.lot, stored.award.lotResolution], ['Jamón', resolution]);
    } finally { store.close(); }
  }
});

test('declareLineDirectly accepts positive safe winner counts up to MAX_SAFE_INTEGER and rejects every other value', (t) => {
  const { path, store } = openDrawing(t);
  try {
    const baseline = store.loadLineDeclarationBaseline();
    const before = dump(path);
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined, {}, 3n]) {
      assert.throws(() => store.declareLineDirectly(baseline, bad as never, T1), /winner/i, String(bad));
    }
    assert.deepEqual(dump(path), before);
    const stored = store.declareLineDirectly(baseline, Number.MAX_SAFE_INTEGER, T1);
    assert.deepEqual([stored.award.winnerCount, stored.award.shareCents, stored.award.remainderCents],
      [Number.MAX_SAFE_INTEGER, 0, 1000]);
  } finally { store.close(); }
});

test('declareLineDirectly rejects a stale or different baseline without writing', (t) => {
  const { path, store, event } = openDrawing(t);
  try {
    const baseline = store.loadLineDeclarationBaseline();
    const stale: Array<[string, () => void]> = [
      ['draw', () => store.update((e) => drawManual(e, 5))],
      ['prize edit', () => store.updateEventPrizes(event.id, { line: { amount: 11, lot: '' }, bingo: { amount: 0, lot: '' } })],
      ['lot edit', () => store.updateEventPrizes(event.id, { line: { amount: 10, lot: 'Jamón' }, bingo: { amount: 0, lot: '' } })],
      ['phase head', () => { store.transitionPhase('begin_line_check', T1); store.transitionPhase('reject_line_claim', T2); }],
    ];
    for (const [name, change] of stale) {
      change();
      const before = dump(path);
      assert.throws(() => store.declareLineDirectly(baseline, 1, T3), /stale|baseline|mismatch/i, name);
      assert.deepEqual(dump(path), before, name);
    }
    // A second writer connection (another process) changes the history; the first caller's baseline is stale.
    const second = createEventStore(path);
    try { second.update((e) => drawManual(e, 6)); } finally { second.close(); }
    const independent = dump(path);
    assert.throws(() => store.declareLineDirectly(baseline, 1, T3), /stale|baseline|mismatch/i, 'second connection');
    assert.deepEqual(dump(path), independent, 'second connection');
    // Another active event never accepts this event's baseline.
    const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    store.selectEvent(other.id);
    const before = dump(path);
    assert.throws(() => store.declareLineDirectly(baseline, 1, '2025-01-01T00:00:09.000Z'), /stale|baseline|mismatch/i);
    assert.deepEqual(dump(path), before);
  } finally { store.close(); }
});

test('declareLineDirectly rejects forged baselines, malformed input and bad timestamps without writing', (t) => {
  const { path, store } = openDrawing(t);
  try {
    store.update((e) => drawManual(drawManual(e, 7), 42));
    store.transitionPhase('begin_line_check', T1);
    store.transitionPhase('reject_line_claim', T2);
    const base = store.loadLineDeclarationBaseline();
    const before = dump(path);
    // Holes read as undefined, so a sparse array of the right length must never pass for the real history.
    const hole = (index: number) => { const sparse = [7, 42]; delete sparse[index]; return sparse; };
    const forged: Record<string, unknown> = {
      'sparse history': { ...base, calledNumbers: Array(2) },
      'hole at the tail': { ...base, calledNumbers: hole(1) },
      'hole at the head': { ...base, calledNumbers: hole(0) },
      'history ball type': { ...base, calledNumbers: [7, '42'] },
      'history ball range': { ...base, calledNumbers: [7, 91] },
      'history duplicate': { ...base, calledNumbers: [7, 7] },
      'missing field': { ...base, auditSequence: undefined },
      'extra field': { ...base, extra: 1 },
      'history order': { ...base, calledNumbers: [42, 7] },
      'history prefix': { ...base, calledNumbers: [7] },
      'history type': { ...base, calledNumbers: '7,42' },
      'prize amount': { ...base, linePrize: { amount: 99, lot: '' } },
      'prize lot': { ...base, linePrize: { amount: 10, lot: 'x' } },
      'prize shape': { ...base, linePrize: 10 },
      'phase': { ...base, phase: 'line_declared' },
      'timestamp': { ...base, lastTransitionAt: T1 },
      'sequence': { ...base, auditSequence: 1 },
      'sequence type': { ...base, auditSequence: '2' },
      'event': { ...base, eventId: 'other' },
      null: null, string: 'baseline', array: [], empty: {},
    };
    for (const [name, value] of Object.entries(forged)) {
      assert.throws(() => store.declareLineDirectly(value as never, 1, T3), /baseline|stale|mismatch/i, name);
    }
    for (const at of [T2, T1, '2025-01-01', 'garbage', '2025-01-01T01:00:03.000+01:00', 5, null, undefined]) {
      assert.throws(() => store.declareLineDirectly(base, 1, at as never), /timestamp|time/i, String(at));
    }
    assert.deepEqual(dump(path), before);
    assert.equal(store.declareLineDirectly(base, 1, T3).award.winnerCount, 1);
  } finally { store.close(); }
});

test('a committed award refuses a second declaration and never replays', (t) => {
  const { path, store } = openDrawing(t);
  try {
    const baseline = store.loadLineDeclarationBaseline();
    const stored = store.declareLineDirectly(baseline, 3, T1);
    const before = dump(path);
    assert.throws(() => store.declareLineDirectly(baseline, 3, T2), /stale|baseline|mismatch|not eligible/i);
    assert.throws(() => store.loadLineDeclarationBaseline(), /not eligible/i);
    assert.deepEqual(dump(path), before);
    assert.deepEqual(store.loadLineAward(), stored);
  } finally { store.close(); }
});

test('a later prize edit leaves the frozen award unchanged', (t) => {
  const { store, event } = openDrawing(t, { amount: 10, lot: 'Jamón' });
  try {
    const stored = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 3, T1);
    store.updateEventPrizes(event.id, { line: { amount: 99, lot: 'Otro' }, bingo: { amount: 0, lot: '' } });
    assert.deepEqual(store.loadLineAward(), stored);
  } finally { store.close(); }
});

test('an injected failure after the audit row or during award readback rolls everything back', (t) => {
  const triggers: Array<[string, string]> = [
    ['before the award insert', `CREATE TRIGGER fail_award BEFORE INSERT ON line_awards
      BEGIN SELECT RAISE(ABORT, 'injected award failure'); END`],
    ['during award readback', `CREATE TRIGGER corrupt_award AFTER INSERT ON line_awards
      BEGIN UPDATE line_awards SET total_cents = 1050, share_cents = 350, remainder_cents = 0
        WHERE event_id = NEW.event_id; END`],
  ];
  for (const [name, sql] of triggers) {
    const { path, store } = openDrawing(t);
    try {
      store.update((e) => drawManual(e, 9));
      const baseline = store.loadLineDeclarationBaseline();
      const before = dump(path);
      withDb(path, (db) => db.exec(sql));
      assert.throws(() => store.declareLineDirectly(baseline, 3, T1), /injected|invalid stored line award/i, name);
      assert.deepEqual(dump(path), before, name);
      assert.equal(store.load()?.phase, 'drawing');
      withDb(path, (db) => db.exec('DROP TRIGGER IF EXISTS fail_award; DROP TRIGGER IF EXISTS corrupt_award'));
      assert.deepEqual(store.loadLineDeclarationBaseline(), baseline, name);
      assert.equal(store.declareLineDirectly(baseline, 3, T1).award.winnerCount, 3, name);
    } finally { store.close(); }
  }
});

// ---- durable line presentation lifecycle (FL-03b): explicit start/fail/retry/complete, no timers or replay ----
function declared(t: unknown, winners = 3, line = { amount: 10, lot: '' }) {
  const opened = openDrawing(t, line);
  const award = opened.store.declareLineDirectly(opened.store.loadLineDeclarationBaseline(), winners, T1);
  return { ...opened, award, id: award.presentation.id };
}
const presentationRow = (path: string) => {
  let row: unknown;
  withDb(path, (db) => { row = db.prepare(`SELECT presentation_id, presentation_status, presentation_started_at,
    presentation_deadline FROM line_awards`).get(); });
  return { ...(row as object) };
};
// Everything the presentation must never touch: all tables except line_awards, plus the frozen award columns.
const frozenState = (path: string) => {
  let award: unknown;
  withDb(path, (db) => { award = db.prepare(`SELECT event_id, audit_sequence, winner_count, total_cents, share_cents,
    remainder_cents, lot, lot_resolution FROM line_awards`).get(); });
  return JSON.stringify([(dump(path) as unknown[]).filter((_, index) => index !== 2), award]);
};
const presentationStatus = (path: string) => (presentationRow(path) as { presentation_status: string }).presentation_status;

test('the presentation runs pending -> failed -> manual retry (new id) -> started -> completed, one explicit step each', (t) => {
  const { path, store, event, award, id } = declared(t);
  try {
    const frozen = frozenState(path);
    const failed = store.failLinePresentation(id);
    assert.deepEqual(failed, { ...award, presentation: { id, status: 'failed', startedAt: null, deadlineAt: null } });
    assert.ok(Object.isFrozen(failed) && Object.isFrozen(failed.award) && Object.isFrozen(failed.presentation));
    const retried = store.retryLinePresentation(id);
    assert.equal(retried.presentation.status, 'pending');
    assert.match(retried.presentation.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(retried.presentation.id, id);
    assert.deepEqual([retried.presentation.startedAt, retried.presentation.deadlineAt], [null, null]);
    assert.throws(() => store.startLinePresentation(id, 1000), /current|presentation/i, 'old id is stale');
    const started = store.startLinePresentation(retried.presentation.id, 1000);
    assert.deepEqual(started.presentation, { id: retried.presentation.id, status: 'started', startedAt: 1000, deadlineAt: 5000 });
    assert.throws(() => store.update((e) => drawManual(e, 1)), /presentation/i);
    const done = store.completeLinePresentation(retried.presentation.id, 5000);
    assert.deepEqual(done, { eventId: event.id, award: award.award,
      presentation: { id: retried.presentation.id, status: 'completed', startedAt: 1000, deadlineAt: 5000 } });
    assert.ok(Object.isFrozen(done) && Object.isFrozen(done.presentation));
    assert.deepEqual(store.loadLineAward(), done);
    assert.equal(frozenState(path), frozen);
    store.update((e) => drawManual(e, 1));
  } finally { store.close(); }
});

test('start accepts zero and the largest safe start whose deadline is safe, rejecting every other time', (t) => {
  const MAX = Number.MAX_SAFE_INTEGER;
  for (const [at, deadline] of [[0, 4000], [MAX - 4000, MAX]]) {
    const { store, id } = declared(t);
    try { assert.deepEqual([store.startLinePresentation(id, at).presentation.deadlineAt], [deadline]); }
    finally { store.close(); }
  }
  const { path, store, id } = declared(t);
  try {
    const before = JSON.stringify(dump(path));
    for (const bad of [-1, MAX - 3999, MAX, MAX + 1, 1.5, NaN, Infinity, '1000', 1000n, null, undefined, {}]) {
      assert.throws(() => store.startLinePresentation(id, bad as never), /start|time|safe/i, String(bad));
    }
    assert.equal(JSON.stringify(dump(path)), before);
    assert.equal(store.startLinePresentation(id, 7).presentation.deadlineAt, 4007);
  } finally { store.close(); }
});

test('complete needs a started presentation and a safe now at or after the persisted deadline', (t) => {
  const { path, store, id } = declared(t);
  try {
    store.startLinePresentation(id, 1000);
    const before = JSON.stringify(dump(path));
    for (const bad of [4999, 0, -1, 5000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5000', 5000n, null, undefined]) {
      assert.throws(() => store.completeLinePresentation(id, bad as never), /now|time|deadline|safe/i, String(bad));
    }
    assert.equal(JSON.stringify(dump(path)), before);
    assert.equal(store.completeLinePresentation(id, 5000).presentation.status, 'completed');
  } finally { store.close(); }
});

test('a started presentation past its deadline stays started after reopening and is never completed by reads', (t) => {
  const { path, store, id } = declared(t);
  store.startLinePresentation(id, 1000);
  store.close();
  const reopened = createEventStore(path);
  try {
    const before = JSON.stringify(dump(path));
    assert.equal(reopened.loadLineAward()?.presentation.status, 'started');
    assert.throws(() => reopened.update((e) => drawManual(e, 1)), /presentation/i);
    assert.equal(JSON.stringify(dump(path)), before);
    assert.equal(reopened.completeLinePresentation(id, Date.now()).presentation.status, 'completed');
  } finally { reopened.close(); }
});

test('each command accepts exactly its source status and refuses every other status, id and replay unchanged', (t) => {
  const run: Record<string, (store: ReturnType<typeof createEventStore>, id: string) => unknown> = {
    start: (store, id) => store.startLinePresentation(id, 1000),
    fail: (store, id) => store.failLinePresentation(id),
    retry: (store, id) => store.retryLinePresentation(id),
    complete: (store, id) => store.completeLinePresentation(id, 5000),
  };
  const reach: Record<string, string[]> = { pending: [], failed: ['fail'], started: ['start'], completed: ['start', 'complete'] };
  const legal: Record<string, string> = { pending: 'start', failed: 'retry', started: 'complete', completed: '' };
  for (const [status, steps] of Object.entries(reach)) {
    const { path, store, id: first } = declared(t);
    try {
      let id = first;
      for (const step of steps) run[step](store, id);
      assert.equal(presentationStatus(path), status);
      const before = JSON.stringify(dump(path));
      for (const command of Object.keys(run).filter((name) => name !== legal[status] && !(status === 'pending' && name === 'fail'))) {
        assert.throws(() => run[command](store, id), /transition|presentation/i, `${command} on ${status}`);
        assert.equal(JSON.stringify(dump(path)), before, `${command} on ${status}`);
      }
      if (status === 'pending') assert.equal(run.fail(store, id) !== undefined, true);
    } finally { store.close(); }
  }
});

test('commands need the exact id of the active event\'s award and never coerce it', (t) => {
  const { path, store, event, id } = declared(t);
  try {
    for (const bad of [undefined, null, 7, '', ' ', `${id} `, id.toUpperCase(), 'unknown', { toString: () => id }, [id]]) {
      for (const call of [() => store.startLinePresentation(bad as never, 1000), () => store.failLinePresentation(bad as never),
        () => store.retryLinePresentation(bad as never), () => store.completeLinePresentation(bad as never, 5000)]) {
        assert.throws(call, /presentation|id/i, String(bad));
      }
    }
    // Another active event never accepts this event's id; an event without an award (or a legacy one) has nothing to update.
    const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    store.selectEvent(other.id);
    assert.throws(() => store.startLinePresentation(id, 1000), /presentation|award/i, 'no award');
    rawDirect(path, other.id);
    const legacy = JSON.stringify(dump(path));
    assert.throws(() => store.failLinePresentation(id), /presentation|award/i, 'legacy declared');
    assert.equal(JSON.stringify(dump(path)), legacy);
    store.selectEvent(event.id);
    assert.equal(store.failLinePresentation(id).presentation.status, 'failed');
  } finally { store.close(); }
});

test('a corrupt stored award fails every command closed and changes nothing', (t) => {
  const { path, store, id } = declared(t);
  try {
    store.startLinePresentation(id, 1000);
    withDb(path, (db) => db.exec('PRAGMA ignore_check_constraints = 1; UPDATE line_awards SET share_cents = 1'));
    const before = JSON.stringify(dump(path));
    assert.throws(() => store.completeLinePresentation(id, 5000), /invalid stored line award/i);
    assert.equal(JSON.stringify(dump(path)), before);
  } finally { store.close(); }
});

test('an injected update or readback failure rolls the row back exactly and a valid retry then succeeds', (t) => {
  const triggers: Array<[string, string]> = [
    ['update failure', `CREATE TRIGGER fail_presentation BEFORE UPDATE ON line_awards
      BEGIN SELECT RAISE(ABORT, 'injected presentation failure'); END`],
    ['readback corruption', `CREATE TRIGGER corrupt_presentation AFTER UPDATE ON line_awards
      BEGIN UPDATE line_awards SET presentation_id = 'tampered' WHERE event_id = NEW.event_id; END`],
  ];
  for (const [name, sql] of triggers) {
    const { path, store, id } = declared(t);
    try {
      const before = JSON.stringify(dump(path));
      withDb(path, (db) => db.exec(sql));
      assert.throws(() => store.startLinePresentation(id, 1000), /injected|presentation|invalid/i, name);
      assert.equal(JSON.stringify(dump(path)), before, name);
      withDb(path, (db) => db.exec('DROP TRIGGER IF EXISTS fail_presentation; DROP TRIGGER IF EXISTS corrupt_presentation'));
      assert.equal(store.startLinePresentation(id, 1000).presentation.status, 'started', name);
      assert.equal(store.completeLinePresentation(id, 5000).presentation.status, 'completed', name);
    } finally { store.close(); }
  }
});

test('another connection that changed the presentation makes this connection\'s old id and status stale', (t) => {
  const { path, store, id } = declared(t);
  const second = createEventStore(path);
  try {
    second.failLinePresentation(id);
    const fresh = second.retryLinePresentation(id).presentation.id;
    const before = JSON.stringify(dump(path));
    assert.throws(() => store.startLinePresentation(id, 1000), /presentation|current/i, 'stale id');
    assert.throws(() => store.failLinePresentation(id), /presentation|current/i, 'stale id');
    assert.equal(JSON.stringify(dump(path)), before);
    assert.equal(store.startLinePresentation(fresh, 1000).presentation.status, 'started');
    assert.throws(() => second.failLinePresentation(fresh), /transition|presentation/i, 'started cannot fail');
  } finally { second.close(); store.close(); }
});

test('a completed presentation unlocks draws while a tied lot still blocks bingo until resolved; cash remainder never does', (t) => {
  const tie = declared(t, 3, { amount: 10, lot: 'Jamón' });
  try {
    tie.store.startLinePresentation(tie.id, 1000);
    tie.store.completeLinePresentation(tie.id, 5000);
    assert.equal(tie.store.loadLineAward()?.award.lotResolution, 'pending');
    tie.store.update((e) => drawManual(e, 3));
    const before = JSON.stringify(dump(tie.path));
    assert.throws(() => tie.store.transitionPhase('begin_bingo_check', T2), /delivery|lot|bingo/i);
    assert.equal(JSON.stringify(dump(tie.path)), before);
    setAward(tie.path, "lot_resolution = 'resolved', lot_result_origin = 'numbered_v1', lot_participant_number = 1, lot_color_id = 'red'"); // Raw stand-in: no lot-resolution API exists yet (#61).
    assert.equal(tie.store.transitionPhase('begin_bingo_check', T2).phase, 'checking_bingo');
  } finally { tie.store.close(); }
  const cash = declared(t, 3);
  try {
    assert.equal(cash.award.award.remainderCents, 1);
    cash.store.startLinePresentation(cash.id, 1000);
    cash.store.completeLinePresentation(cash.id, 5000);
    assert.equal(cash.store.transitionPhase('begin_bingo_check', T2).phase, 'checking_bingo');
  } finally { cash.store.close(); }
});

// ---- interruptStartedLinePresentations (FL-07 unit 1): explicit startup reconciliation, never a read side effect ----
const statusesOf = (path: string) => {
  let rows: unknown;
  withDb(path, (db) => { rows = db.prepare(`SELECT presentation_id AS id, presentation_status AS status,
    presentation_started_at AS startedAt, presentation_deadline AS deadlineAt FROM line_awards ORDER BY presentation_id`).all(); });
  return (rows as object[]).map((row) => ({ ...row }));
};

test('interrupting with no events (so no active event) or no awards is a harmless no-op', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.equal(store.interruptStartedLinePresentations(), 0);
    store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    assert.equal(store.interruptStartedLinePresentations(), 0);
    assert.equal(store.loadLineAward(), null);
  } finally { store.close(); }
});

test('interrupting marks every started award in every event, keeping ids and times, and leaves other statuses alone', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['started', 'pending', 'started', 'failed', 'completed']);
  try {
    const frozen = frozenState(path);
    assert.equal(store.interruptStartedLinePresentations(), 2);
    assert.deepEqual(statusesOf(path), [
      { id: 'p-0', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 },
      { id: 'p-1', status: 'pending', startedAt: null, deadlineAt: null },
      { id: 'p-2', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 },
      { id: 'p-3', status: 'failed', startedAt: null, deadlineAt: null },
      { id: 'p-4', status: 'completed', startedAt: 1000, deadlineAt: 5000 }]);
    assert.equal(frozenState(path), frozen);
    // Idempotent: a second run finds nothing started and changes nothing.
    const after = JSON.stringify(dump(path));
    assert.equal(store.interruptStartedLinePresentations(), 0);
    assert.equal(JSON.stringify(dump(path)), after);
    assert.equal(store.loadLineAward()?.presentation.status, 'interrupted');
    assert.equal(store.selectEvent(ids[2]).id, ids[2]);
    assert.deepEqual(store.loadLineAward()?.presentation, { id: 'p-2', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 });
  } finally { store.close(); }
});

test('an interrupted award keeps draws and bingo blocked and refuses every presentation step, even past its deadline', (t) => {
  const { path, store, id } = declared(t);
  try {
    store.startLinePresentation(id, 1000);
    assert.equal(store.interruptStartedLinePresentations(), 1);
    const before = JSON.stringify(dump(path));
    assert.throws(() => store.update((e) => drawManual(e, 1)), /presentation/i);
    assert.throws(() => store.transitionPhase('begin_bingo_check', '2025-01-01T00:00:09.000Z'), /presentation|delivery|completed/i);
    assert.throws(() => store.completeLinePresentation(id, 999_999), /transition|presentation/i);
    assert.throws(() => store.startLinePresentation(id, 2000), /transition|presentation/i);
    assert.throws(() => store.failLinePresentation(id), /transition|presentation/i);
    assert.throws(() => store.retryLinePresentation(id), /transition|presentation/i);
    assert.equal(JSON.stringify(dump(path)), before);
    assert.deepEqual(store.loadLineAward()?.presentation, { id, status: 'interrupted', startedAt: 1000, deadlineAt: 5000 });
  } finally { store.close(); }
});

test('reopening or switching events never interrupts a started presentation; only the explicit call does', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['started', 'started']);
  store.selectEvent(ids[1]);
  store.selectEvent(ids[0]);
  assert.equal(store.loadLineAward()?.presentation.status, 'started');
  store.close();
  const reopened = createEventStore(path);
  try {
    assert.deepEqual(statusesOf(path).map((row) => (row as { status: string }).status), ['started', 'started']);
    assert.equal(reopened.loadLineAward()?.presentation.status, 'started');
    assert.equal(reopened.interruptStartedLinePresentations(), 2);
  } finally { reopened.close(); }
});

test('interruption is all or nothing and refuses corrupted started rows instead of normalizing them', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['started', 'started', 'started']);
  try {
    // A started row whose share contradicts its arithmetic bypassed the CHECKs: it is corruption, not an interruption.
    withDb(path, (db) => db.exec(`PRAGMA ignore_check_constraints = 1;
      UPDATE line_awards SET share_cents = 1 WHERE event_id = '${ids[2]}'`));
    const before = JSON.stringify(dump(path));
    assert.throws(() => store.interruptStartedLinePresentations(), /invalid stored line award/i);
    assert.equal(JSON.stringify(dump(path)), before);
    withDb(path, (db) => db.exec(`UPDATE line_awards SET share_cents = 333 WHERE event_id = '${ids[2]}'`));
    // A write failure on the second row rolls the first one back too.
    withDb(path, (db) => db.exec(`CREATE TRIGGER fail_last BEFORE UPDATE ON line_awards
      WHEN NEW.presentation_id = 'p-2' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    const clean = JSON.stringify(dump(path));
    assert.throws(() => store.interruptStartedLinePresentations(), /boom/);
    assert.equal(JSON.stringify(dump(path)), clean);
    assert.deepEqual(statusesOf(path).map((row) => (row as { status: string }).status), ['started', 'started', 'started']);
    withDb(path, (db) => db.exec('DROP TRIGGER fail_last'));
    assert.equal(store.interruptStartedLinePresentations(), 3);
  } finally { store.close(); }
});

// ---- replayLinePresentation / failPendingLinePresentations (FL-07 unit 2-A) ----
test('replay turns an interrupted award into pending with a new id and cleared times; the old id is dead', (t) => {
  const { path, store, id } = declared(t);
  try {
    store.startLinePresentation(id, 1000);
    store.interruptStartedLinePresentations();
    const frozen = frozenState(path);
    const replayed = store.replayLinePresentation(id);
    const fresh = replayed.presentation.id;
    assert.notEqual(fresh, id);
    assert.deepEqual(replayed.presentation, { id: fresh, status: 'pending', startedAt: null, deadlineAt: null });
    assert.equal(frozenState(path), frozen);
    const before = JSON.stringify(dump(path));
    for (const step of [() => store.startLinePresentation(id, 2000), () => store.completeLinePresentation(id, 99_999),
      () => store.failLinePresentation(id), () => store.replayLinePresentation(id)]) {
      assert.throws(step, /presentation/i);
    }
    assert.equal(JSON.stringify(dump(path)), before);
    // A second replay on the new (pending) id is refused: only interrupted rows replay.
    assert.throws(() => store.replayLinePresentation(fresh), /transition|presentation/i);
    // Draws stay blocked until the full run on the new id completes.
    assert.throws(() => store.update((e) => drawManual(e, 1)), /presentation/i);
    assert.equal(store.startLinePresentation(fresh, 10_000).presentation.status, 'started');
    assert.throws(() => store.update((e) => drawManual(e, 1)), /presentation/i);
    assert.throws(() => store.completeLinePresentation(fresh, 13_999), /deadline/i);
    assert.equal(store.completeLinePresentation(fresh, 14_000).presentation.status, 'completed');
    store.update((e) => drawManual(e, 1));
  } finally { store.close(); }
});

test('replay refuses every non-interrupted source and non-string ids without changing anything', (t) => {
  const { path, store, id } = declared(t);
  try {
    assert.throws(() => store.replayLinePresentation(id), /transition|presentation/i, 'pending');
    assert.throws(() => store.replayLinePresentation(7), /invalid line presentation id/i);
    store.failLinePresentation(id);
    assert.throws(() => store.replayLinePresentation(id), /transition|presentation/i, 'failed');
    const fresh = store.retryLinePresentation(id).presentation.id;
    store.startLinePresentation(fresh, 1000);
    assert.throws(() => store.replayLinePresentation(fresh), /transition|presentation/i, 'started');
    store.completeLinePresentation(fresh, 5000);
    assert.throws(() => store.replayLinePresentation(fresh), /transition|presentation/i, 'completed');
    assert.equal(presentationStatus(path), 'completed');
  } finally { store.close(); }
});

test('replay only reaches the active event and rolls back on an injected failure', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['interrupted', 'interrupted']);
  try {
    store.selectEvent(ids[0]);
    assert.throws(() => store.replayLinePresentation('p-1'), /presentation/i, 'other event id');
    const before = JSON.stringify(dump(path));
    withDb(path, (db) => db.exec(`CREATE TRIGGER fail_replay BEFORE UPDATE ON line_awards
      BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    assert.throws(() => store.replayLinePresentation('p-0'), /boom/);
    assert.equal(JSON.stringify(dump(path)), before);
    withDb(path, (db) => db.exec('DROP TRIGGER fail_replay'));
    assert.equal(store.replayLinePresentation('p-0').presentation.status, 'pending');
    assert.deepEqual(statusesOf(path).filter((row) => (row as { id: string }).id === 'p-1'),
      [{ id: 'p-1', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 }]);
  } finally { store.close(); }
});

test('failing pending marks every pending award in every event failed, keeping ids and nulling nothing else', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['pending', 'started', 'pending', 'failed', 'completed', 'interrupted']);
  try {
    const frozen = frozenState(path);
    assert.equal(store.failPendingLinePresentations(), 2);
    assert.deepEqual(statusesOf(path), [
      { id: 'p-0', status: 'failed', startedAt: null, deadlineAt: null },
      { id: 'p-1', status: 'started', startedAt: 1000, deadlineAt: 5000 },
      { id: 'p-2', status: 'failed', startedAt: null, deadlineAt: null },
      { id: 'p-3', status: 'failed', startedAt: null, deadlineAt: null },
      { id: 'p-4', status: 'completed', startedAt: 1000, deadlineAt: 5000 },
      { id: 'p-5', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 }]);
    assert.equal(frozenState(path), frozen);
    const after = JSON.stringify(dump(path));
    assert.equal(store.failPendingLinePresentations(), 0);
    assert.equal(JSON.stringify(dump(path)), after);
    store.selectEvent(ids[2]);
    assert.equal(store.retryLinePresentation('p-2').presentation.status, 'pending');
  } finally { store.close(); }
});

test('failing pending is a no-op without events or awards and never runs on open, read or event switch', (t) => {
  const path = fixture(t);
  const empty = createEventStore(path);
  try {
    assert.equal(empty.failPendingLinePresentations(), 0);
    empty.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
    assert.equal(empty.failPendingLinePresentations(), 0);
  } finally { empty.close(); }
  const second = fixture(t);
  const { store, ids } = seedAwards(second, ['pending', 'pending']);
  store.selectEvent(ids[1]);
  store.selectEvent(ids[0]);
  assert.equal(store.loadLineAward()?.presentation.status, 'pending');
  store.close();
  const reopened = createEventStore(second);
  try {
    assert.deepEqual(statusesOf(second).map((row) => (row as { status: string }).status), ['pending', 'pending']);
    assert.equal(reopened.failPendingLinePresentations(), 2);
  } finally { reopened.close(); }
});

// Processing follows insertion order (rowid), never the random event UUIDs, so "the last row" is well defined.
function orderLog(path: string, seeds: string[]) {
  const store = seedAwards(path, seeds);
  withDb(path, (db) => db.exec(`CREATE TABLE order_log (n INTEGER PRIMARY KEY, id TEXT);
    CREATE TRIGGER log_order AFTER UPDATE ON line_awards BEGIN INSERT INTO order_log (id) VALUES (NEW.presentation_id); END`));
  return store;
}
const readOrder = (path: string) => {
  let rows: unknown[] = [];
  withDb(path, (db) => { rows = db.prepare('SELECT id FROM order_log ORDER BY n').all(); });
  return rows.map((row) => (row as { id: string }).id);
};

test('batch reconciliation processes awards in insertion order, not event-id order', (t) => {
  const names = ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'];
  const pendingPath = fixture(t);
  const pending = orderLog(pendingPath, names.map(() => 'pending'));
  try {
    assert.equal(pending.store.failPendingLinePresentations(), 6);
    assert.deepEqual(readOrder(pendingPath), names);
  } finally { pending.store.close(); }
  const startedPath = fixture(t);
  const started = orderLog(startedPath, names.map(() => 'started'));
  try {
    assert.equal(started.store.interruptStartedLinePresentations(), 6);
    assert.deepEqual(readOrder(startedPath), names);
  } finally { started.store.close(); }
});

test('failing pending is all or nothing and refuses corrupted pending rows', (t) => {
  const path = fixture(t);
  const { store, ids } = seedAwards(path, ['pending', 'pending', 'pending']);
  try {
    // The corrupt and the failing row are the last one processed, so two earlier updates must be rolled back.
    withDb(path, (db) => db.exec(`PRAGMA ignore_check_constraints = 1;
      UPDATE line_awards SET share_cents = 1 WHERE event_id = '${ids[2]}'`));
    const before = JSON.stringify(dump(path));
    assert.throws(() => store.failPendingLinePresentations(), /invalid stored line award/i);
    assert.equal(JSON.stringify(dump(path)), before);
    withDb(path, (db) => db.exec(`UPDATE line_awards SET share_cents = 333 WHERE event_id = '${ids[2]}'`));
    withDb(path, (db) => db.exec(`CREATE TRIGGER fail_last BEFORE UPDATE ON line_awards
      WHEN NEW.presentation_id = 'p-2' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    const clean = JSON.stringify(dump(path));
    assert.throws(() => store.failPendingLinePresentations(), /boom/);
    assert.equal(JSON.stringify(dump(path)), clean);
    assert.deepEqual(statusesOf(path).map((row) => (row as { status: string }).status), ['pending', 'pending', 'pending']);
    withDb(path, (db) => db.exec('DROP TRIGGER fail_last'));
    assert.equal(store.failPendingLinePresentations(), 3);
  } finally { store.close(); }
});

// ---- legacy checking_line recovery (REC-01): guarded cancellation through the existing reject_line_claim ----
function openLegacyCheck(t: unknown) {
  const opened = openDrawing(t, { amount: 10, lot: 'Jamón' });
  opened.store.update((e) => drawManual(drawManual(e, 7), 42));
  opened.store.transitionPhase('begin_line_check', T1);
  return opened;
}

test('loadLegacyLineCheck returns a frozen identity only for checking_line and never writes', (t) => {
  const { path, store, event } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    assert.deepEqual(check, { eventId: event.id, phase: 'checking_line', lastTransitionAt: T1, auditSequence: 1 });
    assert.ok(Object.isFrozen(check));
    const before = dump(path);
    store.loadLegacyLineCheck();
    assert.deepEqual(dump(path), before);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try { assert.equal(reopened.loadLegacyLineCheck().auditSequence, 1); } finally { reopened.close(); }
});

test('loadLegacyLineCheck and cancelLegacyLineCheck refuse every other phase and a missing event', (t) => {
  const none = createEventStore(fixture(t));
  try {
    assert.throws(() => none.loadLegacyLineCheck(), /not eligible/i);
    assert.throws(() => none.cancelLegacyLineCheck({}, T2), /invalid|not eligible/i);
  } finally { none.close(); }
  const { path, store } = openDrawing(t);
  try {
    const refused = (label: string) => {
      const before = dump(path);
      assert.throws(() => store.loadLegacyLineCheck(), /not eligible/i, label);
      assert.throws(() => store.cancelLegacyLineCheck({ eventId: 'x', phase: 'checking_line', lastTransitionAt: T1,
        auditSequence: 1 }, T3), /not eligible/i, label);
      assert.deepEqual(dump(path), before, label);
    };
    refused('drawing');
    store.transitionPhase('begin_line_check', T1);
    store.transitionPhase('declare_line', T2);
    refused('line_declared');
    store.transitionPhase('begin_bingo_check', T3);
    refused('checking_bingo');
  } finally { store.close(); }
});

test('cancelLegacyLineCheck commits reject_line_claim to drawing preserving calls, prizes, metadata and history; no award', (t) => {
  const { path, store, event } = openLegacyCheck(t);
  try {
    const before = dump(path) as unknown[][];
    const result = store.cancelLegacyLineCheck(store.loadLegacyLineCheck(), T2);
    assert.deepEqual(result, { calledNumbers: [7, 42], phase: 'drawing', lastTransitionAt: T2 });
    assert.deepEqual(store.load(), result);
    assert.deepEqual(store.readAudit(), [
      { sequence: 1, transitionAt: T1, kind: 'begin_line_check', from_phase: 'drawing', to_phase: 'checking_line' },
      { sequence: 2, transitionAt: T2, kind: 'reject_line_claim', from_phase: 'checking_line', to_phase: 'drawing' }]);
    assert.equal(store.loadLineAward(), null);
    const after = dump(path) as unknown[][];
    // Only the phase head of events changes; prizes, active event, awards and the first audit row are untouched.
    const { phase: _p, lastTransitionAt: _l, ...eventBefore } = before[0][0] as Record<string, unknown>;
    const { phase: _p2, lastTransitionAt: _l2, ...eventAfter } = after[0][0] as Record<string, unknown>;
    assert.deepEqual(eventAfter, eventBefore);
    assert.deepEqual([after[2], after[3], after[4]], [before[2], before[3], before[4]]);
    assert.deepEqual((after[1] as unknown[]).slice(0, 1), before[1]);
    // A new baseline and an ordinary direct declaration work afterwards.
    const baseline = store.loadLineDeclarationBaseline();
    assert.deepEqual(baseline, { eventId: event.id, calledNumbers: [7, 42], phase: 'drawing', lastTransitionAt: T2,
      auditSequence: 2, linePrize: { amount: 10, lot: 'Jamón' } });
    assert.equal(store.declareLineDirectly(baseline, 1, T3).award.winnerCount, 1);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try { assert.equal(reopened.load()?.phase, 'line_declared'); } finally { reopened.close(); }
});

test('cancelLegacyLineCheck survives a reopen of the legacy checking_line before cancelling', (t) => {
  const { path, store } = openLegacyCheck(t);
  store.close();
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.cancelLegacyLineCheck(reopened.loadLegacyLineCheck(), T2).phase, 'drawing');
    assert.equal(reopened.readAudit().length, 2);
  } finally { reopened.close(); }
});

test('cancelLegacyLineCheck is single-use: a duplicate and a stale second connection are refused unchanged', (t) => {
  const { path, store } = openLegacyCheck(t);
  const other = createEventStore(path);
  try {
    const check = store.loadLegacyLineCheck();
    const staleCopy = other.loadLegacyLineCheck();
    store.cancelLegacyLineCheck(check, T2);
    const after = dump(path);
    assert.throws(() => store.cancelLegacyLineCheck(check, T3), /not eligible/i);
    assert.throws(() => other.cancelLegacyLineCheck(staleCopy, T3), /not eligible/i);
    assert.deepEqual(dump(path), after);
    // Re-entering checking_line gives a new identity; the old one never matches it.
    other.transitionPhase('begin_line_check', T3);
    const before = dump(path);
    assert.throws(() => store.cancelLegacyLineCheck(check, '2025-01-01T00:00:04.000Z'), /stale/i);
    assert.deepEqual(dump(path), before);
  } finally { other.close(); store.close(); }
});

test('cancelLegacyLineCheck refuses a different event, audit, head or malformed identity without writing', (t) => {
  const { path, store } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    const before = dump(path);
    const bad: unknown[] = [
      null, undefined, 'x', [], {}, { ...check, eventId: 'other' }, { ...check, auditSequence: 2 },
      { ...check, lastTransitionAt: T2 }, { ...check, phase: 'drawing' }, { ...check, extra: 1 },
      { ...check, auditSequence: '1' }, { ...check, auditSequence: 0 }, { ...check, lastTransitionAt: null },
      { eventId: check.eventId, phase: 'checking_line', lastTransitionAt: T1 },
    ];
    for (const value of bad) assert.throws(() => store.cancelLegacyLineCheck(value, T2), /./, JSON.stringify(value));
    for (const at of [T1, '2024-01-01T00:00:00.000Z', '2025-01-01', 'nope', 5, null, undefined]) {
      assert.throws(() => store.cancelLegacyLineCheck(check, at), /timestamp/i, String(at));
    }
    assert.deepEqual(dump(path), before);
    assert.equal(store.load()?.phase, 'checking_line');
  } finally { store.close(); }
});

test('cancelLegacyLineCheck rolls back on a state or audit failure and under a writer lock', (t) => {
  const { path, store } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    const before = dump(path);
    for (const [name, trigger] of [
      ['state', `CREATE TRIGGER fail_cancel BEFORE UPDATE OF phase ON events
        BEGIN SELECT RAISE(ABORT, 'state failed'); END`],
      ['audit', `CREATE TRIGGER fail_cancel BEFORE INSERT ON phase_audit
        BEGIN SELECT RAISE(ABORT, 'audit failed'); END`],
    ] as const) {
      withDb(path, (db) => db.exec(trigger));
      assert.throws(() => store.cancelLegacyLineCheck(check, T2), new RegExp(`${name} failed`));
      withDb(path, (db) => db.exec('DROP TRIGGER fail_cancel'));
      assert.deepEqual(dump(path), before, name);
    }
    withDb(path, (db) => {
      db.exec('BEGIN IMMEDIATE');
      try { assert.throws(() => store.cancelLegacyLineCheck(check, T2), /locked|busy/i); }
      finally { db.exec('ROLLBACK'); }
    });
    assert.deepEqual(dump(path), before);
    assert.equal(store.cancelLegacyLineCheck(check, T2).phase, 'drawing');
  } finally { store.close(); }
});

test('cancelLegacyLineCheck copies the expected identity so later caller mutation changes nothing', (t) => {
  const { store } = openLegacyCheck(t);
  try {
    const check = { ...store.loadLegacyLineCheck() };
    const result = store.cancelLegacyLineCheck(check, T2);
    check.auditSequence = 99;
    assert.equal(result.lastTransitionAt, T2);
    assert.equal(store.readAudit().length, 2);
  } finally { store.close(); }
});

// ---- REC-01 blockers: one bound read snapshot for the readback, and typed eligibility vs corruption ----
const NOT_ELIGIBLE = 'legacy_check_not_eligible';
const codeOf = (error: unknown) => (error as { code?: unknown }).code;
// Test-only damage that bypasses the schema guards a corrupted profile would already have slipped past.
const damage = (db: DatabaseSync, sql: string) => {
  db.exec('PRAGMA ignore_check_constraints = 1');
  db.exec('PRAGMA foreign_keys = 0');
  db.exec('DROP TRIGGER IF EXISTS phase_audit_no_update');
  db.exec('DROP TRIGGER IF EXISTS phase_audit_no_delete');
  db.exec(sql);
};

test('confirmLegacyLineCancel reports unchanged, recovered and stale from one bound snapshot', (t) => {
  const { store } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    assert.equal(store.confirmLegacyLineCancel(check, T2), 'unchanged');
    store.cancelLegacyLineCheck(check, T2);
    assert.equal(store.confirmLegacyLineCancel(check, T2), 'recovered');
    assert.equal(store.confirmLegacyLineCancel(check, T3), 'stale', 'a different timestamp is not our commit');
    assert.equal(store.confirmLegacyLineCancel({ ...check, auditSequence: 2 }, T2), 'stale');
    assert.equal(store.confirmLegacyLineCancel({ ...check, lastTransitionAt: T2 }, T2), 'stale');
    assert.throws(() => store.confirmLegacyLineCancel({ ...check, extra: 1 }, T2), /invalid/i);
    assert.throws(() => store.confirmLegacyLineCancel(check, 'nope'), /timestamp/i);
  } finally { store.close(); }
});

test('confirmLegacyLineCancel never accepts another event whose audit row matches position and timestamp', (t) => {
  const { path, store, event } = openLegacyCheck(t);
  const other = createEventStore(path);
  try {
    const check = store.loadLegacyLineCheck();
    // Event B has the same audit shape: begin at T1 (row 1), then a reject_line_claim at T2 (row 2).
    const b = other.createEvent({ name: 'B', date: '2025-01-01', place: 'Y' });
    other.selectEvent(b.id);
    other.transitionPhase('begin_line_check', T1);
    other.transitionPhase('reject_line_claim', T2);
    assert.equal(other.readAudit()[check.auditSequence].kind, 'reject_line_claim');
    assert.equal(other.readAudit()[check.auditSequence].transitionAt, T2);
    assert.equal(store.confirmLegacyLineCancel(check, T2), 'stale');
    // A itself was never cancelled: selecting it back still reads unchanged.
    other.selectEvent(event.id);
    assert.equal(store.confirmLegacyLineCancel(check, T2), 'unchanged');
    assert.equal(store.loadLegacyLineCheck().eventId, event.id);
  } finally { other.close(); store.close(); }
});

test('confirmLegacyLineCancel sees a real commit made through a second connection and writes nothing', (t) => {
  const { path, store } = openLegacyCheck(t);
  const other = createEventStore(path);
  try {
    const check = store.loadLegacyLineCheck();
    other.cancelLegacyLineCheck(check, T2);
    const before = dump(path);
    assert.equal(store.confirmLegacyLineCancel(check, T2), 'recovered');
    assert.deepEqual(dump(path), before);
  } finally { other.close(); store.close(); }
});

test('confirmLegacyLineCancel fails closed on corrupt or unreadable storage', (t) => {
  const { path, store } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    withDb(path, (db) => damage(db, "UPDATE phase_audit SET kind = 'bogus'"));
    assert.throws(() => store.confirmLegacyLineCancel(check, T2), /invalid/i);
    withDb(path, (db) => db.exec('DROP TABLE phase_audit'));
    assert.throws(() => store.confirmLegacyLineCancel(check, T2), /./);
  } finally { store.close(); }
});

test('confirmLegacyLineCancel rejects corrupt awards in unchanged and recovered snapshots', (t) => {
  const { path, store, event } = openLegacyCheck(t);
  try {
    const check = store.loadLegacyLineCheck();
    // Well-formed award whose audit link points at the begin_line_check row (sequence 1).
    insertAward(path, event.id, { audit_sequence: 1 }, true);
    let before = dump(path);
    assert.throws(() => store.confirmLegacyLineCancel(check, T2), /Invalid stored line award: audit link/);
    assert.deepEqual(dump(path), before, 'unchanged case writes nothing');
    withDb(path, (db) => {
      db.exec('PRAGMA ignore_check_constraints = 1; PRAGMA foreign_keys = OFF');
      db.exec('DROP TRIGGER IF EXISTS phase_audit_no_update');
      db.prepare('UPDATE events SET phase = ?, lastTransitionAt = ? WHERE id = ?').run('drawing', T2, event.id);
      db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
        VALUES (?, 2, ?, 'reject_line_claim', 'checking_line', 'drawing')`).run(event.id, T2);
    });
    before = dump(path);
    assert.throws(() => store.confirmLegacyLineCancel(check, T2), /Invalid stored line award: audit link/);
    assert.deepEqual(dump(path), before, 'recovered case writes nothing');
  } finally { store.close(); }
});

test('loadLegacyLineCheck marks only legitimate non-eligibility with a typed code', (t) => {
  const empty = createEventStore(fixture(t));
  try {
    assert.throws(() => empty.loadLegacyLineCheck(), (e) => codeOf(e) === NOT_ELIGIBLE);
  } finally { empty.close(); }
  const { store } = openDrawing(t);
  try {
    assert.throws(() => store.loadLegacyLineCheck(), (e) => codeOf(e) === NOT_ELIGIBLE);
    store.transitionPhase('begin_line_check', T1);
    store.transitionPhase('declare_line', T2);
    assert.throws(() => store.loadLegacyLineCheck(), (e) => codeOf(e) === NOT_ELIGIBLE);
    assert.throws(() => store.cancelLegacyLineCheck({ eventId: 'x', phase: 'checking_line', lastTransitionAt: T1,
      auditSequence: 1 }, T3), (e) => codeOf(e) === NOT_ELIGIBLE);
  } finally { store.close(); }
});

test('loadLegacyLineCheck never reports corrupt phase, audit or award data as not eligible', (t) => {
  const corrupt = (label: string, damage: (db: DatabaseSync) => void, prepare?: (s: ReturnType<typeof createEventStore>) => void) => {
    const { path, store } = openLegacyCheck(t);
    try {
      prepare?.(store);
      withDb(path, damage);
      assert.throws(() => store.loadLegacyLineCheck(), (e) => codeOf(e) !== NOT_ELIGIBLE && /./.test(String(e)), label);
    } finally { store.close(); }
  };
  corrupt('phase', (db) => damage(db, "UPDATE events SET phase = 'bogus'"));
  corrupt('phase head', (db) => damage(db, 'UPDATE events SET lastTransitionAt = NULL'));
  corrupt('audit', (db) => damage(db, "UPDATE phase_audit SET kind = 'bogus'"));
  corrupt('audit gap', (db) => damage(db, 'UPDATE phase_audit SET sequence = 2'));
  corrupt('missing audit table', (db) => db.exec('DROP TABLE phase_audit'));
  corrupt('award table', (db) => db.exec('DROP TABLE line_awards'));
  // An award next to a checking_line head: a direct declaration never leaves that phase, so this is corruption.
  const { path, store, event } = openDrawing(t);
  try {
    store.declareLineDirectly(store.loadLineDeclarationBaseline(), 1, T1);
    withDb(path, (db) => {
      damage(db, 'DELETE FROM phase_audit');
      db.prepare("INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase) VALUES (?, 1, ?, 'begin_line_check', 'drawing', 'checking_line')")
        .run(event.id, T1);
      db.exec("UPDATE events SET phase = 'checking_line'");
    });
    assert.throws(() => store.loadLegacyLineCheck(), (e) => codeOf(e) !== NOT_ELIGIBLE && /./.test(String(e)), 'award');
  } finally { store.close(); }
});
