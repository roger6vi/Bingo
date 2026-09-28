import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createEventStore } from '../src/event-store.ts';

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
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2));
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
  assert.deepEqual(secondResult, { version: 2, empty: true });
  assert.deepEqual(firstResult, { version: 2, empty: true });
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
    withDb(path, (db) => db.exec(`CREATE TRIGGER refuse_write BEFORE UPDATE ON current_event
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
    withDb(path, (db) => db.prepare('UPDATE current_event SET history = ?').run(history));
    assert.throws(() => createEventStore(path), /invalid|history|event/i);
    withDb(path, (db) => assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, history));
  }
  withDb(path, (db) => db.exec('DROP TABLE current_event'));
  assert.throws(() => createEventStore(path), /schema|table|invalid/i);
});

test('unsupported version and existing unknown database never initialize as version 2', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec('PRAGMA user_version = 3'));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3));

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

test('valid v1 migrates once, preserves ordered calls, and rejects a persisted injected audit row', (t) => {
  const path = fixture(t);
  v1(path);
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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, '[90,1,45]');
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 0);
    assert.throws(() => db.exec(`INSERT INTO phase_audit
      (transitionAt, kind, from_phase, to_phase) VALUES ('2025-01-01T00:00:00.000Z', 'begin_line_check', 'drawing', 'checking_line');
      UPDATE phase_audit SET kind = 'finish'`), /audit|immutable|update/i);
    // The INSERT committed before the rejected UPDATE; it must remain on disk.
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 1);
  });
  assert.throws(() => createEventStore(path), /invalid phase audit/i);
});

test('fresh v2 starts in drawing with null timestamp and guarded empty audit', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try {
    assert.equal(store.load(), null);
    assert.deepEqual(store.create(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null });
  } finally { store.close(); }
  withDb(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count, 0);
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='phase_audit_no_delete'").get());
  });
  const reopened = createEventStore(path);
  try { assert.deepEqual(reopened.load(), { calledNumbers: [], phase: 'drawing', lastTransitionAt: null }); }
  finally { reopened.close(); }
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

test('opening valid v2 under an independent writer lock reads the same ordered snapshot without mutation', (t) => {
  const path = fixture(t);
  const initial = createEventStore(path);
  try {
    initial.create();
    initial.update((event) => drawManual(event, 90));
    initial.update((event) => drawManual(event, 1));
  } finally { initial.close(); }
  withDb(path, (writer) => {
    const before = writer.prepare('SELECT id, history, phase, lastTransitionAt FROM current_event').all();
    writer.exec('BEGIN IMMEDIATE');
    try {
      const reopened = createEventStore(path);
      try {
        assert.deepEqual(reopened.load(), { calledNumbers: [90, 1], phase: 'drawing', lastTransitionAt: null });
      } finally { reopened.close(); }
      assert.deepEqual(writer.prepare('SELECT id, history, phase, lastTransitionAt FROM current_event').all(), before);
      assert.equal(writer.prepare('PRAGMA user_version').get()?.user_version, 2);
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

test('malformed v2 phase, missing audit guards, and inconsistent empty audit fail closed', (t) => {
  const path = fixture(t);
  const store = createEventStore(path);
  try { store.create(); } finally { store.close(); }
  withDb(path, (db) => db.exec("UPDATE current_event SET phase = 'line_declared'"));
  assert.throws(() => createEventStore(path), /invalid|audit|phase/i);
  withDb(path, (db) => {
    db.exec("UPDATE current_event SET phase = 'drawing'");
    db.exec('DROP TRIGGER phase_audit_no_delete');
  });
  assert.throws(() => createEventStore(path), /invalid|audit|schema/i);
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
