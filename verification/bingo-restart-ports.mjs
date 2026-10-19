// Node-testable ports for the isolated Bingo restart smoke. Importing this module never launches Electron.
// Callers own the temporary profile; launch and deletion retain the shared profile guards.
import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchArgs, profilePrefix } from './electron-smoke.mjs';
import { removeTemporaryProfile } from './bingo-award-smoke.mjs';
import { declaredBingoWithLot, heldCheckingBingo, readRawRows } from './bingo-restart-fixtures.mjs';

const require = createRequire(import.meta.url);
export const DB_FILE = 'current-event.sqlite';
const totalTimeout = 180_000;
const scenarios = {
  award: (dbPath) => declaredBingoWithLot(dbPath),
  held: (dbPath) => heldCheckingBingo(dbPath),
};

// Seed and close before launching; injected collaborators keep unit tests entirely in memory.
export function seedRestartProfile(profile, kind, { scenarios: seeds = scenarios, readRows = readRawRows } = {}) {
  const seedScenario = seeds[kind];
  if (seedScenario === undefined) throw new Error(`unknown restart smoke scenario: ${String(kind)}`);
  const dbPath = path.join(profile, DB_FILE);
  const seed = seedScenario(dbPath);
  seed.store.close();
  return { ...seed, rows: readRows(dbPath) };
}

async function launchElectron(profile) {
  const { _electron: electron } = await import('playwright');
  return electron.launch({ executablePath: require('electron'), args: launchArgs(profile), timeout: 30_000 });
}

// The second leg reuses the first profile through mkdtemp and disables seeding with seed:null.
// Tests inject allocation, resolution, launch and guarded cleanup instead of touching real profiles.
export function smokePorts(kind, {
  mkdtemp = mkdtempSync, resolve = realpathSync, seed = seedRestartProfile, seedOut, cleanup = {}, electron = launchElectron,
} = {}) {
  return {
    timeoutMs: totalTimeout,
    allocateProfile: () => resolve(mkdtemp(path.join(tmpdir(), `${profilePrefix}restart-${kind}-`))),
    launch: async (profile) => {
      if (seed !== null) {
        const seeded = seed(profile, kind);
        if (seedOut !== undefined) seedOut.seed = seeded;
      }
      return electron(profile);
    },
    closeApp: async (app) => {
      await app.close().catch(() => app.process().kill('SIGKILL'));
    },
    removeProfile: (profile) => removeTemporaryProfile(profile, cleanup),
  };
}

// Reconciliation can change only these live fields. Preserve every other column, including provenance,
// presentation identity and future durable fields, so a whitelist cannot silently hide a reroll.
const LIVE_COLUMNS = new Set(['presentation_status', 'presentation_started_at', 'presentation_deadline']);
export function durableAward(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !LIVE_COLUMNS.has(column))));
}
