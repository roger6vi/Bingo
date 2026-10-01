import { closeSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventSnapshot } from './event-core';
import { transitionPhase, type GamePhase, type PhaseTransitionIntent } from './game-phase.ts';
import { DEFAULT_THEME, isThemeId, THEME_IDS, type ThemeId } from './theme.ts';
import { createLineAward, type LineAward, type LinePresentationStatus } from './line-award.ts';
import { MAX_PRIZE_AMOUNT, MAX_PRIZE_LOT, NO_PRIZES, normalizePrizes, validAmount, validLot,
  type EventPrizes } from './event-prizes.ts';

// Event prizes (#71) are the only v6 change and the first-line award table (#26/#28) is the only v7
// change. Each lives in its own table, so each step is one self-contained migration chained after the
// v5 theme allow-list step. If another change claims a version first, renumber and re-chain.
const VERSION = 7;
export const EVENT_SCHEMA_VERSION = VERSION;
const phases = ['drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished'];
const phaseCheck = `CHECK (phase IN (${phases.map((phase) => `'${phase}'`).join(', ')}))`;
// Existing databases are validated against this exact list: adding or renaming a theme id
// requires a schema version bump with a migration that rebuilds this CHECK.
const themeCheckFor = (ids: readonly string[]) => `CHECK (theme IN (${ids.map((theme) => `'${theme}'`).join(', ')}))`;
const themeCheck = themeCheckFor(THEME_IDS);
// Frozen theme allow-list and default of the v2–v4 schemas; only migrations read these.
const LEGACY_THEME_IDS = ['pixel-classic', 'high-contrast'] as const;
const LEGACY_DEFAULT_THEME = 'pixel-classic';
const legacyThemeCheck = themeCheckFor(LEGACY_THEME_IDS);
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

// Event-scoped schema (v4+): many independent events, one persisted active pointer.
function eventsTableSql(name: string, defaultTheme: string, check: string): string {
  return `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  place TEXT NOT NULL CHECK (length(trim(place)) > 0),
  history TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'drawing' ${phaseCheck},
  lastTransitionAt TEXT,
  theme TEXT NOT NULL DEFAULT '${defaultTheme}' ${check},
  createdAt TEXT NOT NULL
)`;
}
const eventsTable = eventsTableSql('events', DEFAULT_THEME, themeCheck);
const legacyEventsTable = eventsTableSql('events', LEGACY_DEFAULT_THEME, legacyThemeCheck);
const activeEventTable = `CREATE TABLE active_event (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  event_id TEXT NOT NULL REFERENCES events(id)
)`;
function auditTableV4Sql(name: string): string {
  return `CREATE TABLE ${name} (
  event_id TEXT NOT NULL REFERENCES events(id),
  sequence INTEGER NOT NULL,
  transitionAt TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  PRIMARY KEY (event_id, sequence)
)`;
}
const auditTableV4 = auditTableV4Sql('phase_audit');
const prizeColumns = (kind: 'line' | 'bingo') => `${kind}Amount INTEGER NOT NULL
    CHECK (typeof(${kind}Amount) = 'integer' AND ${kind}Amount BETWEEN 0 AND ${MAX_PRIZE_AMOUNT}),
  ${kind}Lot TEXT NOT NULL CHECK (typeof(${kind}Lot) = 'text' AND length(${kind}Lot) <= ${MAX_PRIZE_LOT})`;
// One optional row per event; an event without a row has no prizes.
const prizesTable = `CREATE TABLE event_prizes (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  ${prizeColumns('line')},
  ${prizeColumns('bingo')}
)`;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_AWARD_CENTS = 10_000_000;
const integerRange = (name: string, low: number, high: number) =>
  `typeof(${name}) = 'integer' AND ${name} BETWEEN ${low} AND ${high}`;
const integerColumn = (name: string, low: number, high: number) => `CHECK (${integerRange(name, low, high)})`;
// Optional first-line award, at most one per event, written later together with its audit row. Shares
// use integer division so the arithmetic cannot overflow for any safe winner count; the remainder is
// never assigned. Only a nonempty lot shared by 2+ winners needs a tie; presentation times are epoch ms.
const lineAwardsTable = `CREATE TABLE line_awards (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES events(id),
  audit_sequence INTEGER NOT NULL ${integerColumn('audit_sequence', 1, MAX_SAFE_INTEGER)},
  winner_count INTEGER NOT NULL ${integerColumn('winner_count', 1, MAX_SAFE_INTEGER)},
  total_cents INTEGER NOT NULL ${integerColumn('total_cents', 0, MAX_AWARD_CENTS)},
  share_cents INTEGER NOT NULL ${integerColumn('share_cents', 0, MAX_AWARD_CENTS)},
  remainder_cents INTEGER NOT NULL ${integerColumn('remainder_cents', 0, MAX_AWARD_CENTS)},
  lot TEXT NOT NULL CHECK (typeof(lot) = 'text' AND lot = trim(lot) AND length(lot) <= 120),
  lot_resolution TEXT NOT NULL CHECK (lot_resolution IN ('not_required', 'pending', 'resolved')),
  presentation_id TEXT NOT NULL UNIQUE CHECK (typeof(presentation_id) = 'text' AND length(trim(presentation_id)) > 0),
  presentation_status TEXT NOT NULL CHECK (presentation_status IN ('pending', 'failed', 'started', 'completed')),
  presentation_started_at INTEGER CHECK (presentation_started_at IS NULL OR
    ${integerRange('presentation_started_at', 0, MAX_SAFE_INTEGER)}),
  presentation_deadline INTEGER CHECK (presentation_deadline IS NULL OR
    ${integerRange('presentation_deadline', 0, MAX_SAFE_INTEGER)}),
  CHECK (share_cents = total_cents / winner_count AND remainder_cents = total_cents % winner_count),
  CHECK (CASE WHEN lot = '' OR winner_count < 2 THEN lot_resolution = 'not_required'
    ELSE lot_resolution IN ('pending', 'resolved') END),
  CHECK (CASE WHEN presentation_status IN ('pending', 'failed')
    THEN presentation_started_at IS NULL AND presentation_deadline IS NULL
    ELSE presentation_started_at IS NOT NULL AND presentation_deadline IS NOT NULL AND
      presentation_deadline > presentation_started_at END),
  FOREIGN KEY (event_id, audit_sequence) REFERENCES phase_audit(event_id, sequence)
)`;
const PLACEHOLDER_NAME = 'Evento actual';
const PLACEHOLDER_PLACE = 'Sin especificar';

type StoredEvent = EventSnapshot & { readonly phase: GamePhase; readonly lastTransitionAt: string | null };
export type EventSummary = {
  readonly id: string;
  readonly name: string;
  readonly date: string;
  readonly place: string;
  readonly phase: GamePhase;
  readonly createdAt: string;
  readonly active: boolean;
};
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

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function localDateToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  db.exec(`ALTER TABLE current_event ADD COLUMN theme TEXT NOT NULL DEFAULT '${LEGACY_DEFAULT_THEME}' ${legacyThemeCheck}`);
}

function validateV3(db: DatabaseSync): void {
  const fields = columns(db, 'current_event');
  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'current_event'")
    .get()?.sql;
  const normalized = typeof definition === 'string'
    ? definition.replace(/[\s"`\[\]]/g, '').toUpperCase() : '';
  const expectedPhaseCheck = phaseCheck.replace(/\s/g, '').toUpperCase();
  const expectedThemeCheck = legacyThemeCheck.replace(/\s/g, '').toUpperCase();
  if (fields.length !== 5 || fields[0].name !== 'id' || fields[0].type !== 'INTEGER' ||
      fields[0].pk !== 1 || fields[1].name !== 'history' || fields[1].type !== 'TEXT' ||
      fields[1].notnull !== 1 || fields[2].name !== 'phase' || fields[2].type !== 'TEXT' ||
      fields[2].notnull !== 1 || fields[2].dflt_value !== "'drawing'" ||
      fields[3].name !== 'lastTransitionAt' || fields[3].type !== 'TEXT' ||
      fields[4].name !== 'theme' || fields[4].type !== 'TEXT' || fields[4].notnull !== 1 ||
      fields[4].dflt_value !== `'${LEGACY_DEFAULT_THEME}'` ||
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

// v4 and v5 share every table; they differ only in the events theme DEFAULT and CHECK.
function validateV4(db: DatabaseSync, expectedEvents = eventsTable): void {
  const normalize = (sql: string) => sql.replace(/[\s"`\[\]]/g, '').toUpperCase();
  const eventsSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'events'").get()?.sql;
  if (typeof eventsSql !== 'string' || normalize(eventsSql) !== normalize(expectedEvents)) {
    throw new Error('Invalid event schema: events table missing or malformed');
  }
  const activeSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'active_event'")
    .get()?.sql;
  if (typeof activeSql !== 'string' || normalize(activeSql) !== normalize(activeEventTable)) {
    throw new Error('Invalid event schema: active_event table missing or malformed');
  }
  const auditSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'phase_audit'")
    .get()?.sql;
  if (typeof auditSql !== 'string' || normalize(auditSql) !== normalize(auditTableV4)) {
    throw new Error('Invalid event schema: phase audit table missing or malformed');
  }
  for (const guard of auditGuards) {
    const name = guard.split(' ')[2];
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ? AND type = 'trigger'").get(name)?.sql;
    if (typeof sql !== 'string' || normalize(sql) !== normalize(guard)) {
      throw new Error('Invalid event schema: phase audit guard missing or malformed');
    }
  }
  const activeCount = db.prepare('SELECT count(*) AS count FROM active_event').get()?.count as number;
  const eventsCount = db.prepare('SELECT count(*) AS count FROM events').get()?.count as number;
  if (activeCount > 1) throw new Error('Invalid active event: multiple active event pointers');
  if (eventsCount > 0 && activeCount === 0) {
    throw new Error('Invalid active event: missing pointer while events exist');
  }
  if (activeCount === 1) {
    const eventId = db.prepare('SELECT event_id FROM active_event WHERE slot = 1').get()?.event_id ?? null;
    const exists = db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId);
    if (!exists) throw new Error('Invalid active event: dangling pointer');
  }
}

function readActiveEventId(db: DatabaseSync): string | null {
  const rows = db.prepare('SELECT event_id FROM active_event WHERE slot = 1').all();
  if (rows.length > 1) throw new Error('Invalid active event: multiple active event pointers');
  if (rows.length === 0) {
    const total = db.prepare('SELECT count(*) AS count FROM events').get()?.count as number;
    if (total > 0) throw new Error('Invalid active event: missing pointer while events exist');
    return null;
  }
  return rows[0].event_id as string;
}

function readEventRow(db: DatabaseSync, id: string) {
  const rows = db.prepare(`SELECT id, name, date, place, history, phase, lastTransitionAt, theme, createdAt
    FROM events WHERE id = ?`).all(id);
  if (rows.length !== 1) throw new Error('Invalid active event: dangling pointer');
  const row = rows[0];
  if (!canonicalDate(row.date)) throw new Error('Invalid event metadata: date');
  if (!canonicalTime(row.createdAt)) throw new Error('Invalid event metadata: createdAt');
  if (typeof row.name !== 'string' || row.name.trim() === '') throw new Error('Invalid event metadata: name');
  if (typeof row.place !== 'string' || row.place.trim() === '') throw new Error('Invalid event metadata: place');
  return row;
}

const MAX_META_LENGTH = 120;

function validateEventMeta(meta: { name: unknown; date: unknown; place: unknown }):
    { name: string; date: string; place: string } {
  const rawName = meta?.name;
  const name = typeof rawName === 'string' ? rawName.trim() : null;
  if (name === null || name === '' || name.length > MAX_META_LENGTH) throw new Error('Invalid event name');
  const rawPlace = meta?.place;
  const place = typeof rawPlace === 'string' ? rawPlace.trim() : null;
  if (place === null || place === '' || place.length > MAX_META_LENGTH) throw new Error('Invalid event place');
  if (!canonicalDate(meta?.date)) throw new Error('Invalid event date');
  return { name, date: meta.date, place };
}

type EventSummaryRow = { id: string; name: string; date: string; place: string; phase: GamePhase; createdAt: string };

function toSummary(row: EventSummaryRow, activeId: string | null): EventSummary {
  return Object.freeze({
    id: row.id, name: row.name, date: row.date, place: row.place,
    phase: row.phase, createdAt: row.createdAt, active: activeId !== null && row.id === activeId,
  });
}

function readEventSummaryRows(db: DatabaseSync): EventSummaryRow[] {
  const rows = db.prepare('SELECT id, name, date, place, phase, createdAt FROM events ORDER BY createdAt, id').all();
  return rows.map((row) => {
    if (!canonicalDate(row.date)) throw new Error('Invalid event metadata: date');
    if (!canonicalTime(row.createdAt)) throw new Error('Invalid event metadata: createdAt');
    if (typeof row.name !== 'string' || row.name.trim() === '') throw new Error('Invalid event metadata: name');
    if (typeof row.place !== 'string' || row.place.trim() === '') throw new Error('Invalid event metadata: place');
    return { id: row.id as string, name: row.name as string, date: row.date as string,
      place: row.place as string, phase: row.phase as GamePhase, createdAt: row.createdAt as string };
  });
}

function readTheme(db: DatabaseSync): ThemeId {
  const id = readActiveEventId(db);
  if (id === null) return DEFAULT_THEME;
  const value = readEventRow(db, id).theme;
  if (!isThemeId(value)) throw new Error('Invalid stored theme');
  return value;
}

function replayAudit(db: DatabaseSync, eventId: string): PhaseAuditEntry[] {
  const rows = db.prepare(`SELECT sequence, transitionAt, kind, from_phase, to_phase
    FROM phase_audit WHERE event_id = ? ORDER BY sequence`).all(eventId);
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
  const id = readActiveEventId(db);
  if (id === null) return null;
  const row = readEventRow(db, id);
  const audit = replayAudit(db, id);
  const history = decode(row.history);
  const last = audit.at(-1);
  if (row.phase !== (last?.to_phase ?? 'drawing') ||
      row.lastTransitionAt !== (last?.transitionAt ?? null)) {
    throw new Error('Invalid phase audit: current state does not match history');
  }
  return { calledNumbers: history.calledNumbers, phase: row.phase as GamePhase,
    lastTransitionAt: row.lastTransitionAt as string | null };
}

// Legacy (v3, singleton) reads, used only while validating data before the v3 → v4 migration copy.
function replayLegacyAudit(db: DatabaseSync): PhaseAuditEntry[] {
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

type LegacyEvent = {
  readonly rawHistory: string;
  readonly phase: GamePhase;
  readonly lastTransitionAt: string | null;
  readonly theme: string;
  readonly audit: readonly PhaseAuditEntry[];
};

function readLegacyEvent(db: DatabaseSync): LegacyEvent | null {
  const rows = db.prepare('SELECT id, history, phase, lastTransitionAt, theme FROM current_event').all();
  if (rows.length > 1 || (rows.length === 1 && rows[0].id !== 1)) {
    throw new Error('Invalid event history: unexpected event rows');
  }
  const audit = replayLegacyAudit(db);
  if (rows.length === 0) {
    if (audit.length !== 0) throw new Error('Invalid phase audit: missing current event');
    return null;
  }
  const row = rows[0];
  decode(row.history);
  const last = audit.at(-1);
  if (row.phase !== (last?.to_phase ?? 'drawing') ||
      row.lastTransitionAt !== (last?.transitionAt ?? null)) {
    throw new Error('Invalid phase audit: current state does not match history');
  }
  return { rawHistory: row.history as string, phase: row.phase as GamePhase,
    lastTransitionAt: row.lastTransitionAt as string | null, theme: row.theme as string, audit };
}

// v3 → v4: validate the legacy singleton fully, copy it into one event-scoped row (with
// placeholder metadata) and its audit trail, point active_event at it, then drop the old tables.
function migrateV3ToV4(db: DatabaseSync): void {
  const legacy = readLegacyEvent(db);
  db.exec(legacyEventsTable);
  db.exec(activeEventTable);
  db.exec(auditTableV4Sql('phase_audit_new'));
  if (legacy !== null) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const date = localDateToday();
    db.prepare(`INSERT INTO events (id, name, date, place, history, phase, lastTransitionAt, theme, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, PLACEHOLDER_NAME, date, PLACEHOLDER_PLACE, legacy.rawHistory, legacy.phase,
        legacy.lastTransitionAt, legacy.theme, now);
    for (const entry of legacy.audit) {
      db.prepare(`INSERT INTO phase_audit_new (event_id, sequence, transitionAt, kind, from_phase, to_phase)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, entry.sequence, entry.transitionAt, entry.kind, entry.from_phase, entry.to_phase);
    }
    db.prepare('INSERT INTO active_event (slot, event_id) VALUES (1, ?)').run(id);
  }
  db.exec('DROP TRIGGER phase_audit_no_update');
  db.exec('DROP TRIGGER phase_audit_no_delete');
  db.exec('DROP TABLE phase_audit');
  db.exec('DROP TABLE current_event');
  db.exec('ALTER TABLE phase_audit_new RENAME TO phase_audit');
  db.exec(auditGuards.join(';'));
}

// Theme allow-list migration (v4 → v5), kept self-contained so its schema version can be
// renumbered when merged with other migrations: it reads only the legacy v4 shape and writes the
// current one. Retired ids are rewritten; any other value the new CHECK rejects aborts the
// surrounding transaction, so unknown stored themes still fail closed. SQLite cannot alter a CHECK,
// so events is rebuilt; its children are set aside first so foreign keys stay enforced throughout.
const RETIRED_THEMES: Readonly<Record<string, ThemeId>> = { 'pixel-classic': 'jules' };
function migrateThemeAllowList(db: DatabaseSync): void {
  validateV4(db, legacyEventsTable);
  const rewrite = Object.entries(RETIRED_THEMES).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(' ');
  db.exec('CREATE TEMP TABLE theme_migration_active AS SELECT slot, event_id FROM active_event');
  db.exec(`CREATE TEMP TABLE theme_migration_audit AS
    SELECT event_id, sequence, transitionAt, kind, from_phase, to_phase FROM phase_audit`);
  db.exec('DROP TABLE phase_audit'); // Also drops its immutability guards; recreated below.
  db.exec('DROP TABLE active_event');
  db.exec(eventsTableSql('events_themes', DEFAULT_THEME, themeCheck));
  db.exec(`INSERT INTO events_themes (id, name, date, place, history, phase, lastTransitionAt, theme, createdAt)
    SELECT id, name, date, place, history, phase, lastTransitionAt, CASE theme ${rewrite} ELSE theme END, createdAt
    FROM events ORDER BY rowid`);
  db.exec('DROP TABLE events');
  db.exec('ALTER TABLE events_themes RENAME TO events');
  db.exec(activeEventTable);
  db.exec(auditTableV4);
  db.exec('INSERT INTO active_event (slot, event_id) SELECT slot, event_id FROM theme_migration_active');
  db.exec(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
    SELECT event_id, sequence, transitionAt, kind, from_phase, to_phase FROM theme_migration_audit
    ORDER BY event_id, sequence`);
  db.exec('DROP TABLE theme_migration_active');
  db.exec('DROP TABLE theme_migration_audit');
  db.exec(auditGuards.join(';'));
}

// v5 → v6: add the event_prizes table. Existing events keep no prizes until the operator saves some.
function migratePrizes(db: DatabaseSync): void {
  db.exec(prizesTable);
}

function validatePrizesSchema(db: DatabaseSync): void {
  const normalize = (sql: string) => sql.replace(/[\s"`\[\]]/g, '').toUpperCase();
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'event_prizes'").get()?.sql;
  if (typeof sql !== 'string' || normalize(sql) !== normalize(prizesTable)) {
    throw new Error('Invalid event schema: event_prizes table missing or malformed');
  }
}

// v6 → v7: add the empty line_awards table. Older games, including declared ones, keep no award.
function migrateLineAwards(db: DatabaseSync): void {
  db.exec(lineAwardsTable);
}

function validateLineAwardsSchema(db: DatabaseSync): void {
  const normalize = (sql: string) => sql.replace(/[\s"`\[\]]/g, '').toUpperCase();
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'line_awards'").get()?.sql;
  if (typeof sql !== 'string' || normalize(sql) !== normalize(lineAwardsTable)) {
    throw new Error('Invalid event schema: line_awards table missing or malformed');
  }
}

// Fails closed on values that bypassed the CHECKs, like the theme; startup never reads prizes.
function readPrizes(db: DatabaseSync, eventId: string): EventPrizes {
  const rows = db.prepare(`SELECT lineAmount, lineLot, bingoAmount, bingoLot FROM event_prizes
    WHERE event_id = ?`).all(eventId);
  if (rows.length === 0) return NO_PRIZES;
  const [row] = rows;
  const lot = (value: unknown) => validLot(value) && value === value.trim();
  if (!validAmount(row.lineAmount) || !lot(row.lineLot) || !validAmount(row.bingoAmount) || !lot(row.bingoLot)) {
    throw new Error('Invalid stored prizes');
  }
  return normalizePrizes({ line: { amount: row.lineAmount, lot: row.lineLot },
    bingo: { amount: row.bingoAmount, lot: row.bingoLot } }) as EventPrizes;
}

export type StoredLineAward = {
  readonly eventId: string;
  readonly award: LineAward;
  readonly presentation: {
    readonly id: string;
    readonly status: LinePresentationStatus;
    readonly startedAt: number | null;
    readonly deadlineAt: number | null;
  };
};

const PRESENTATION_STATUSES: readonly string[] = ['pending', 'failed', 'started', 'completed'];
const LOT_RESOLUTIONS: readonly string[] = ['not_required', 'pending', 'resolved'];

// Reads the active event's award, or null only when no row exists. A populated row is re-derived with the
// pure rules and linked to its direct audit intent; anything else fails closed. Never repairs or writes.
function readLineAward(db: DatabaseSync, eventId: string, audit: PhaseAuditEntry[]): StoredLineAward | null {
  const invalid = (reason: string, cause?: unknown): never => {
    throw new Error(`Invalid stored line award: ${reason}`, cause === undefined ? undefined : { cause });
  };
  let row;
  try {
    row = db.prepare(`SELECT event_id, audit_sequence, winner_count, total_cents, share_cents, remainder_cents,
      lot, lot_resolution, presentation_id, presentation_status, presentation_started_at, presentation_deadline
      FROM line_awards WHERE event_id = ?`).get(eventId);
  } catch (error) { return invalid('unreadable row', error); }
  if (row === undefined) return null;
  const safe = (value: unknown, low: number): value is number =>
    Number.isSafeInteger(value) && (value as number) >= low;
  if (row.event_id !== eventId) invalid('event');
  const link = safe(row.audit_sequence, 1) ? audit[row.audit_sequence - 1] : undefined;
  if (link?.kind !== 'declare_line_directly' || link.from_phase !== 'drawing' || link.to_phase !== 'line_declared') {
    invalid('audit link');
  }
  if (!safe(row.winner_count, 1) || !safe(row.total_cents, 0) || row.total_cents > 10_000_000 ||
      row.total_cents % 100 !== 0 || typeof row.lot !== 'string' || row.lot !== row.lot.trim()) {
    invalid('amounts');
  }
  let derived: LineAward;
  try {
    derived = createLineAward({ winnerCount: row.winner_count as number,
      prizeEuros: (row.total_cents as number) / 100, lot: row.lot as string });
  } catch (error) { return invalid('award rules', error); }
  const resolution = row.lot_resolution;
  if (row.share_cents !== derived.shareCents || row.remainder_cents !== derived.remainderCents ||
      typeof resolution !== 'string' || !LOT_RESOLUTIONS.includes(resolution) ||
      (resolution !== derived.lotResolution && !(derived.lotResolution === 'pending' && resolution === 'resolved'))) {
    invalid('share, remainder or lot');
  }
  const status = row.presentation_status;
  const startedAt = row.presentation_started_at;
  const deadlineAt = row.presentation_deadline;
  if (typeof row.presentation_id !== 'string' || row.presentation_id.trim() === '' ||
      typeof status !== 'string' || !PRESENTATION_STATUSES.includes(status)) {
    invalid('presentation');
  }
  const timed = status === 'started' || status === 'completed';
  if (timed ? !(safe(startedAt, 0) && safe(deadlineAt, 0) && deadlineAt > startedAt)
    : startedAt !== null || deadlineAt !== null) {
    invalid('presentation times');
  }
  return Object.freeze({
    eventId,
    award: Object.freeze({ ...derived, lotResolution: resolution as LineAward['lotResolution'] }),
    presentation: Object.freeze({ id: row.presentation_id as string, status: status as LinePresentationStatus,
      startedAt: startedAt as number | null, deadlineAt: deadlineAt as number | null }),
  });
}

export type LineDeclarationBaseline = {
  readonly eventId: string;
  readonly calledNumbers: readonly number[];
  readonly phase: 'drawing';
  readonly lastTransitionAt: string | null;
  readonly auditSequence: number;
  readonly linePrize: { readonly amount: number; readonly lot: string };
};

// The store-authoritative core of a future direct first-line declaration, read from one consistent snapshot. Only
// a drawing event without an award qualifies. A legacy declaration later corrected back to drawing left no durable
// award, so it stays eligible; any prior direct declaration audit, even corrected, refuses.
function readLineDeclarationBaseline(db: DatabaseSync): LineDeclarationBaseline {
  const id = readActiveEventId(db);
  const event = id === null ? null : readEvent(db);
  if (id === null || event === null) throw new Error('Line declaration not eligible: no current event');
  const audit = replayAudit(db, id);
  if (event.phase !== 'drawing' || readLineAward(db, id, audit) !== null ||
      audit.some((entry) => entry.kind === 'declare_line_directly')) {
    throw new Error('Line declaration not eligible: the line is already declared');
  }
  const { line } = readPrizes(db, id);
  return Object.freeze({
    eventId: id, calledNumbers: Object.freeze([...event.calledNumbers]), phase: 'drawing' as const,
    lastTransitionAt: event.lastTransitionAt, auditSequence: audit.length,
    linePrize: Object.freeze({ amount: line.amount, lot: line.lot }),
  });
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
          candidate.exec(eventsTable);
          candidate.exec(activeEventTable);
          candidate.exec(auditTableV4);
          candidate.exec(auditGuards.join(';'));
          candidate.exec(prizesTable);
          candidate.exec(lineAwardsTable);
          candidate.exec(`PRAGMA user_version = ${VERSION}; COMMIT`);
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
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 0');
    // A deferred read transaction pins version, schema, and state to one snapshot
    // without claiming the writer lock held by an independent connection.
    db.exec('BEGIN');
    try {
      const observed = db.prepare('PRAGMA user_version').get()?.user_version;
      if (observed !== 1 && observed !== 2 && observed !== 3 && observed !== 4 && observed !== 5 && observed !== 6 && observed !== VERSION) {
        throw new Error(`Unsupported event schema version: ${String(observed)}`);
      }
      if (observed === VERSION) {
        validateV4(db);
        validatePrizesSchema(db);
        validateLineAwardsSchema(db);
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
          validateV3(db);
          migrateV3ToV4(db);
          db.exec('PRAGMA user_version = 4');
        } else if (version === 2) {
          validateV2(db);
          extendV3Schema(db);
          validateV3(db);
          migrateV3ToV4(db);
          db.exec('PRAGMA user_version = 4');
        } else if (version === 3) {
          validateV3(db);
          migrateV3ToV4(db);
          db.exec('PRAGMA user_version = 4');
        } else if (version !== 4 && version !== 5 && version !== 6 && version !== VERSION) {
          throw new Error(`Unsupported event schema version: ${String(version)}`);
        }
        if (version === 1 || version === 2 || version === 3 || version === 4) {
          migrateThemeAllowList(db);
          db.exec('PRAGMA user_version = 5');
        }
        if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5) {
          migratePrizes(db);
          db.exec('PRAGMA user_version = 6');
        }
        if (version !== VERSION) {
          migrateLineAwards(db);
          db.exec(`PRAGMA user_version = ${VERSION}`);
        }
        validateV4(db);
        validatePrizesSchema(db);
        validateLineAwardsSchema(db);
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
        const id = readActiveEventId(db);
        if (id === null) throw new Error('Current event does not exist');
        db.prepare('UPDATE events SET theme = ? WHERE id = ?').run(theme, id);
        return readTheme(db);
      });
    },
    readAudit(): PhaseAuditEntry[] {
      return readSnapshot(() => {
        const id = readActiveEventId(db);
        readEvent(db);
        return id === null ? [] : replayAudit(db, id);
      });
    },
    transitionPhase(intent: PhaseTransitionIntent, transitionAt: string): StoredEvent {
      return transaction(() => {
        const id = readActiveEventId(db);
        if (id === null) throw new Error('Current event does not exist');
        const current = readEvent(db);
        if (current === null) throw new Error('Current event does not exist');
        const phase = transitionPhase(current, intent).phase;
        if (!canonicalTime(transitionAt) ||
            (current.lastTransitionAt !== null && transitionAt <= current.lastTransitionAt)) {
          throw new Error('Invalid phase transition timestamp');
        }
        const sequence = replayAudit(db, id).length + 1;
        db.prepare('UPDATE events SET phase = ?, lastTransitionAt = ? WHERE id = ?')
          .run(phase, transitionAt, id);
        db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
          VALUES (?, ?, ?, ?, ?, ?)`).run(id, sequence, transitionAt, intent, current.phase, phase);
        return { ...current, phase, lastTransitionAt: transitionAt };
      });
    },
    create(): StoredEvent {
      return transaction(() => {
        if (readEvent(db) !== null) throw new Error('Current event already exists');
        const id = randomUUID();
        const now = new Date().toISOString();
        const date = localDateToday();
        db.prepare(`INSERT INTO events (id, name, date, place, history, createdAt)
          VALUES (?, ?, ?, ?, '[]', ?)`).run(id, PLACEHOLDER_NAME, date, PLACEHOLDER_PLACE, now);
        db.prepare('INSERT INTO active_event (slot, event_id) VALUES (1, ?)').run(id);
        return { calledNumbers: [], phase: 'drawing', lastTransitionAt: null };
      });
    },
    update(transition: (current: StoredEvent) => EventSnapshot): StoredEvent {
      return transaction(() => {
        const id = readActiveEventId(db);
        const current = readEvent(db);
        if (current === null || id === null) throw new Error('Current event does not exist');
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
        db.prepare('UPDATE events SET history = ? WHERE id = ?').run(JSON.stringify(next.calledNumbers), id);
        return { calledNumbers: next.calledNumbers, phase, lastTransitionAt };
      });
    },
    listEvents(): EventSummary[] {
      return readSnapshot(() => {
        const activeId = readActiveEventId(db);
        return readEventSummaryRows(db).map((row) => toSummary(row, activeId));
      });
    },
    createEvent(meta: { name: unknown; date: unknown; place: unknown }): EventSummary {
      const { name, date, place } = validateEventMeta(meta);
      return transaction(() => {
        const activeId = readActiveEventId(db);
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO events (id, name, date, place, history, createdAt)
          VALUES (?, ?, ?, ?, '[]', ?)`).run(id, name, date, place, now);
        const resultingActiveId = activeId === null ? id : activeId;
        if (activeId === null) {
          db.prepare('INSERT INTO active_event (slot, event_id) VALUES (1, ?)').run(id);
        }
        return toSummary({ id, name, date, place, phase: 'drawing', createdAt: now }, resultingActiveId);
      });
    },
    selectEvent(id: unknown): EventSummary {
      if (typeof id !== 'string') throw new Error('Invalid event id');
      return transaction(() => {
        const rows = db.prepare('SELECT id, name, date, place, phase, createdAt FROM events WHERE id = ?').all(id);
        if (rows.length !== 1) throw new Error('Unknown event id');
        if (!canonicalDate(rows[0].date)) throw new Error('Invalid event metadata: date');
        if (!canonicalTime(rows[0].createdAt)) throw new Error('Invalid event metadata: createdAt');
        if (typeof rows[0].name !== 'string' || rows[0].name.trim() === '') throw new Error('Invalid event metadata: name');
        if (typeof rows[0].place !== 'string' || rows[0].place.trim() === '') throw new Error('Invalid event metadata: place');
        const row = rows[0] as EventSummaryRow;
        const currentActive = readActiveEventId(db);
        if (currentActive !== id) {
          db.prepare('UPDATE active_event SET event_id = ? WHERE slot = 1').run(id);
          // Validate the complete target state before commit: a corrupt event must never become active,
          // or every later load and the next startup would fail. Throwing here rolls the selection back.
          readEvent(db);
          readTheme(db);
          readPrizes(db, id);
        }
        return toSummary(row, id);
      });
    },
    // The active event's prizes with its id, so a reader can tell which event they belong to.
    loadPrizes(): { eventId: string; prizes: EventPrizes } | null {
      return readSnapshot(() => {
        const id = readActiveEventId(db);
        return id === null ? null : { eventId: id, prizes: readPrizes(db, id) };
      });
    },
    // The active event's validated first-line award, or null when it has none (including legacy declared games).
    loadLineAward(): StoredLineAward | null {
      return readSnapshot(() => {
        const id = readActiveEventId(db);
        if (id === null) return null;
        readEvent(db);
        return readLineAward(db, id, replayAudit(db, id));
      });
    },
    // Frozen store-authoritative baseline the operator confirms before declaring the first line.
    loadLineDeclarationBaseline(): LineDeclarationBaseline {
      return readSnapshot(() => readLineDeclarationBaseline(db));
    },
    // Replaces only the active event's prizes; like updateEventMeta, a stale id never reaches another event.
    // Returns the values read back inside the committing transaction.
    updateEventPrizes(id: unknown, prizes: unknown): EventPrizes {
      if (typeof id !== 'string') throw new Error('Invalid event id');
      const next = normalizePrizes(prizes);
      if (next === null) throw new Error('Invalid event prizes');
      return transaction(() => {
        if (readActiveEventId(db) !== id) throw new Error('Event is not the active event');
        db.prepare(`INSERT INTO event_prizes (event_id, lineAmount, lineLot, bingoAmount, bingoLot)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET lineAmount = excluded.lineAmount,
          lineLot = excluded.lineLot, bingoAmount = excluded.bingoAmount, bingoLot = excluded.bingoLot`)
          .run(id, next.line.amount, next.line.lot, next.bingo.amount, next.bingo.lot);
        return readPrizes(db, id);
      });
    },
    // Edits only the active event's descriptive metadata, with createEvent's rules; history, phase,
    // audit, and theme are untouched. Requiring the active id stops a stale draft reaching another event.
    updateEventMeta(id: unknown, meta: { name: unknown; date: unknown; place: unknown }): EventSummary {
      if (typeof id !== 'string') throw new Error('Invalid event id');
      const { name, date, place } = validateEventMeta(meta);
      return transaction(() => {
        const activeId = readActiveEventId(db);
        if (activeId !== id) throw new Error('Event is not the active event');
        db.prepare('UPDATE events SET name = ?, date = ?, place = ? WHERE id = ?').run(name, date, place, id);
        // Return the values read back inside the committing transaction.
        const row = readEventRow(db, id);
        return toSummary({ id: row.id as string, name: row.name as string, date: row.date as string,
          place: row.place as string, phase: row.phase as GamePhase, createdAt: row.createdAt as string }, activeId);
      });
    },
    close(): void { db.close(); },
  };
}
