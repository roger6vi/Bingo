// FL09 harness database reader: read-only SQL that runs INSIDE Electron's main process for a verified, open fixture.
import path from 'node:path';
import { verifiedRuntime } from './line-smoke-lifecycle.mjs';

export const AWARD_SQL = `SELECT presentation_id AS id, presentation_status AS status, presentation_started_at AS startedAt,
  presentation_deadline AS deadline, winner_count AS winners, total_cents AS totalCents, share_cents AS shareCents,
  remainder_cents AS remainderCents, lot, lot_resolution AS lotResolution FROM line_awards`;

// Runs INSIDE Electron's main process via app.evaluate (self-contained: it is serialized). The runtime userData and
// appPath are re-checked before the fixture database is opened read-only; every statement runs and is fully
// materialized synchronously on the main event loop, so the product's synchronous writer can never overlap this
// SELECT. Only read statements are accepted.
export function mainReadOnly({ app }, { userData, appPath, file, statements }) {
  if (app.getPath('userData') !== userData) throw new Error(`userData mismatch: ${app.getPath('userData')} is not ${userData}`);
  if (app.getAppPath() !== appPath) throw new Error(`appPath mismatch: ${app.getAppPath()} is not ${appPath}`);
  for (const sql of statements) {
    if (!/^\s*(SELECT\b|PRAGMA (journal_mode|user_version)\s*$)/i.test(sql) || sql.includes(';')) throw new Error(`not a read-only statement: ${sql}`);
  }
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return statements.map((sql) => db.prepare(sql).all().map((row) => ({ ...row }))); } finally { db.close(); }
}

// Observations are COMMITTED state sampled between event-loop turns, not exact commit timestamps or power-loss proof.
export async function readFixture(fixture, statements) {
  const { app, root } = verifiedRuntime(fixture, 'read');
  return app.evaluate(mainReadOnly, { userData: fixture.path, appPath: root,
    file: path.join(fixture.path, 'current-event.sqlite'), statements });
}
export const readAwards = async (fixture) => (await readFixture(fixture, [AWARD_SQL]))[0];
