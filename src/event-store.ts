import { closeSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventSnapshot } from './event-core';
import type { GamePhase } from './game-phase';

const VERSION = 2;
const phases = ['drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished'];
const phaseCheck = `CHECK (phase IN (${phases.map((phase) => `'${phase}'`).join(', ')}))`;
const auditTable = `CREATE TABLE phase_audit (
  sequence INTEGER PRIMARY KEY,
  transitionAt TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL
)`;
const auditGuards = [
  `CREATE TRIGGER phase_audit_no_update BEFORE UPDATE ON phase_audit
    BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END`,
  `CREATE TRIGGER phase_audit_no_delete BEFORE DELETE ON phase_audit
    BEGIN SELECT RAISE(ABORT, 'phase audit is immutable'); END`,
];

type StoredEvent = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };

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

function columns(db: DatabaseSync, name: string) {
  return db.prepare(`PRAGMA table_info(${name})`).all();
}

function validateV1(db: DatabaseSync): void {
  const fields = columns(db, 'current_event');
  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'current_event'")
    .get()?.sql;
  const normalized = typeof definition === 'string'
    ? definition.replace(/[\s"`\[\]]/g, '').toUpperCase() : '';
  if (fields.length !== 2 || fields[0].name !== 'id' || fields[0].type !== 'INTEGER' ||
      fields[0].pk !== 1 || fields[1].name !== 'history' || fields[1].type !== 'TEXT' ||
      fields[1].notnull !== 1 || !/CHECK\(+ID=1\)+(?=[,)])/.test(normalized)) {
    throw new Error('Invalid event schema: current_event table missing or malformed');
  }
}

function extendSchema(db: DatabaseSync): void {
  db.exec(`ALTER TABLE current_event ADD COLUMN phase TEXT NOT NULL DEFAULT 'drawing' ${phaseCheck};
    ALTER TABLE current_event ADD COLUMN lastTransitionAt TEXT;
    ${auditTable};
    ${auditGuards.join(';')};`);
}

function validateV2(db: DatabaseSync): void {
  const fields = columns(db, 'current_event');
  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'current_event'")
    .get()?.sql;
  const normalized = typeof definition === 'string'
    ? definition.replace(/[\s"`\[\]]/g, '').toUpperCase() : '';
  const expectedCheck = phaseCheck.replace(/\s/g, '').toUpperCase();
  if (fields.length !== 4 || fields[0].name !== 'id' || fields[0].type !== 'INTEGER' ||
      fields[0].pk !== 1 || fields[1].name !== 'history' || fields[1].type !== 'TEXT' ||
      fields[1].notnull !== 1 || fields[2].name !== 'phase' || fields[2].type !== 'TEXT' ||
      fields[2].notnull !== 1 || fields[3].name !== 'lastTransitionAt' ||
      fields[3].type !== 'TEXT' || !/CHECK\(+ID=1\)+(?=[,)])/.test(normalized) ||
      !normalized.includes(expectedCheck)) {
    throw new Error('Invalid event schema: current_event table missing or malformed');
  }
  const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'phase_audit' AND type = 'table'").get()?.sql;
  const normalize = (sql: string) => sql.replace(/\s/g, '').toUpperCase();
  if (typeof stored !== 'string' || normalize(stored) !== normalize(auditTable)) {
    throw new Error('Invalid event schema: phase audit table missing or malformed');
  }
  for (const guard of auditGuards) {
    const name = guard.split(' ')[2];
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ? AND type = 'trigger'").get(name)?.sql;
    if (typeof sql !== 'string' || normalize(sql) !== normalize(guard)) {
      throw new Error('Invalid event schema: phase audit guard missing or malformed');
    }
  }
}

function readEvent(db: DatabaseSync): StoredEvent | null {
  const rows = db.prepare('SELECT id, history, phase, lastTransitionAt FROM current_event').all();
  if (rows.length > 1 || (rows.length === 1 && rows[0].id !== 1)) {
    throw new Error('Invalid event history: unexpected event rows');
  }
  const audit = db.prepare('SELECT count(*) AS count FROM phase_audit').get()?.count;
  // Nonempty replay belongs to the subsequent atomic-transition unit. Until then, reject it.
  if (audit !== 0) throw new Error('Invalid phase audit: unsupported nonempty history');
  if (rows.length === 0) return null;
  const row = rows[0];
  const history = decode(row.history);
  if (row.phase !== 'drawing' || row.lastTransitionAt !== null) {
    throw new Error('Invalid phase audit: empty audit requires initial drawing state');
  }
  return { calledNumbers: history.calledNumbers, phase: 'drawing', lastTransitionAt: null };
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
          )`);
          extendSchema(candidate);
          candidate.exec('PRAGMA user_version = 2; COMMIT');
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
    // A deferred read transaction pins version, schema, and state to one snapshot
    // without claiming the writer lock held by an independent connection.
    db.exec('BEGIN');
    try {
      const observed = db.prepare('PRAGMA user_version').get()?.user_version;
      if (observed !== 1 && observed !== VERSION) {
        throw new Error(`Unsupported event schema version: ${String(observed)}`);
      }
      if (observed === VERSION) {
        validateV2(db);
        readEvent(db);
        db.exec('COMMIT');
      } else {
        // Drop the read snapshot before acquiring the migration writer lock.
        // Another opener may have migrated meanwhile, so recheck everything under it.
        db.exec('COMMIT');
        db.exec('BEGIN IMMEDIATE');
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        if (version === 1) {
          validateV1(db);
          const rows = db.prepare('SELECT id, history FROM current_event').all();
          if (rows.length > 1 || (rows.length === 1 && rows[0].id !== 1)) {
            throw new Error('Invalid event history: unexpected event rows');
          }
          if (rows.length === 1) decode(rows[0].history);
          extendSchema(db);
          // Updating the row also detects any failing write before the version is published.
          if (rows.length === 1) db.exec("UPDATE current_event SET phase = 'drawing', lastTransitionAt = NULL WHERE id = 1");
          db.exec('PRAGMA user_version = 2');
        } else if (version !== VERSION) {
          throw new Error(`Unsupported event schema version: ${String(version)}`);
        }
        validateV2(db);
        readEvent(db);
        db.exec('COMMIT');
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
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
    load(): StoredEvent | null { return readEvent(db); },
    create(): StoredEvent {
      return transaction(() => {
        if (readEvent(db) !== null) throw new Error('Current event already exists');
        const event: StoredEvent = { calledNumbers: [], phase: 'drawing', lastTransitionAt: null };
        db.prepare('INSERT INTO current_event (id, history) VALUES (1, ?)').run('[]');
        return event;
      });
    },
    update(transition: (current: StoredEvent) => EventSnapshot): StoredEvent {
      return transaction(() => {
        const current = readEvent(db);
        if (current === null) throw new Error('Current event does not exist');
        const baseline = [...current.calledNumbers];
        const proposed = transition(current);
        // Replay through the core's invariants, including ordering and duplicate checks.
        const next = decode(JSON.stringify(proposed.calledNumbers));
        if (next.calledNumbers.length < baseline.length ||
            baseline.some((number, index) => next.calledNumbers[index] !== number)) {
          throw new Error('Invalid event transition: called history cannot be rewritten');
        }
        db.prepare('UPDATE current_event SET history = ? WHERE id = 1').run(JSON.stringify(next.calledNumbers));
        return { ...current, calledNumbers: next.calledNumbers };
      });
    },
    close(): void { db.close(); },
  };
}
