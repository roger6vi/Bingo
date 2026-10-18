// In-memory tests for the isolated-run ownership/cancellation core (BG-07 S1). The real harness launches
// Electron and may never run here: these tests drive runIsolated with fakes and virtual paths only — no
// real filesystem, no Electron, no outside-path metadata reads. Every test records the exact lifecycle
// moments in a shared sequence log (allocate/launch/settled/verify/body/close/remove) so ordering claims
// — close-before-remove and launch-settle-before-remove — are asserted as observed sequences, not inferred
// from separate call counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolated } from '../verification/bingo-smoke-lifecycle.mjs';

test('runIsolated owns the profile immediately: a launch failure removes it and never closes an app', async () => {
  const log: string[] = [];
  const calls = { close: 0, launch: 0, verify: 0, steps: 0, removed: [] as string[] };
  await assert.rejects(
    runIsolated({
      allocateProfile: () => { log.push('allocate'); return 'virtual-profile-1'; },
      launch: async () => { log.push('launch'); calls.launch += 1; throw new Error('launch failed'); },
      verify: async () => { log.push('verify'); calls.verify += 1; },
      closeApp: async () => { log.push('close'); calls.close += 1; },
      removeProfile: (profile: string) => { log.push('remove'); calls.removed.push(profile); },
    }, async () => { log.push('body'); calls.steps += 1; }),
    /launch failed/,
  );
  assert.equal(calls.launch, 1);
  assert.equal(calls.close, 0, 'closeApp is never invoked because no app handle was created');
  assert.equal(calls.verify, 0, 'verify is never invoked after a launch failure');
  assert.equal(calls.steps, 0, 'the body is never invoked after a launch failure');
  assert.deepEqual(calls.removed, ['virtual-profile-1'], 'removeProfile is invoked exactly once with the allocated profile');
  // The launch threw, so it settled before cleanup ran; the observed sequence proves the removal happens
  // only after that settlement, with no close in between.
  assert.deepEqual(log, ['allocate', 'launch', 'remove']);
});

test('runIsolated closes the adopted app and removes the profile when verification fails', async () => {
  const log: string[] = [];
  const calls = { closed: [] as string[], removed: [] as string[], steps: 0 };
  const app = { name: 'app' };
  await assert.rejects(
    runIsolated({
      allocateProfile: () => { log.push('allocate'); return 'virtual-profile-2'; },
      launch: async () => { log.push('launch'); return app; },
      verify: async () => { log.push('verify'); throw new Error('read failed'); },
      closeApp: async (handle: { name: string }) => { log.push('close'); calls.closed.push(handle.name); },
      removeProfile: (profile: string) => { log.push('remove'); calls.removed.push(profile); },
    }, async () => { log.push('body'); calls.steps += 1; }),
    /read failed/,
  );
  assert.deepEqual(calls.closed, ['app'], 'closeApp is invoked exactly once with the adopted handle');
  assert.deepEqual(calls.removed, ['virtual-profile-2'], 'removeProfile is invoked exactly once with the owned profile');
  assert.equal(calls.steps, 0, 'the body is never invoked after a verification failure');
  // Full observed sequence: the launch settled before the close, and the close strictly precedes the
  // removal (a cleanup that removed first would produce a different sequence here).
  assert.deepEqual(log, ['allocate', 'launch', 'verify', 'close', 'remove']);
});

test('runIsolated cancels on timeout: the late launch settles, the app closes once and no step starts', async () => {
  let resolveLaunch: (app: unknown) => void = () => {};
  const log: string[] = [];
  const calls = { closed: [] as string[], removed: [] as string[], steps: 0, verify: 0 };
  const app = { name: 'late-app' };
  const deferred = new Promise((resolve) => { resolveLaunch = resolve as never; });
  const outcome = runIsolated({
    timeoutMs: 1,
    allocateProfile: () => { log.push('allocate'); return 'virtual-profile-3'; },
    launch: () => { log.push('launch'); return deferred.then((handle) => { log.push('settled'); return handle; }); },
    verify: async () => { log.push('verify'); calls.verify += 1; },
    closeApp: async (handle: { name: string }) => { log.push('close'); calls.closed.push(handle.name); },
    removeProfile: (profile: string) => { log.push('remove'); calls.removed.push(profile); },
  }, async () => { log.push('body'); calls.steps += 1; });
  // Contain an early rejection so a regressed run that stops awaiting its launch surfaces as the sequence
  // assertion failure below instead of a fatal unhandled-rejection crash.
  outcome.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20)); // the 1 ms timeout has certainly fired
  resolveLaunch(app); // the launch completes after cancellation
  await assert.rejects(outcome, /timed out/);
  assert.deepEqual(calls.closed, ['late-app'], 'closeApp is invoked exactly once with the late handle');
  assert.deepEqual(calls.removed, ['virtual-profile-3'], 'removeProfile is invoked exactly once with the owned profile');
  assert.equal(calls.verify, 0, 'verify is never invoked after cancellation');
  assert.equal(calls.steps, 0, 'the cancelled run invokes the body zero times — no further step starts');
  // Full observed sequence: the removal happens only after the deferred launch settled and after the late
  // app was closed — a cleanup that dropped the await on the launch flight or removed before closing
  // would reorder this sequence.
  assert.deepEqual(log, ['allocate', 'launch', 'settled', 'close', 'remove']);
});

test('runIsolated reports cleanup failure without masking the primary error', async () => {
  const log: string[] = [];
  const calls = { closed: 0, removed: 0 };
  await assert.rejects(
    runIsolated({
      allocateProfile: () => { log.push('allocate'); return 'virtual-profile-4'; },
      launch: async () => { log.push('launch'); return { name: 'app' }; },
      verify: async () => { log.push('verify'); },
      closeApp: async () => { log.push('close'); calls.closed += 1; },
      removeProfile: () => { log.push('remove'); calls.removed += 1; throw new Error('guard refused'); },
    }, async () => { log.push('body'); throw new Error('primary failure'); }),
    (error: Error & { cleanupFailures?: Error[] }) => {
      assert.match(error.message, /primary failure/, 'the primary error is preserved');
      assert.match(error.cleanupFailures?.[0]?.message ?? '', /guard refused/);
      return true;
    },
  );
  assert.equal(calls.closed, 1);
  assert.equal(calls.removed, 1, 'removeProfile is attempted exactly once even though the guard refused');
  // Even with the removal throwing, the close still strictly precedes the removal attempt, and the body
  // ran (and failed) before cleanup began.
  assert.deepEqual(log, ['allocate', 'launch', 'verify', 'body', 'close', 'remove']);
});

test('a cancelled late launch completes its close before the profile is removed', async () => {
  let resolveLaunch: (app: unknown) => void = () => {};
  let resolveClose: () => void = () => {};
  const log: string[] = [];
  const closeGate = new Promise<void>((resolve) => { resolveClose = resolve; });
  const outcome = runIsolated({
    timeoutMs: 1,
    allocateProfile: () => { log.push('allocate'); return 'virtual-profile-5'; },
    launch: () => { log.push('launch'); return new Promise((resolve) => { resolveLaunch = resolve as never; }); },
    verify: async () => { log.push('verify'); },
    closeApp: async () => { log.push('close-start'); await closeGate; log.push('close-done'); },
    removeProfile: () => { log.push('remove'); },
  }, async () => { log.push('body'); });
  outcome.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveLaunch({ name: 'late-app' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(log, ['allocate', 'launch', 'close-start'], 'removal must wait for the late close to complete');
  resolveClose();
  await assert.rejects(outcome, /timed out/);
  assert.deepEqual(log, ['allocate', 'launch', 'close-start', 'close-done', 'remove']);
});

test('a failing late close is reported on the primary error instead of being swallowed', async () => {
  let resolveLaunch: (app: unknown) => void = () => {};
  const log: string[] = [];
  const outcome = runIsolated({
    timeoutMs: 1,
    allocateProfile: () => 'virtual-profile-6',
    launch: () => { log.push('launch'); return new Promise((resolve) => { resolveLaunch = resolve as never; }); },
    verify: async () => { log.push('verify'); },
    closeApp: async () => { log.push('close'); throw new Error('close denied'); },
    removeProfile: () => { log.push('remove'); },
  }, async () => { log.push('body'); });
  outcome.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveLaunch({ name: 'late-app' });
  await assert.rejects(outcome, (error: Error & { cleanupFailures?: Error[] }) => {
    assert.match(error.message, /timed out/, 'the timeout stays the primary error');
    assert.match(error.cleanupFailures?.map((failure) => failure.message).join('; ') ?? '', /close denied/);
    return true;
  });
  assert.deepEqual(log, ['launch', 'close', 'remove']);
});

test('a hung launch cannot defeat the timeout: cleanup is bounded and the profile survives', async () => {
  const log: string[] = [];
  const outcome = runIsolated({
    timeoutMs: 1,
    cleanupBoundMs: 5,
    allocateProfile: () => { log.push('allocate'); return 'virtual-profile-7'; },
    launch: () => { log.push('launch'); return new Promise(() => {}); },
    verify: async () => { log.push('verify'); },
    closeApp: async () => { log.push('close'); },
    removeProfile: () => { log.push('remove'); },
  }, async () => { log.push('body'); });
  outcome.catch(() => {});
  const neverSettled = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('runIsolated never settled')), 250);
  });
  await assert.rejects(Promise.race([outcome, neverSettled]), (error: Error & { cleanupFailures?: Error[] }) => {
    assert.match(error.message, /timed out/, 'the bounded timeout still reaches the caller');
    assert.equal(error.cleanupFailures?.length, 1);
    assert.match(error.cleanupFailures?.[0]?.message ?? '', /launch flight/);
    return true;
  });
  assert.deepEqual(log, ['allocate', 'launch'], 'the profile is never removed while the launched app is unverified');
});

test('runIsolated closes the app exactly once and removes the profile once on success', async () => {
  // Double-close regression on the non-cancelled path: adoption and cleanup must never both close the
  // adopted handle, and verification results must reach the body.
  const log: string[] = [];
  const calls = { closed: [] as string[], removed: [] as string[], steps: 0 };
  const app = { name: 'app' };
  await runIsolated({
    allocateProfile: () => { log.push('allocate'); return 'virtual-profile-0'; },
    launch: async () => { log.push('launch'); return app; },
    verify: async (handle: { name: string }) => {
      log.push('verify');
      assert.equal(handle.name, 'app', 'verify receives the adopted handle');
      return { extra: 'context' };
    },
    closeApp: async (handle: { name: string }) => { log.push('close'); calls.closed.push(handle.name); },
    removeProfile: (profile: string) => { log.push('remove'); calls.removed.push(profile); },
  }, async ({ check, extra }: { check: () => void; extra: string }) => {
    log.push('body');
    calls.steps += 1;
    check();
    assert.equal(extra, 'context', 'the merged verify context reaches the body');
  });
  assert.deepEqual(calls.closed, ['app'], 'closeApp is invoked exactly once — adoption and cleanup never both close');
  assert.deepEqual(calls.removed, ['virtual-profile-0'], 'removeProfile is invoked exactly once');
  assert.equal(calls.steps, 1, 'the body runs exactly once');
  // Full observed sequence: the launch settled (resolved) before the close, and the close strictly
  // precedes the single removal.
  assert.deepEqual(log, ['allocate', 'launch', 'verify', 'body', 'close', 'remove']);
});

test('a hung body step survives cleanup: the bounded wait reports the breach and keeps the profile', async () => {
  const log: string[] = [];
  let hang: () => void = () => {};
  const hung = new Promise<void>((resolve) => { hang = resolve as never; });
  const outcome = runIsolated({
    timeoutMs: 1,
    cleanupBoundMs: 20,
    allocateProfile: () => { log.push('allocate'); return 'virtual-profile-8'; },
    launch: async () => { log.push('launch'); return { name: 'app' }; },
    verify: async () => { log.push('verify'); },
    closeApp: async () => { log.push('close'); },
    removeProfile: () => { log.push('remove'); },
  }, async () => { log.push('body'); await hung; });
  outcome.catch(() => {});
  await assert.rejects(outcome, (error: Error & { cleanupFailures?: Error[] }) => {
    assert.match(error.message, /timed out/);
    assert.match(error.cleanupFailures?.[0]?.message ?? '', /the run steps did not settle within 20 ms/);
    return true;
  });
  hang();
  assert.equal(log.includes('close'), false, 'a live body step is never raced: the app stays open');
  assert.equal(log.includes('remove'), false, 'a live body step is never raced: the profile survives');
});
