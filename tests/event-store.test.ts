import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1));
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
    const reopened = createEventStore(path);
    try {
      assert.throws(() => reopened.load(), /invalid|history|event/i);
      assert.throws(() => reopened.update((event) => drawManual(event, 4)), /invalid|history|event/i);
    } finally { reopened.close(); }
    withDb(path, (db) => assert.equal(db.prepare('SELECT history FROM current_event').get()?.history, history));
  }
  withDb(path, (db) => db.exec('DROP TABLE current_event'));
  assert.throws(() => createEventStore(path), /schema|table|invalid/i);
});

test('unsupported version and existing unknown database never initialize as version 1', (t) => {
  const path = fixture(t);
  withDb(path, (db) => db.exec('PRAGMA user_version = 2'));
  assert.throws(() => createEventStore(path), /version|unsupported/i);
  withDb(path, (db) => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2));

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
