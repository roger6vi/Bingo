// Ownership and cancellation core for isolated Electron smoke runs (BG-07 S1): deterministic and
// Electron-free so tests drive it with fakes. The profile is owned immediately after allocation, the app
// immediately after the launch handle resolves, every failure closes and removes exactly what was
// allocated, a timed-out run starts no further step, and cleanup waits for a safe app close before the
// guarded profile removal so a live database is never deleted. The cleanup wait for the launch flight is
// bounded: a hung launch can never keep the run's own timeout from reaching the caller, and a flight that
// does not settle in time leaves the profile in place with the breach reported. Cleanup failures are
// reported on the primary error (`cleanupFailures`), never masking it.
const defaultTimeoutMs = 180_000;
const defaultCleanupBoundMs = 5_000;

export async function runIsolated(ports, body) {
  const { allocateProfile, launch, verify = async () => ({}), closeApp, removeProfile } = ports;
  const timeoutMs = ports.timeoutMs ?? defaultTimeoutMs;
  const cleanupBoundMs = ports.cleanupBoundMs ?? defaultCleanupBoundMs;
  let app;
  let profile;
  let flightClosure;
  let cancelled = false;
  // The flight's single closer: cancellation is decided when the handle arrives, so a late app is closed
  // exactly once and never receives windows, assertions or further actions. The returned promise settles
  // only after that close completed, which is what cleanup waits for.
  const startFlight = (flight) => flight.then(async (handle) => {
    if (cancelled) {
      await closeApp(handle);
      return undefined;
    }
    app = handle;
    return handle;
  });
  const closeOwnedApp = async () => {
    const owned = app;
    app = undefined;
    if (owned !== undefined) await closeApp(owned);
  };
  const settleWithinBound = (promise) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), cleanupBoundMs);
    timer.unref?.();
    promise.then(() => { clearTimeout(timer); resolve(true); });
  });
  const cleanup = async () => {
    const failures = [];
    if (flightClosure !== undefined) {
      // The owned profile is never removed while its launch could still be in flight, and the wait is
      // bounded so a hung launch cannot defeat the timeout this run exists to enforce. A close failure
      // travels here instead of being swallowed; the run's own reason is never duplicated as a failure.
      const closure = flightClosure.then(() => undefined, (error) => {
        if (error !== primary) failures.push(error);
      });
      if (!(await settleWithinBound(closure))) {
        failures.push(new Error(`the launch flight did not settle within ${cleanupBoundMs} ms`));
        return failures;
      }
    }
    try {
      await closeOwnedApp();
    } catch (error) {
      failures.push(error);
    }
    const owned = profile;
    profile = undefined;
    if (owned !== undefined) {
      try {
        removeProfile(owned);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };
  const run = async () => {
    profile = allocateProfile();
    if (cancelled) return;
    flightClosure = startFlight(launch(profile));
    const context = {
      app: await flightClosure,
      profile,
      check: () => {
        if (cancelled) throw new Error('the smoke run was cancelled');
      },
    };
    // A launch that settled after cancellation is already closed: no verification and no body step run.
    if (context.app !== undefined) {
      Object.assign(context, await verify(context.app, profile));
      await body(context);
    }
  };
  const flight = run();
  // The timeout may reject first; contain the late body rejection so it can never become unhandled.
  flight.catch(() => {});
  let timer;
  let primary;
  try {
    await Promise.race([flight, new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        reject(new Error(`isolated run timed out after ${timeoutMs / 1000} s`));
      }, timeoutMs);
    })]);
  } catch (error) {
    primary = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const failures = await cleanup();
    if (primary !== undefined) {
      if (failures.length > 0) primary.cleanupFailures = failures;
      throw primary;
    }
    if (failures.length > 0) {
      throw new Error(`isolated run cleanup failed: ${failures.map((failure) => failure.message).join('; ')}`);
    }
  }
}
