import { closeSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventSnapshot } from './event-core';
import { transitionPhase, type GamePhase, type PhaseTransitionIntent } from './game-phase.ts';
import { DEFAULT_THEME, isThemeId, THEME_IDS, type ThemeId } from './theme.ts';

const VERSION = 3;
const phases = ['drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished'];
const phaseCheck = `CHECK (phase IN (${phases.map((phase) => `'${phase}'`).join(', ')}))`;
const themeCheck = `CHECK (theme IN (${THEME_IDS.map((theme) => `'${theme}'`).join(', ')}))`;
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
export type PhaseAuditEntry = {
  readonly sequence: number;
  readonly transitionAt: string;
  readonly kind: PhaseTransitionIntent;
  readonly from_phase: GamePhase;
  readonly to_phase: GamePhase;
};

function canonicalTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}


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
      fields[2].notnull !== 1 || fields[2].dflt_value !== "'drawing'" ||
      fields[3].name !== 'lastTransitionAt' ||
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

function extendV3Schema(db: DatabaseSync): void {
  db.exec(`ALTER TABLE current_event ADD COLUMN theme TEXT NOT NULL DEFAULT '${DEFAULT_THEME}' ${themeCheck}`);
}

function validateV3(db: DatabaseSync): void {
  const fields = columns(db, 'current_event');
  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'current_event'")
    .get()?.sql;
  const normalized = typeof definition === 'string'
    ? definition.replace(/[\s"`\[\]]/g, '').toUpperCase() : '';
  const expectedPhaseCheck = phaseCheck.replace(/\s/g, '').toUpperCase();
  const expectedThemeCheck = themeCheck.replace(/\s/g, '').toUpperCase();
  if (fields.length !== 5 || fields[0].name !== 'id' || fields[0].type !== 'INTEGER' ||
      fields[0].pk !== 1 || fields[1].name !== 'history' || fields[1].type !== 'TEXT' ||
      fields[1].notnull !== 1 || fields[2].name !== 'phase' || fields[2].type !== 'TEXT' ||
      fields[2].notnull !== 1 || fields[2].dflt_value !== "'drawing'" ||
      fields[3].name !== 'lastTransitionAt' || fields[3].type !== 'TEXT' ||
      fields[4].name !== 'theme' || fields[4].type !== 'TEXT' || fields[4].notnull !== 1 ||
      fields[4].dflt_value !== `'${DEFAULT_THEME}'` ||
      !/CHECK\(+ID=1\)+(?=[,)])/.test(normalized) ||
      !normalized.includes(expectedPhaseCheck) || !normalized.includes(expectedThemeCheck)) {
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

function readTheme(db: DatabaseSync): ThemeId {
  const rows = db.prepare('SELECT theme FROM current_event WHERE id = 1').all();
  if (rows.length === 0) return DEFAULT_THEME;
  const value = rows[0].theme;
  if (!isThemeId(value)) throw new Error('Invalid stored theme');
  return value;
}

function replayAudit(db: DatabaseSync): PhaseAuditEntry[] {
  const rows = db.prepare('SELECT sequence, transitionAt, kind, from_phase, to_phase FROM phase_audit ORDER BY sequence').all();
  let phase: GamePhase = 'drawing';
  let previous: string | null = null;
  return rows.map((row, index) => {
    if (row.sequence !== index + 1 || row.from_phase !== phase || !canonicalTime(row.transitionAt) ||
        (previous !== null && row.transitionAt <= previous)) {
      throw new Error('Invalid phase audit: sequence, source phase, or timestamp');
    }
    let target: GamePhase;
    try { target = transitionPhase({ phase }, row.kind as PhaseTransitionIntent).phase; }
    catch { throw new Error('Invalid phase audit: illegal intent'); }
    if (row.to_phase !== target) throw new Error('Invalid phase audit: target phase mismatch');
    const entry: PhaseAuditEntry = { sequence: index + 1, transitionAt: row.transitionAt,
      kind: row.kind as PhaseTransitionIntent, from_phase: phase, to_phase: target };
    phase = target;
    previous = row.transitionAt;
    return entry;
  });
}

function readEvent(db: DatabaseSync): StoredEvent | null {
  const rows = db.prepare('SELECT id, history, phase, lastTransitionAt FROM current_event').all();
  if (rows.length > 1 || (rows.length === 1 && rows[0].id !== 1)) {
    throw new Error('Invalid event history: unexpected event rows');
  }
  const audit = replayAudit(db);
  if (rows.length === 0) {
    if (audit.length !== 0) throw new Error('Invalid phase audit: missing current event');
    return null;
  }
  const row = rows[0];
  const history = decode(row.history);
  const last = audit.at(-1);
  if (row.phase !== (last?.to_phase ?? 'drawing') ||
      row.lastTransitionAt !== (last?.transitionAt ?? null)) {
    throw new Error('Invalid phase audit: current state does not match history');
  }
  return { calledNumbers: history.calledNumbers, phase: row.phase as GamePhase,
    lastTransitionAt: row.lastTransitionAt as string | null };
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
          extendV3Schema(candidate);
          candidate.exec('PRAGMA user_version = 3; COMMIT');
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
      if (observed !== 1 && observed !== 2 && observed !== VERSION) {
        throw new Error(`Unsupported event schema version: ${String(observed)}`);
      }
      if (observed === VERSION) {
        validateV3(db);
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
          extendV3Schema(db);
          db.exec('PRAGMA user_version = 3');
        } else if (version === 2) {
          validateV2(db);
          extendV3Schema(db);
          db.exec('PRAGMA user_version = 3');
        } else if (version !== VERSION) {
          throw new Error(`Unsupported event schema version: ${String(version)}`);
        }
        validateV3(db);
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

  function readSnapshot<T>(action: () => T): T {
    db.exec('BEGIN');
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
    load(): StoredEvent | null { return readSnapshot(() => readEvent(db)); },
    loadTheme(): ThemeId { return readSnapshot(() => readTheme(db)); },
    // Returns the value read back inside the committing transaction.
    saveTheme(theme: unknown): ThemeId {
      if (!isThemeId(theme)) throw new Error('Unknown theme');
      return transaction(() => {
        const rows = db.prepare('SELECT id FROM current_event WHERE id = 1').all();
        if (rows.length === 0) throw new Error('Current event does not exist');
        db.prepare('UPDATE current_event SET theme = ? WHERE id = 1').run(theme);
        return readTheme(db);
      });
    },
    readAudit(): PhaseAuditEntry[] {
      return readSnapshot(() => {
        readEvent(db);
        return replayAudit(db);
      });
    },
    transitionPhase(intent: PhaseTransitionIntent, transitionAt: string): StoredEvent {
      return transaction(() => {
        const current = readEvent(db);
        if (current === null) throw new Error('Current event does not exist');
        const phase = transitionPhase(current, intent).phase;
        if (!canonicalTime(transitionAt) ||
            (current.lastTransitionAt !== null && transitionAt <= current.lastTransitionAt)) {
          throw new Error('Invalid phase transition timestamp');
        }
        const sequence = replayAudit(db).length + 1;
        db.prepare('UPDATE current_event SET phase = ?, lastTransitionAt = ? WHERE id = 1')
          .run(phase, transitionAt);
        db.prepare(`INSERT INTO phase_audit (sequence, transitionAt, kind, from_phase, to_phase)
          VALUES (?, ?, ?, ?, ?)`).run(sequence, transitionAt, intent, current.phase, phase);
        return { ...current, phase, lastTransitionAt: transitionAt };
      });
    },
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
        const phase = current.phase;
        const lastTransitionAt = current.lastTransitionAt;
        const proposed = transition(current);
        if (current.phase !== phase || current.lastTransitionAt !== lastTransitionAt ||
            ('phase' in proposed && proposed.phase !== phase) ||
            ('lastTransitionAt' in proposed && proposed.lastTransitionAt !== lastTransitionAt)) {
          throw new Error('Invalid event transition: phase and timestamp require an audit intent');
        }
        // Replay through the core's invariants, including ordering and duplicate checks.
        const next = decode(JSON.stringify(proposed.calledNumbers));
        if (next.calledNumbers.length < baseline.length ||
            baseline.some((number, index) => next.calledNumbers[index] !== number)) {
          throw new Error('Invalid event transition: called history cannot be rewritten');
        }
        db.prepare('UPDATE current_event SET history = ? WHERE id = 1').run(JSON.stringify(next.calledNumbers));
        return { calledNumbers: next.calledNumbers, phase, lastTransitionAt };
      });
    },
    close(): void { db.close(); },
  };
}
