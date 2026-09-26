import { closeSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventSnapshot } from './event-core';

const VERSION = 1;

function existed(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function decode(history: unknown): EventSnapshot {
  if (typeof history !== 'string') throw new Error('Invalid event history: expected text');
  let values: unknown;
  try { values = JSON.parse(history); }
  catch { throw new Error('Invalid event history: malformed JSON'); }
  if (!Array.isArray(values)) throw new Error('Invalid event history: expected an array');
  // Apply the event core's 1–90 integer, uniqueness, and exhaustion invariants
  // without a runtime import: direct .ts imports do not resolve in emitted CommonJS.
  const calledNumbers: number[] = [];
  const called = new Set<number>();
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 90 ||
        called.size === 90 || called.has(value)) {
      throw new Error('Invalid event history: invalid or duplicate call');
    }
    called.add(value);
    calledNumbers.push(value);
  }
  return { calledNumbers };
}

export function createEventStore(path: string) {
  if (!existed(path)) {
    // Initialize off-path: the target must never expose SQLite's transient version-0 file.
    const stage = `${path}.${randomUUID()}.stage`;
    closeSync(openSync(stage, 'wx', 0o600));
    try {
      const candidate = new DatabaseSync(stage);
      try {
        candidate.exec('BEGIN IMMEDIATE');
        try {
          candidate.exec(`CREATE TABLE current_event (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            history TEXT NOT NULL
          ); PRAGMA user_version = 1; COMMIT`);
        } catch (error) {
          try { candidate.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
          throw error;
        }
      } finally { candidate.close(); }
      // A hard link publishes atomically without replacing a concurrent winner (or an unknown DB).
      try { linkSync(stage, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally { unlinkSync(stage); }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== VERSION) throw new Error(`Unsupported event schema version: ${String(version)}`);
      const columns = db.prepare('PRAGMA table_info(current_event)').all();
      const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'current_event'")
        .get()?.sql;
      // PRAGMA exposes key/nullability; only sqlite_schema records the CHECK clause.
      const normalized = typeof definition === 'string'
        ? definition.replace(/[\s"`\[\]]/g, '').toUpperCase() : '';
      if (columns.length !== 2 || columns[0].name !== 'id' || columns[0].type !== 'INTEGER' ||
          columns[0].pk !== 1 || columns[1].name !== 'history' || columns[1].type !== 'TEXT' ||
          columns[1].notnull !== 1 || !/CHECK\(+ID=1\)+(?=[,)])/.test(normalized)) {
        throw new Error('Invalid event schema: current_event table missing or malformed');
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const select = db.prepare('SELECT id, history FROM current_event');
  const insert = db.prepare('INSERT INTO current_event (id, history) VALUES (1, ?)');
  const replace = db.prepare('UPDATE current_event SET history = ? WHERE id = 1');

  function load(): EventSnapshot | null {
    const rows = select.all();
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0].id !== 1) throw new Error('Invalid event history: unexpected event rows');
    return decode(rows[0].history);
  }

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  return {
    load,
    create(): EventSnapshot {
      return transaction(() => {
        if (load() !== null) throw new Error('Current event already exists');
        const event: EventSnapshot = { calledNumbers: [] };
        insert.run(JSON.stringify(event.calledNumbers));
        return event;
      });
    },
    update(transition: (current: EventSnapshot) => EventSnapshot): EventSnapshot {
      return transaction(() => {
        const current = load();
        if (current === null) throw new Error('Current event does not exist');
        const baseline = [...current.calledNumbers];
        const proposed = transition(current);
        // Replay through the core's invariants, including ordering and duplicate checks.
        const next = decode(JSON.stringify(proposed.calledNumbers));
        if (next.calledNumbers.length < baseline.length ||
            baseline.some((number, index) => next.calledNumbers[index] !== number)) {
          throw new Error('Invalid event transition: called history cannot be rewritten');
        }
        replace.run(JSON.stringify(next.calledNumbers));
        return next;
      });
    },
    close(): void { db.close(); },
  };
}
