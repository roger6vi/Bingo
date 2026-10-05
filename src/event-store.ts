import { closeSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventSnapshot } from './event-core';
import { transitionPhase, type GamePhase, type PhaseTransitionIntent } from './game-phase.ts';
import { DEFAULT_THEME, isThemeId, THEME_IDS, type ThemeId } from './theme.ts';
import { createLineAward, isLineDeliveryResolved, transitionLinePresentation, type LineAward,
  type LinePresentationIntent, type LinePresentationStatus } from './line-award.ts';
import { parseLineLotResolution } from './line-lot-contract.ts';
import { MAX_PRIZE_AMOUNT, MAX_PRIZE_LOT, NO_PRIZES, normalizePrizes, validAmount, validLot,
  type EventPrizes } from './event-prizes.ts';

// v6 adds prizes, v7 adds first-line awards, v8 adds interrupted presentations and v9 adds
// numbered lot provenance. Keep each historical definition and migration step independent.
const VERSION = 9;
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
const LINE_PRESENTATION_MS = 4000;
const integerRange = (name: string, low: number, high: number) =>
  `typeof(${name}) = 'integer' AND ${name} BETWEEN ${low} AND ${high}`;
const integerColumn = (name: string, low: number, high: number) => `CHECK (${integerRange(name, low, high)})`;
// Optional first-line award, at most one per event, written later together with its audit row. Shares
// use integer division so the arithmetic cannot overflow for any safe winner count; the remainder is
// never assigned. Only a nonempty lot shared by 2+ winners needs a tie; presentation times are epoch ms.
const lineAwardsTableSql = (statuses: readonly string[]) => `CREATE TABLE line_awards (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES events(id),
  audit_sequence INTEGER NOT NULL ${integerColumn('audit_sequence', 1, MAX_SAFE_INTEGER)},
  winner_count INTEGER NOT NULL ${integerColumn('winner_count', 1, MAX_SAFE_INTEGER)},
  total_cents INTEGER NOT NULL ${integerColumn('total_cents', 0, MAX_AWARD_CENTS)},
  share_cents INTEGER NOT NULL ${integerColumn('share_cents', 0, MAX_AWARD_CENTS)},
  remainder_cents INTEGER NOT NULL ${integerColumn('remainder_cents', 0, MAX_AWARD_CENTS)},
  lot TEXT NOT NULL CHECK (typeof(lot) = 'text' AND lot = trim(lot) AND length(lot) <= 120),
  lot_resolution TEXT NOT NULL CHECK (lot_resolution IN ('not_required', 'pending', 'resolved')),
  presentation_id TEXT NOT NULL UNIQUE CHECK (typeof(presentation_id) = 'text' AND length(trim(presentation_id)) > 0),
  presentation_status TEXT NOT NULL CHECK (presentation_status IN (${statuses.map((status) => `'${status}'`).join(', ')})),
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
const lineAwardsTableV7 = lineAwardsTableSql(['pending', 'failed', 'started', 'completed']);
const lineAwardsTableV8 = lineAwardsTableSql(['pending', 'failed', 'started', 'completed', 'interrupted']);
const originalAwardColumns = ['event_id', 'audit_sequence', 'winner_count', 'total_cents', 'share_cents',
  'remainder_cents', 'lot', 'lot_resolution', 'presentation_id', 'presentation_status',
  'presentation_started_at', 'presentation_deadline'];
// Durable palette v1: never derive persisted results from a future presentation palette.
const lotPaletteV1 = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'] as const;
const lotColorV1Sql = `CASE (lot_participant_number - 1) % 6 ${lotPaletteV1
  .map((color, index) => `WHEN ${index} THEN '${color}'`).join(' ')} END`;
const lineAwardsTable = lineAwardsTableV8.replace('  CHECK (share_cents', `  lot_result_origin TEXT NOT NULL DEFAULT 'none'
    CHECK (lot_result_origin IN ('none', 'legacy_v8', 'numbered_v1')),
  lot_participant_number INTEGER,
  lot_color_id TEXT,
  CHECK (CASE
    WHEN lot_resolution IN ('pending', 'not_required') THEN lot_result_origin = 'none'
      AND lot_participant_number IS NULL AND lot_color_id IS NULL
    WHEN lot_resolution = 'resolved' AND lot_result_origin = 'legacy_v8'
      THEN lot_participant_number IS NULL AND lot_color_id IS NULL
    WHEN lot_resolution = 'resolved' AND lot_result_origin = 'numbered_v1'
      THEN lot <> '' AND winner_count >= 2 AND presentation_status = 'completed'
        AND lot_participant_number IS NOT NULL AND lot_color_id IS NOT NULL
        AND ${integerRange('lot_participant_number', 1, MAX_SAFE_INTEGER)}
        AND lot_participant_number <= winner_count AND typeof(lot_color_id) = 'text'
        AND lot_color_id = ${lotColorV1Sql}
    ELSE 0 END),
  CHECK (share_cents`);
// Migration is the sole creator of legacy provenance. Existing legacy awards may still advance
// their presentation lifecycle, but their award identity and unknown-winner provenance are frozen.
const legacyIdentityColumns = originalAwardColumns.filter((name) => ![
  'presentation_id', 'presentation_status', 'presentation_started_at', 'presentation_deadline',
].includes(name)).concat(['lot_result_origin', 'lot_participant_number', 'lot_color_id']);
const lineAwardGuards = [
  `CREATE TRIGGER line_awards_no_legacy_insert BEFORE INSERT ON line_awards
    WHEN NEW.lot_result_origin = 'legacy_v8'
    BEGIN SELECT RAISE(ABORT, 'cannot insert legacy lot provenance'); END`,
  `CREATE TRIGGER line_awards_no_legacy_update BEFORE UPDATE ON line_awards
    WHEN (NEW.lot_result_origin = 'legacy_v8' AND OLD.lot_result_origin IS NOT 'legacy_v8')
      OR (OLD.lot_result_origin = 'legacy_v8' AND (${legacyIdentityColumns
        .map((name) => `NEW.${name} IS NOT OLD.${name}`).join(' OR ')}))
    BEGIN SELECT RAISE(ABORT, 'cannot introduce or retarget legacy lot provenance'); END`,
];
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
  db.exec(lineAwardsTableV7);
}

// v7 → v8: rebuild line_awards so presentation_status also allows `interrupted`. Nothing references the table, so
// it is copied aside, recreated and refilled in the caller's transaction; the refill re-checks every constraint
// and foreign key, so any malformed row aborts (and rolls back) the migration instead of being repaired.
function migrateInterruptedPresentation(db: DatabaseSync): void {
  db.exec('CREATE TEMP TABLE line_awards_migration AS SELECT * FROM line_awards');
  db.exec('DROP TABLE line_awards');
  db.exec(lineAwardsTableV8);
  db.exec('INSERT INTO line_awards SELECT * FROM line_awards_migration');
  db.exec('DROP TABLE line_awards_migration');
}

// v8 → v9: preserve every old field, label only old resolved rows and invent no winner.
// Install guards after the copy; all DDL, data and user_version are in the caller's transaction.
function migrateLotProvenance(db: DatabaseSync): void {
  db.exec('CREATE TEMP TABLE line_awards_migration AS SELECT * FROM line_awards');
  db.exec('DROP TABLE line_awards');
  db.exec(lineAwardsTable);
  db.exec(`INSERT INTO line_awards (${originalAwardColumns.join(', ')}, lot_result_origin)
    SELECT ${originalAwardColumns.join(', ')}, CASE WHEN lot_resolution = 'resolved'
      THEN 'legacy_v8' ELSE 'none' END FROM line_awards_migration`);
  db.exec('DROP TABLE line_awards_migration');
  db.exec(lineAwardGuards.join(';'));
}

function validateLineAwardsSchema(db: DatabaseSync, expected = lineAwardsTable): void {
  const normalize = (sql: string) => sql.replace(/[\s"`\[\]]/g, '').toUpperCase();
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'line_awards'").get()?.sql;
  if (typeof sql !== 'string' || normalize(sql) !== normalize(expected)) {
    throw new Error('Invalid event schema: line_awards table missing or malformed');
  }
  if (expected === lineAwardsTable) {
    for (const guard of lineAwardGuards) {
      const name = guard.split(' ')[2];
      const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ? AND type = 'trigger'").get(name)?.sql;
      if (typeof stored !== 'string' || normalize(stored) !== normalize(guard)) {
        throw new Error('Invalid event schema: line_awards provenance guard missing or malformed');
      }
    }
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

export type LineLotFact =
  | Readonly<{ origin: 'none'; resolution: 'not_required' | 'pending' }>
  | Readonly<{ origin: 'legacy_v8'; resolution: 'resolved'; winner: 'unknown' }>
  | Readonly<{ origin: 'numbered_v1'; resolution: 'resolved'; paletteVersion: 1;
    participantNumber: number; colorId: string }>;

// Identity a later guarded writer must match, plus the decoded lot facts, from one active-event snapshot.
export type LineLotSnapshot = Readonly<{
  eventId: string; auditSequence: number; winnerCount: number; lot: string;
  presentation: Readonly<{ id: string; status: LinePresentationStatus }>; fact: LineLotFact;
}>;

const PRESENTATION_STATUSES: readonly string[] = ['pending', 'failed', 'started', 'completed', 'interrupted'];
const LOT_RESOLUTIONS: readonly string[] = ['not_required', 'pending', 'resolved'];

// Reads the active event's award, or null only when no row exists. A populated row is re-derived with the
// pure rules and linked to its direct audit intent; anything else fails closed. Never repairs or writes.
function readLineAward(db: DatabaseSync, eventId: string, audit: PhaseAuditEntry[]): StoredLineAward | null {
  return readLineAwardRecord(db, eventId, audit)?.stored ?? null;
}

// Strict provenance decode: every origin/column combination is explicit, so a legacy winner is never inferred
// from missing data and a numbered result always passes the shared pure parser.
function decodeLotFact(row: Record<string, unknown>, winnerCount: number, lot: string, resolution: string,
    status: string, invalid: (reason: string, cause?: unknown) => never): LineLotFact {
  const origin = row.lot_result_origin;
  const number = row.lot_participant_number;
  const color = row.lot_color_id;
  if (origin === 'none') {
    if (resolution === 'resolved' || number !== null || color !== null) invalid('lot result origin');
    const parsed = parseLineLotResolution(winnerCount, resolution, null);
    return Object.freeze({ origin, resolution: parsed.resolution as 'not_required' | 'pending' });
  }
  if (origin === 'legacy_v8') {
    if (resolution !== 'resolved' || number !== null || color !== null) invalid('legacy lot result');
    return Object.freeze({ origin, resolution: 'resolved' as const, winner: 'unknown' as const });
  }
  if (origin !== 'numbered_v1' || resolution !== 'resolved' || lot === '' || winnerCount < 2 ||
      status !== 'completed') {
    return invalid('lot result origin');
  }
  try {
    const parsed = parseLineLotResolution(winnerCount, 'resolved', { participantNumber: number, colorId: color });
    if (parsed.resolution !== 'resolved') return invalid('lot result');
    return Object.freeze({ origin, resolution: 'resolved' as const, paletteVersion: 1 as const,
      participantNumber: parsed.result.participantNumber, colorId: parsed.result.colorId });
  } catch (error) { return invalid('lot result', error); }
}

type LineAwardRecord = NonNullable<ReturnType<typeof readLineAwardRecord>>;
function lotSnapshot(eventId: string, record: LineAwardRecord): LineLotSnapshot {
  const { award, presentation } = record.stored;
  return Object.freeze({ eventId, auditSequence: record.auditSequence, winnerCount: award.winnerCount,
    lot: award.lot, presentation: Object.freeze({ id: presentation.id, status: presentation.status }),
    fact: record.fact });
}

// Untrusted writer input (future IPC JSON): a plain object with exactly these own data properties, copied once so
// getters, prototypes or later mutation can never alter the intent.
function exactPlain(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const proto = typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const own = Object.getOwnPropertyDescriptors(value as object);
  if (Object.keys(own).sort().join() !== [...keys].sort().join() || Reflect.ownKeys(own).length !== keys.length ||
      Object.values(own).some((d) => !('value' in d) || !d.enumerable)) throw new Error(`Invalid ${name}`);
  return Object.fromEntries(keys.map((key) => [key, own[key].value]));
}

function readLineAwardRecord(db: DatabaseSync, eventId: string, audit: PhaseAuditEntry[]):
    { stored: StoredLineAward; auditSequence: number; fact: LineLotFact } | null {
  const invalid = (reason: string, cause?: unknown): never => {
    throw new Error(`Invalid stored line award: ${reason}`, cause === undefined ? undefined : { cause });
  };
  let row;
  try {
    row = db.prepare(`SELECT event_id, audit_sequence, winner_count, total_cents, share_cents, remainder_cents,
      lot, lot_resolution, presentation_id, presentation_status, presentation_started_at, presentation_deadline,
      lot_result_origin, lot_participant_number, lot_color_id
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
  const timed = status !== 'pending' && status !== 'failed';
  if (timed ? !(safe(startedAt, 0) && safe(deadlineAt, 0) && deadlineAt > startedAt)
    : startedAt !== null || deadlineAt !== null) {
    invalid('presentation times');
  }
  const fact = decodeLotFact(row, row.winner_count as number, row.lot as string, resolution as string, status as string, invalid);
  const stored = Object.freeze({
    eventId,
    award: Object.freeze({ ...derived, lotResolution: resolution as LineAward['lotResolution'] }),
    presentation: Object.freeze({ id: row.presentation_id as string, status: status as LinePresentationStatus,
      startedAt: startedAt as number | null, deadlineAt: deadlineAt as number | null }),
  });
  return { stored, auditSequence: row.audit_sequence as number, fact };
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

// Untrusted input (the future IPC reads JSON): exact shape and types only, never coerced.
function parseBaseline(value: unknown): LineDeclarationBaseline {
  const invalid = () => new Error('Invalid line declaration baseline');
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
  if (!plain(value) || !exact(value, ['eventId', 'calledNumbers', 'phase', 'lastTransitionAt', 'auditSequence', 'linePrize'])) {
    throw invalid();
  }
  const prize = value.linePrize;
  if (typeof value.eventId !== 'string' || !Array.isArray(value.calledNumbers) || value.phase !== 'drawing' ||
      !(value.lastTransitionAt === null || canonicalTime(value.lastTransitionAt)) ||
      !Number.isSafeInteger(value.auditSequence) || (value.auditSequence as number) < 0 ||
      !plain(prize) || !exact(prize, ['amount', 'lot']) || typeof prize.lot !== 'string' || !validAmount(prize.amount)) {
    throw invalid();
  }
  // Dense, ordered, valid and unique balls (the history decode rules); a hole or junk value never passes. The result
  // is a private copy, so the caller cannot change the input between this check and the comparison.
  const called: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < value.calledNumbers.length; index += 1) {
    const ball: unknown = Object.hasOwn(value.calledNumbers, index) ? value.calledNumbers[index] : undefined;
    if (typeof ball !== 'number' || !Number.isInteger(ball) || ball < 1 || ball > 90 || seen.has(ball)) throw invalid();
    seen.add(ball);
    called.push(ball);
  }
  return { eventId: value.eventId, calledNumbers: called, phase: 'drawing', lastTransitionAt: value.lastTransitionAt,
    auditSequence: value.auditSequence as number, linePrize: { amount: prize.amount, lot: prize.lot } };
}

function sameBaseline(a: LineDeclarationBaseline, b: LineDeclarationBaseline): boolean {
  return a.eventId === b.eventId && a.phase === b.phase && a.lastTransitionAt === b.lastTransitionAt &&
    a.auditSequence === b.auditSequence && a.linePrize.amount === b.linePrize.amount &&
    a.linePrize.lot === b.linePrize.lot && a.calledNumbers.length === b.calledNumbers.length &&
    b.calledNumbers.every((number, index) => a.calledNumbers[index] === number);
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
          candidate.exec(lineAwardGuards.join(';'));
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
      if (observed !== 1 && observed !== 2 && observed !== 3 && observed !== 4 && observed !== 5 && observed !== 6 && observed !== 7 && observed !== 8 && observed !== VERSION) {
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
        } else if (version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== VERSION) {
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
        if (version !== 7 && version !== 8 && version !== VERSION) {
          migrateLineAwards(db);
          db.exec('PRAGMA user_version = 7');
        }
        if (version !== 8 && version !== VERSION) {
          validateLineAwardsSchema(db, lineAwardsTableV7);
          migrateInterruptedPresentation(db);
          db.exec('PRAGMA user_version = 8');
        }
        if (version !== VERSION) {
          validateLineAwardsSchema(db, lineAwardsTableV8);
          migrateLotProvenance(db);
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

  // One explicit presentation step on the active event's award. Everything is checked under the writer lock: the id
  // must be the current one and the pure graph must allow the step. The compare-and-set names the id and source
  // status, must change exactly one row, and the readback must equal the intended state before COMMIT.
  function stepPresentation(id: unknown, intent: LinePresentationIntent,
      plan: (current: StoredLineAward['presentation']) => { startedAt: number | null; deadlineAt: number | null }) {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid line presentation id');
    return transaction(() => {
      const eventId = readActiveEventId(db);
      if (eventId === null) throw new Error('Current event does not exist');
      readEvent(db);
      const current = readLineAward(db, eventId, replayAudit(db, eventId));
      if (current === null || current.presentation.id !== id) throw new Error('Line presentation is not the current one');
      const status = transitionLinePresentation({ status: current.presentation.status }, intent).status;
      const times = plan(current.presentation);
      const nextId = intent === 'retry' || intent === 'replay' ? randomUUID() : id;
      const result = db.prepare(`UPDATE line_awards SET presentation_id = ?, presentation_status = ?,
        presentation_started_at = ?, presentation_deadline = ?
        WHERE event_id = ? AND presentation_id = ? AND presentation_status = ?`)
        .run(nextId, status, times.startedAt, times.deadlineAt, eventId, id, current.presentation.status);
      if (result.changes !== 1) throw new Error('Line presentation changed concurrently');
      readEvent(db);
      const stored = readLineAward(db, eventId, replayAudit(db, eventId));
      const p = stored?.presentation;
      if (p === undefined || p.id !== nextId || p.status !== status || p.startedAt !== times.startedAt ||
          p.deadlineAt !== times.deadlineAt) {
        throw new Error('Invalid stored line award: presentation mismatch after write');
      }
      return stored as StoredLineAward;
    });
  }
  const noTimes = () => ({ startedAt: null, deadlineAt: null });

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
      // Direct declarations need the atomic award path; old ones still replay from the audit.
      if (intent === 'declare_line_directly') {
        throw new Error('Direct line declaration requires the atomic award path');
      }
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
        const audit = replayAudit(db, id);
        const award = intent === 'begin_bingo_check' || intent === 'correct_line_declaration'
          ? readLineAward(db, id, audit) : null;
        if (award !== null && intent === 'correct_line_declaration') {
          throw new Error('Line correction with an attached award is not supported');
        }
        if (award !== null && !isLineDeliveryResolved(award.award, { status: award.presentation.status })) {
          throw new Error('Line delivery must be completed and its lot settled before the bingo check');
        }
        const sequence = audit.length + 1;
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
        // Authoritative draw lock: an award blocks draws until its presentation completes (a pending lot does not).
        const award = readLineAward(db, id, replayAudit(db, id));
        if (award !== null && award.presentation.status !== 'completed') {
          throw new Error('Draw not allowed until the line presentation is completed');
        }
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
          readLineAward(db, id, replayAudit(db, id));
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
    // Active-event lot facts only; null without an award. Corrupt or unknown provenance fails this read alone.
    loadLineLotResult(): LineLotSnapshot | null {
      return readSnapshot(() => {
        const id = readActiveEventId(db);
        if (id === null) return null;
        readEvent(db);
        const record = readLineAwardRecord(db, id, replayAudit(db, id));
        if (record === null) return null;
        return lotSnapshot(id, record);
      });
    },
    // Commits the one manual lot result. The expected identity and the result are untrusted and copied first. Under
    // the writer lock the active event, audit link and current completed presentation are re-read; only a pending,
    // never-resolved tied lot qualifies. The compare-and-set touches the four result columns of exactly one row, and
    // the strict reread must equal the intent before COMMIT, so a mismatch rolls back and nothing speculative returns.
    resolveLineLot(expected: unknown, result: unknown): LineLotSnapshot {
      const want = exactPlain(expected, ['eventId', 'auditSequence', 'presentationId'], 'lot identity');
      const pickRaw = exactPlain(result, ['participantNumber', 'colorId'], 'lot result');
      if (typeof want.eventId !== 'string' || want.eventId === '' || typeof want.presentationId !== 'string' ||
          want.presentationId.trim() === '' || !Number.isSafeInteger(want.auditSequence) || (want.auditSequence as number) < 1) {
        throw new Error('Invalid lot identity');
      }
      parseLineLotResolution(MAX_SAFE_INTEGER, 'resolved', pickRaw);
      const { eventId, auditSequence, presentationId } = want as { eventId: string; auditSequence: number; presentationId: string };
      const { participantNumber, colorId } = pickRaw as { participantNumber: number; colorId: string };
      return transaction(() => {
        if (readActiveEventId(db) !== eventId) throw new Error('Line lot event is not the active event');
        readEvent(db);
        const current = readLineAwardRecord(db, eventId, replayAudit(db, eventId));
        if (current === null || current.auditSequence !== auditSequence || current.stored.presentation.id !== presentationId ||
            current.stored.presentation.status !== 'completed') throw new Error('Line lot identity is stale');
        if (current.stored.award.lot === '' || current.stored.award.winnerCount < 2 || current.fact.origin !== 'none' ||
            current.fact.resolution !== 'pending') throw new Error('Line lot is not pending');
        parseLineLotResolution(current.stored.award.winnerCount, 'resolved', pickRaw);
        const update = db.prepare(`UPDATE line_awards SET lot_resolution = 'resolved', lot_result_origin = 'numbered_v1',
          lot_participant_number = ?, lot_color_id = ? WHERE event_id = ? AND audit_sequence = ? AND presentation_id = ?
          AND presentation_status = 'completed' AND lot_resolution = 'pending' AND lot_result_origin = 'none'`)
          .run(participantNumber, colorId, eventId, auditSequence, presentationId);
        if (update.changes !== 1) throw new Error('Line lot changed concurrently');
        readEvent(db);
        const committed = readLineAwardRecord(db, eventId, replayAudit(db, eventId));
        const fact = committed?.fact;
        if (committed === null || fact?.origin !== 'numbered_v1' || fact.participantNumber !== participantNumber ||
            fact.colorId !== colorId || committed.auditSequence !== auditSequence ||
            committed.stored.presentation.id !== presentationId ||
            JSON.stringify({ ...committed.stored.award, lotResolution: 0 }) !==
              JSON.stringify({ ...current.stored.award, lotResolution: 0 }) ||
            JSON.stringify(committed.stored.presentation) !== JSON.stringify(current.stored.presentation)) {
          throw new Error('Invalid stored line award: lot mismatch after write');
        }
        return lotSnapshot(eventId, committed);
      });
    },
    // Frozen store-authoritative baseline the operator confirms before declaring the first line.
    loadLineDeclarationBaseline(): LineDeclarationBaseline {
      return readSnapshot(() => readLineDeclarationBaseline(db));
    },
    // Declares the first line atomically: phase, direct audit row and the frozen award commit together or not at
    // all. Rechecks the baseline under the writer lock; a stale or repeated declaration is refused, never replayed.
    declareLineDirectly(expected: unknown, winnerCount: unknown, transitionAt: unknown): StoredLineAward {
      const baseline = parseBaseline(expected);
      if (typeof winnerCount !== 'number' || !Number.isSafeInteger(winnerCount) || winnerCount < 1) {
        throw new Error('Winner count must be a positive safe integer');
      }
      if (!canonicalTime(transitionAt)) throw new Error('Invalid phase transition timestamp');
      return transaction(() => {
        const current = readLineDeclarationBaseline(db);
        if (!sameBaseline(baseline, current)) throw new Error('Stale line declaration baseline');
        if (current.lastTransitionAt !== null && transitionAt <= current.lastTransitionAt) {
          throw new Error('Invalid phase transition timestamp');
        }
        const award = createLineAward({ winnerCount, prizeEuros: current.linePrize.amount, lot: current.linePrize.lot });
        const sequence = current.auditSequence + 1;
        db.prepare('UPDATE events SET phase = ?, lastTransitionAt = ? WHERE id = ?')
          .run('line_declared', transitionAt, current.eventId);
        db.prepare(`INSERT INTO phase_audit (event_id, sequence, transitionAt, kind, from_phase, to_phase)
          VALUES (?, ?, ?, 'declare_line_directly', 'drawing', 'line_declared')`)
          .run(current.eventId, sequence, transitionAt);
        db.prepare(`INSERT INTO line_awards (event_id, audit_sequence, winner_count, total_cents, share_cents,
          remainder_cents, lot, lot_resolution, presentation_id, presentation_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(current.eventId, sequence, award.winnerCount, award.totalCents, award.shareCents,
            award.remainderCents, award.lot, award.lotResolution, randomUUID());
        // Validate the committed state, including the new award, before COMMIT.
        readEvent(db);
        const stored = readLineAward(db, current.eventId, replayAudit(db, current.eventId));
        if (stored === null) throw new Error('Invalid stored line award: missing after write');
        return stored;
      });
    },
    // Explicit presentation steps; the main process calls them, nothing here uses a clock, timer or replay. Each
    // returns the frozen award read back inside the committing transaction and refuses stale ids and repeats.
    startLinePresentation(id: unknown, startedAt: unknown): StoredLineAward {
      if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0 ||
          startedAt + LINE_PRESENTATION_MS > MAX_SAFE_INTEGER) {
        throw new Error('Line presentation start must be a safe epoch millisecond whose deadline is safe');
      }
      return stepPresentation(id, 'start', () => ({ startedAt, deadlineAt: startedAt + LINE_PRESENTATION_MS }));
    },
    failLinePresentation(id: unknown): StoredLineAward { return stepPresentation(id, 'fail', noTimes); },
    retryLinePresentation(id: unknown): StoredLineAward { return stepPresentation(id, 'retry', noTimes); },
    // Explicit operator replay of an interrupted run: back to pending under a new id, so the old run can never complete.
    replayLinePresentation(id: unknown): StoredLineAward { return stepPresentation(id, 'replay', noTimes); },
    completeLinePresentation(id: unknown, now: unknown): StoredLineAward {
      if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
        throw new Error('Line presentation completion time must be a safe epoch millisecond');
      }
      return stepPresentation(id, 'complete', (current) => {
        if (current.deadlineAt === null || now < current.deadlineAt) throw new Error('Line presentation deadline not reached');
        return { startedAt: current.startedAt, deadlineAt: current.deadlineAt };
      });
    },
    // Startup reconciliation, called once by main before any window or delivery exists: every award persisted as
    // started across all events becomes interrupted, keeping its id and times. Never run by open, read or event
    // switching, and it creates no replay, completion or audit row. Each started row is fully validated first, so
    // corruption throws and rolls the whole batch back. Returns the number of awards changed.
    interruptStartedLinePresentations(): number {
      return transaction(() => {
        const ids = db.prepare("SELECT event_id FROM line_awards WHERE presentation_status = 'started' ORDER BY rowid")
          .all().map((row) => row.event_id);
        const to = transitionLinePresentation({ status: 'started' }, 'interrupt').status;
        for (const eventId of ids) {
          if (typeof eventId !== 'string') throw new Error('Invalid stored line award: event');
          const current = readLineAward(db, eventId, replayAudit(db, eventId));
          if (current === null || current.presentation.status !== 'started') {
            throw new Error('Invalid stored line award: presentation');
          }
          const result = db.prepare(`UPDATE line_awards SET presentation_status = ?
            WHERE event_id = ? AND presentation_id = ? AND presentation_status = 'started'`)
            .run(to, eventId, current.presentation.id);
          if (result.changes !== 1) throw new Error('Line presentation changed concurrently');
          const stored = readLineAward(db, eventId, replayAudit(db, eventId))?.presentation;
          if (stored?.status !== to || stored.id !== current.presentation.id ||
              stored.startedAt !== current.presentation.startedAt || stored.deadlineAt !== current.presentation.deadlineAt) {
            throw new Error('Invalid stored line award: presentation mismatch after write');
          }
        }
        return ids.length;
      });
    },
    // Rows are processed in insertion (rowid) order, never by random event id, so failures are reproducible.
    // Startup reconciliation (run after interruptStarted, before any window): every award persisted as
    // pending across all events becomes failed, keeping its id; its times stay NULL. Never run by open, read or event
    // switching, and it creates no retry, completion or audit row. Each pending row is fully validated first, so
    // corruption throws and rolls the whole batch back. Returns the number of awards changed.
    failPendingLinePresentations(): number {
      return transaction(() => {
        const ids = db.prepare("SELECT event_id FROM line_awards WHERE presentation_status = 'pending' ORDER BY rowid")
          .all().map((row) => row.event_id);
        const to = transitionLinePresentation({ status: 'pending' }, 'fail').status;
        for (const eventId of ids) {
          if (typeof eventId !== 'string') throw new Error('Invalid stored line award: event');
          const current = readLineAward(db, eventId, replayAudit(db, eventId));
          if (current === null || current.presentation.status !== 'pending') {
            throw new Error('Invalid stored line award: presentation');
          }
          const result = db.prepare(`UPDATE line_awards SET presentation_status = ?
            WHERE event_id = ? AND presentation_id = ? AND presentation_status = 'pending'`)
            .run(to, eventId, current.presentation.id);
          if (result.changes !== 1) throw new Error('Line presentation changed concurrently');
          const stored = readLineAward(db, eventId, replayAudit(db, eventId))?.presentation;
          if (stored?.status !== to || stored.id !== current.presentation.id ||
              stored.startedAt !== null || stored.deadlineAt !== null) {
            throw new Error('Invalid stored line award: presentation mismatch after write');
          }
        }
        return ids.length;
      });
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
