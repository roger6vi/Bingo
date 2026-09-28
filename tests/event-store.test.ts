import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';
import { DEFAULT_THEME, THEME_IDS } from '../src/theme.ts';

function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-event-store-'));
  const path = join(directory, 'event.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path;
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
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4));
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
  assert.deepEqual(secondResult, { version: 4, empty: true });
  assert.deepEqual(firstResult, { version: 4, empty: true });
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

test('unsupported version and existing unknown database never initialize as version 4', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec('PRAGMA user_version = 5'));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5));

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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.equal(db.prepare('SELECT count(*) AS count FROM events').get()?.count, 1);
    assert.equal(db.prepare('SELECT id FROM events').get()?.id, firstId);
    assert.equal(db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id, firstId);
  });
});

function v3(path: string, options: { history?: string; phase?: string; lastTransitionAt?: string | null;
  theme?: string } = {}) {
  const { history = '[90,1]', phase = 'drawing', lastTransitionAt = null, theme = DEFAULT_THEME } = options;
  withDb(path, (db) => {
    db.exec(`CREATE TABLE current_event (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      history TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'drawing' CHECK (phase IN ('drawing', 'checking_line', 'line_declared',
        'checking_bingo', 'bingo_declared', 'finished')),
      lastTransitionAt TEXT,
      theme TEXT NOT NULL DEFAULT '${DEFAULT_THEME}' CHECK (theme IN (${THEME_IDS.map((id) => `'${id}'`).join(', ')}))
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

test('unsupported version 5 is rejected outright', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec('PRAGMA user_version = 5'));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5));
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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
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
      assert.equal(writer.prepare('PRAGMA user_version').get()?.user_version, 4);
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

test('the theme allow-list matches the generated semantic token themes', () => {
  const themes = fs.readdirSync(new URL('../tokens/semantic/', import.meta.url))
    .map((file) => file.replace(/\.json$/, '')).sort();
  assert.deepEqual([...THEME_IDS].sort(), themes);
});

test('a saved theme defaults to pixel-classic and recovers each registered theme after reopening', (t) => {
  const path = fixture(t);
  const initial = createEventStore(path);
  try { initial.create(); assert.equal(initial.loadTheme(), DEFAULT_THEME); }
  finally { initial.close(); }
  for (const theme of ['high-contrast', 'pixel-classic'] as const) {
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
    '/etc/passwd', 'High-Contrast', 'dark', '', ' pixel-classic', null, 1, { theme: 'pixel-classic' }]) {
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
  try { assert.throws(() => store.saveTheme('pixel-classic'), /locked|busy/i); }
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
    { version: 4, themes: ['pixel-classic', 'high-contrast'] },
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
