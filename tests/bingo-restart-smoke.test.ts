// In-memory guard tests for the Bingo restart/recovery smoke harness (BG-07 S2). The harness itself
// launches real Electron and may never run here: these tests cover only what is observable without
// Electron, using injected seeds/launchers/guards/rm and virtual paths — never the real filesystem,
// real profile metadata or real paths. The lifecycle core has its own suite in
// tests/bingo-smoke-lifecycle.test.ts and the guarded deletion path is covered by the S1 suite in
// tests/bingo-award-smoke.test.ts; here only this harness's delegation to those paths is proven.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as harness from '../verification/bingo-restart-ports.mjs';

test('importing the restart ports completes and exports seeding, ports and projection', () => {
  assert.equal(typeof harness.seedRestartProfile, 'function');
  assert.equal(typeof harness.smokePorts, 'function');
  assert.equal(typeof harness.durableAward, 'function');
});

test('seeding closes the caller-owned fixture store before returning and snapshots the rows', () => {
  const calls: string[] = [];
  const rows = { bingo_awards: [{ presentation_id: 'p-1' }] };
  const seed = harness.seedRestartProfile('/virtual/profile', 'award', {
    scenarios: { award: (dbPath: string) => { calls.push(`seed:${dbPath}`); return { store: { close: () => calls.push('close') }, bingo: {} }; } },
    readRows: (dbPath: string) => { calls.push(`rows:${dbPath}`); return rows; },
  } as never);
  assert.deepEqual(calls, [
    'seed:/virtual/profile/current-event.sqlite',
    'close',
    'rows:/virtual/profile/current-event.sqlite',
  ], 'the store is seeded, then closed before launch, then read row-by-row');
  assert.deepEqual(seed.rows, rows, 'the pre-launch snapshot travels with the seed');
});

test('seeding refuses unknown scenarios without seeding or reading anything', () => {
  const calls: string[] = [];
  assert.throws(() => harness.seedRestartProfile('/virtual/profile', 'held', {
    scenarios: {},
    readRows: () => { calls.push('rows'); return {}; },
  } as never), /unknown restart smoke scenario/);
  assert.deepEqual(calls, [], 'nothing is read for an unknown scenario');
});

test('the smoke ports seed the profile before launching and delete only through the guarded path', async () => {
  const order: string[] = [];
  const seedOut: { seed?: unknown } = {};
  const ports = harness.smokePorts('award', {
    mkdtemp: (prefix: string) => { order.push(`mkdtemp:${prefix}`); return '/virtual/bingo-smoke-restart-award-x'; },    resolve: (profile: string) => profile,
    seed: () => { order.push('seed'); return { marker: true }; },
    seedOut,
    electron: async () => { order.push('launch'); return 'app'; },
    cleanup: {
      guard: (profile: string) => { order.push(`guard:${profile}`); return '/virtual/resolved'; },
      rm: (target: string) => { order.push(`rm:${target}`); },
    },
  } as never);
  const profile = ports.allocateProfile();
  assert.equal(profile, '/virtual/bingo-smoke-restart-award-x', 'the profile lives in a bingo-smoke-restart-* temp dir');
  assert.ok(order[0].endsWith('bingo-smoke-restart-award-'), 'the temp prefix must carry the bingo-smoke restart marker');
  assert.equal(await ports.launch(profile), 'app');
  assert.equal((seedOut.seed as { marker: boolean }).marker, true, 'the seed travels to the run body');
  await ports.removeProfile(profile);
  assert.deepEqual(order, [
    order[0], // mkdtemp prefix: asserted by its bingo-smoke-restart-award- suffix above
    'seed', 'launch',
    'guard:/virtual/bingo-smoke-restart-award-x', 'rm:/virtual/resolved',
  ], 'seeding happens strictly before the launch and removal is guard-first');
});

test('the restart leg launches the same profile without seeding it again', async () => {
  const order: string[] = [];
  const ports = harness.smokePorts('award', {
    mkdtemp: () => '/virtual/reused-profile',
    resolve: (profile: string) => profile,
    seed: null,
    electron: async () => { order.push('launch'); return 'app'; },
  } as never);
  await ports.launch('/virtual/reused-profile');
  assert.deepEqual(order, ['launch'], 'a disabled seed must never reopen the store under a live app');
});

test('the durable award projection keeps identity and lot facts and drops only live presentation columns', () => {
  const row = { event_id: 'e-1', audit_sequence: 1, presentation_id: 'p-1', presentation_status: 'started',
    presentation_started_at: 't1', presentation_deadline: 't2', winner_count: 2, total_cents: 1000,
    share_cents: 500, remainder_cents: 0, lot: 'Jamón', lot_resolution: 'resolved',
    lot_result_origin: 'numbered_v1', lot_participant_number: 2, lot_color_id: 'blue', future_durable_fact: 'keep' };
  assert.deepEqual(harness.durableAward([row]), [{
    event_id: 'e-1', audit_sequence: 1, presentation_id: 'p-1', winner_count: 2, total_cents: 1000,
    share_cents: 500, remainder_cents: 0, lot: 'Jamón', lot_resolution: 'resolved',
    lot_result_origin: 'numbered_v1', lot_participant_number: 2, lot_color_id: 'blue', future_durable_fact: 'keep',
  }], 'restart reconciliation may only move live presentation state, never durable facts');
});
