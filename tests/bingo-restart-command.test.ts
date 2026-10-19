// Headless orchestration regressions: virtual pages/profiles and injected I/O, never Electron or real DBs.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as command from '../verification/bingo-restart-smoke.mjs';
import * as ports from '../verification/bingo-restart-ports.mjs';

test('the import-safe command preserves its existing helper exports', () => {
  for (const name of ['seedRestartProfile', 'smokePorts', 'durableAward'] as const) {
    assert.equal(command[name], ports[name]);
  }
});

function virtualApp() {
  const replies = [{ retry: false, repeat: false }, [7, 3], ['invalid_draw', 'invalid_draw'], [7, 3]];
  let reads = 0;
  const operator = {
    waitForFunction: async () => {},
    locator: () => ({ click: async () => {} }),
    evaluate: async () => replies[reads++],
  };
  const publicPage = {
    waitForFunction: async () => {},
    locator: () => ({ textContent: async () => 'committed award' }),
    evaluate: async () => false,
  };
  return {
    reads: () => reads,
    app: {
      process: () => ({}), windows: () => [], on: () => {},
      firstWindow: async () => operator, waitForEvent: async () => publicPage,
    },
  };
}

for (const number of [1, 2]) {
  test(`leg ${number} checks both draw refusals and unchanged calls`, async () => {
    const fixture = virtualApp();
    const state = { seed: { rows: { bingo_awards: [{ presentation_status: 'pending' }] } }, firstAwardText: 'committed award' };
    await command.awardLeg(number, state, () => {}, { exists: () => true })({
      app: fixture.app, profile: '/virtual/profile', check: () => {},
    });
    assert.equal(fixture.reads(), 4, 'status, calls before, both refusal codes and calls after must all be read');
  });
}

function restartFixture(failSnapshot: boolean) {
  const log: string[] = [];
  let deleted = false;
  let launches = 0;
  let snapshots = 0;
  const rows = { bingo_awards: [{ event_id: 'e', presentation_id: 'p', lot_color_id: 'blue' }] };
  const remove = () => { if (!deleted) { log.push('delete'); deleted = true; } };
  return {
    log,
    options: {
      run: async (options: { removeProfile: (profile: string) => unknown }) => {
        log.push(`close${++launches}`);
        await options.removeProfile('/virtual/profile');
      },
      ports: (_kind: string, options: { seedOut?: { seed?: unknown }; seed?: unknown; mkdtemp?: () => string }) => {
        if (options.seedOut) options.seedOut.seed = { rows };
        else {
          assert.equal(options.seed, null, 'restart never reseeds');
          assert.equal(options.mkdtemp?.(), '/virtual/profile', 'restart reuses the same owned profile');
        }
        return { removeProfile: remove };
      },
      readRows: () => {
        log.push(`snapshot${++snapshots}`);
        assert.equal(deleted, false, 'the snapshot must be read before the profile is deleted');
        if (failSnapshot && snapshots === 2) throw new Error('snapshot denied');
        return rows;
      },
      remove,
      leg: () => async () => {},
    },
  };
}

for (const failSnapshot of [false, true]) {
  test(`final snapshot precedes guarded deletion, including snapshot failure=${failSnapshot}`, async () => {
    const fixture = restartFixture(failSnapshot);
    const outcome = command.awardScenario(() => {}, fixture.options as never);
    if (failSnapshot) await assert.rejects(outcome, /^Error: snapshot denied$/);
    else await outcome;
    assert.deepEqual(fixture.log, ['close1', 'snapshot1', 'close2', 'snapshot2', 'delete']);
  });
}

const outcomes = [
  { name: 'missing offer', offered: false, failure: false, status: 'incomplete', error: 'Legacy cancellation was not exercised: no recovery offer at startup.' },
  { name: 'exercised cancellation', offered: true, failure: false, status: 'passed', error: undefined },
  { name: 'cancel failure', offered: true, failure: true, status: 'failed', error: 'cancel failed' },
];
for (const scenario of outcomes) {
  test(`the command records ${scenario.name} without false success`, async () => {
    const reports: string[] = [];
    const saved: any[] = [];
    let awards = 0;
    let held = 0;
    const run = command.smoke({
      award: async () => { awards++; },
      held: async (_note: unknown, observe = (_value: boolean) => {}) => {
        held++;
        observe(scenario.offered);
        if (scenario.failure) throw new Error('cancel failed');
        return scenario.offered;
      },
      save: (_path: string, _log: unknown, result: unknown) => saved.push(result),
      report: (message: string) => reports.push(message),
    } as never);
    if (scenario.error) await assert.rejects(run, { message: scenario.error });
    else await run;
    assert.equal(awards, 1);
    assert.equal(held, 1);
    assert.equal(saved.length, 1, 'every outcome must persist its observed evidence once');
    assert.equal(saved[0].status, scenario.status);
    assert.equal(saved[0].startupOfferVisible, scenario.offered);
    assert.equal(saved[0].award, 'passed');
    assert.equal(saved[0].heldCancellation, scenario.status === 'passed' ? 'passed' : 'not_exercised');
    assert.deepEqual(reports, scenario.status === 'passed' ? ['Bingo restart smoke passed'] : []);
  });
}
