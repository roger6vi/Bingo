// In-memory guard tests for the Bingo award smoke harness (BG-07 S1). The harness itself launches real
// Electron and may never run here: these tests cover only what is observable without Electron, using
// injected guards/rm and virtual paths — never the real filesystem, real profile metadata or real paths.
// The ownership/cancellation core has its own suite in tests/bingo-smoke-lifecycle.test.ts. The real
// guard's refusal coverage against homedir/temp/default-profile shapes is carried by the existing public
// contract of electron-smoke.mjs; its metadata exercise awaits explicit scope consent.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as harness from '../verification/bingo-award-smoke.mjs';

test('importing the harness completes and exports its guarded cleanup', () => {
  assert.equal(typeof harness.removeTemporaryProfile, 'function');
});

test('cleanup delegates to the caller-supplied guard and deletes only its resolution', () => {
  const calls: Array<{ rm: string; guard: string }> = [];
  const resolved = '/virtual/bingo-smoke-resolved';
  const guard = (profile: string) => { calls.push({ guard: profile, rm: '' }); return resolved; };
  const rm = (target: string) => { calls.push({ guard: '', rm: target }); };
  assert.equal(harness.removeTemporaryProfile('bingo-smoke-virtual', { guard, rm } as never), resolved);
  assert.deepEqual(calls, [{ guard: 'bingo-smoke-virtual', rm: '' }, { rm: resolved, guard: '' }],
    'the guard runs first and deletion receives exactly the resolved profile');
});

test('cleanup deletes nothing when the guard refuses', () => {
  const calls: string[] = [];
  assert.throws(() => harness.removeTemporaryProfile('virtual-refused-profile', {
    guard: (profile: string) => { calls.push(`guard:${profile}`); throw new Error('refused'); },
    rm: () => { calls.push('rm'); throw new Error('deletion must never run for a refused profile'); },
  } as never), /refused/);
  assert.deepEqual(calls, ['guard:virtual-refused-profile'], 'rm never runs behind a refused guard');
});
