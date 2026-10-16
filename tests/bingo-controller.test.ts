import assert from 'node:assert/strict';
import test from 'node:test';
import { createBingoController } from '../src/bingo-controller.mjs';

// Bingo operator controller: validated read, event context, lifecycle (F1), explicit begin/cancel (F2a) and
// confirmation with a fact-refresh hook (F2b), and held-award pushes with read-only staging (F3a, a subset of F3).
// Pushes never settle begin or cancel; a dispatched confirm or a read stages them for its answer (F3b). Explicit manual
// retry (failed) and repeat (interrupted) of the shown award behind fresh clear guards, and the rotation to the id
// main returns (G1a, G1b). An explicit legacy check read, bound to its event and checking_bingo phase (G2).
const session = { sessionId: 's1', eventId: 'e1', calledNumbers: [12, 5, 90], bingoPrize: { amount: 50, lot: 'Jamón' } };
const award = { eventId: 'e1', award: { winnerCount: 2, totalCents: 5000, shareCents: 2500, remainderCents: 0, lot: '',
  lotResolution: 'not_required' }, presentation: { id: 'p1', status: 'started', startedAt: 1000, deadlineAt: 5000 } };
const setup = (value: unknown = session) => ({ ok: true, state: 'setup', session: value });
const declared = (value: unknown = award) => ({ ok: true, state: 'declared', award: value });
const failure = (code: string, message: string) => ({ ok: false, code, message });
const flush = () => new Promise((done) => setImmediate(done));
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

type State = { mode: string; pending: boolean; error: string | null; eventId: string | null; phase: string | null;
  session: any; award: any; legacy: any };
function bingoFixture(overrides: Record<string, unknown> = {}, onRender: (state: State) => void = () => {},
  options?: { committed?: () => unknown }) {
  const calls: string[] = [];
  const renders: State[] = [];
  const replies: Array<() => unknown> = [];
  const actions: Array<() => unknown> = [];
  let push: (value: unknown) => void = () => { throw new Error('not subscribed'); };
  let unsubscribed = 0;
  const spy = (name: string) => () => { calls.push(name); return Promise.resolve({ ok: true, state: 'none' }); };
  // Actions (begin, cancel, confirm, retry and repeat) record their exact arguments and answer from their own queue.
  const act = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args].join(':'));
    return (actions.shift() ?? (async () => ({ ok: true, state: 'none' })))();
  };
  const api = {
    readBingoSetup: (...args: unknown[]) => {
      calls.push(`read:${args.length}`);
      return (replies.shift() ?? (async () => ({ ok: true, state: 'none' })))();
    },
    onBingoPresentation: (callback: (value: unknown) => void) => {
      calls.push('subscribe');
      push = callback;
      return () => { unsubscribed++; };
    },
    beginBingoSetup: act('begin'), cancelBingoSetup: act('cancel'), confirmBingo: act('confirm'),
    retryBingoPresentation: act('retry'), repeatBingoPresentation: act('repeat'),
    readLegacyBingoCheck: spy('legacy-read'), cancelLegacyBingoCheck: spy('legacy-cancel'),
    ...overrides,
  };
  const controller = createBingoController(api, { render: (state: State) => { renders.push(state); onRender(state); } },
    options);
  return { controller, calls, renders, replies, actions, push: (value: unknown) => push(value),
    unsubscribed: () => unsubscribed, last: () => renders.at(-1) as State,
    reply: (value: unknown) => replies.push(async () => value), answer: (value: unknown) => actions.push(async () => value) };
}

test('bingo subscribes before any read and never reads, writes or plays by itself', async () => {
  const f = bingoFixture();
  assert.deepEqual(Object.keys(f.controller).sort(),
    ['begin', 'cancel', 'checkLegacy', 'confirm', 'dispose', 'getState', 'repeat', 'retry', 'setEvent', 'setGuards',
      'start']);
  assert.deepEqual(f.calls, ['subscribe']);
  assert.equal(f.last().mode, 'unknown');
  f.controller.setEvent('e1', 'drawing');
  await flush();
  assert.deepEqual(f.calls, ['subscribe']);
  assert.deepEqual([f.last().eventId, f.last().phase, f.last().mode], ['e1', 'drawing', 'unknown']);
  await f.controller.start();
  assert.deepEqual(f.calls, ['subscribe', 'read:0']);
  assert.deepEqual([f.last().mode, f.last().pending, f.last().error], ['idle', false, null]);
});

test('bingo adopts only a validated setup or declared award, and hands out independent clones', async () => {
  const f = bingoFixture();
  f.controller.setEvent('e1', 'drawing');
  const empty = { sessionId: 's2', eventId: 'e1', calledNumbers: [], bingoPrize: { amount: 0, lot: '' } };
  f.reply(setup(empty));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session], ['setup', empty]);
  f.reply(setup());
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session, f.last().award], ['setup', session, null]);
  f.last().session.calledNumbers.push(7);
  f.last().session.bingoPrize.amount = 1;
  const state = f.controller.getState();
  state.session.calledNumbers.length = 0;
  assert.deepEqual(f.controller.getState().session, session);
  assert.notEqual(f.controller.getState().session, f.controller.getState().session);
  f.reply(declared());
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award, f.last().session], ['declared', award, null]);
  f.last().award.presentation.status = 'completed';
  f.controller.getState().award.award.winnerCount = 9;
  assert.deepEqual(f.controller.getState().award, award);
});

test('bingo fails closed on corrupt, foreign, legacy or lifecycle read answers', async () => {
  const withSession = (patch: object) => setup({ ...session, ...patch });
  const withAward = (patch: object) => declared({ ...award, ...patch });
  const withPresentation = (patch: object) => withAward({ presentation: { ...award.presentation, ...patch } });
  const corrupt = [
    withSession({ eventId: 'e2' }), withSession({ sessionId: '' }), withSession({ sessionId: 'x'.repeat(65) }),
    withSession({ calledNumbers: [0] }), withSession({ calledNumbers: [91] }), withSession({ calledNumbers: [1.5] }),
    withSession({ calledNumbers: [4, 4] }), withSession({ calledNumbers: 'all' }), withSession({ bingoPrize: null }),
    withSession({ bingoPrize: { amount: 100_001, lot: '' } }), withSession({ bingoPrize: { amount: 1.5, lot: '' } }),
    withSession({ bingoPrize: { amount: -1, lot: '' } }), withSession({ bingoPrize: { amount: 1, lot: ' x' } }),
    withSession({ bingoPrize: { amount: 1, lot: 'x'.repeat(121) } }), withAward({ eventId: 'e2' }),
    withAward({ presentation: undefined }), withPresentation({ id: '' }), withPresentation({ id: 'p'.repeat(65) }),
    withPresentation({ deadlineAt: 6000 }), withPresentation({ status: 'playing' }), withAward({ award: { ...award.award, shareCents: 1 } }),
    { ok: true, state: 'legacy_check', check: {} }, { ok: true, state: 'recovered' }, { ok: true, state: 'cancelled' },
    { ok: true }, { state: 'none' }, null, failure('not_available', 'Nope.'),
  ];
  for (const reply of corrupt) {
    const f = bingoFixture();
    f.controller.setEvent('e1', 'drawing');
    f.reply(reply);
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, f.last().pending], ['uncertain', null, null, false],
      JSON.stringify(reply));
    assert.equal(typeof f.last().error, 'string');
  }
});

test('bingo read failures keep a valid setup uncertain, stale drops it, and nothing retries by itself', async () => {
  const f = bingoFixture();
  f.controller.setEvent('e1', 'drawing');
  f.reply(setup());
  await f.controller.start();
  f.reply(failure('storage_failure', 'Could not read the Bingo state. Try again.'));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session, f.last().error], ['uncertain', session,
    'Could not read the Bingo state. Try again.']);
  f.replies.push(() => Promise.reject(new Error('gone')));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session], ['uncertain', session]);
  f.replies.push(() => { throw new Error('sync'); });
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session], ['uncertain', session]);
  f.reply(failure('stale_session', 'This Bingo setup is no longer current. Reopen it.'));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().session, f.last().award], ['uncertain', null, null]);
  await flush();
  assert.equal(f.calls.filter((call) => call.startsWith('read')).length, 5);
  await f.controller.start();
  assert.equal(f.last().mode, 'idle');
  f.reply(declared());
  await f.controller.start();
  f.reply(failure('storage_failure', 'Could not read the Bingo state. Try again.'));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award], ['uncertain', null]);
});

test('bingo without a known event fails closed and never reads', async () => {
  const f = bingoFixture();
  await f.controller.start();
  assert.deepEqual(f.calls, ['subscribe']);
  assert.deepEqual([f.last().mode, f.last().session, f.last().award], ['uncertain', null, null]);
  f.controller.setEvent('x'.repeat(65), 'drawing');
  await f.controller.start();
  assert.deepEqual([f.calls, f.last().eventId, f.last().mode], [['subscribe'], null, 'uncertain']);
  f.controller.setEvent('e1', null);
  assert.deepEqual([f.last().mode, f.last().error], ['unknown', null]);
  f.reply(declared());
  await f.controller.start();
  assert.equal(f.last().mode, 'declared');
});

test('bingo with a missing, throwing or invalid subscriber or read bridge stays unavailable', async () => {
  const variants = [
    { onBingoPresentation: undefined }, { onBingoPresentation: () => { throw new Error('no'); } },
    { onBingoPresentation: () => 'cleanup' }, { readBingoSetup: undefined },
  ];
  for (const variant of variants) {
    const f = bingoFixture(variant);
    assert.equal(f.last().mode, 'uncertain');
    f.controller.setEvent('e1', 'drawing');
    await f.controller.start();
    f.controller.setEvent('e2', 'drawing');
    await f.controller.start();
    assert.equal(f.calls.some((call) => call.startsWith('read')), false);
    assert.deepEqual([f.last().mode, f.last().pending, typeof f.last().error], ['uncertain', false, 'string']);
    f.controller.dispose();
  }
});

test('bingo start is single-flight, including a start re-entered from render', async () => {
  const d = deferred();
  let reenter = false;
  const f = bingoFixture({}, () => { if (reenter) void f.controller.start(); });
  f.controller.setEvent('e1', 'drawing');
  f.replies.push(() => d.promise);
  reenter = true;
  const first = f.controller.start();
  const second = f.controller.start();
  reenter = false;
  assert.deepEqual([f.calls, f.last().pending], [['subscribe', 'read:0'], true]);
  d.resolve(setup());
  await Promise.all([first, second]);
  assert.deepEqual([f.calls.length, f.last().mode, f.last().pending], [2, 'setup', false]);
});

test('bingo drops an answer from a previous event and its flight never clears the new one', async () => {
  const old = deferred();
  const fresh = deferred();
  const f = bingoFixture();
  f.controller.setEvent('e1', 'drawing');
  f.replies.push(() => old.promise, () => fresh.promise);
  const first = f.controller.start();
  f.controller.setEvent('e2', 'drawing');
  assert.deepEqual([f.last().mode, f.last().pending, f.last().eventId], ['unknown', false, 'e2']);
  const second = f.controller.start();
  assert.equal(f.last().pending, true);
  const seen = f.renders.length;
  old.resolve(setup());
  await first;
  assert.deepEqual([f.renders.length, f.controller.getState().pending, f.controller.getState().session], [seen, true, null]);
  fresh.resolve(setup({ ...session, eventId: 'e2' }));
  await second;
  assert.deepEqual([f.last().mode, f.last().pending, f.last().session.eventId], ['setup', false, 'e2']);
  const late = deferred();
  f.replies.push(() => late.promise);
  const third = f.controller.start();
  f.controller.setEvent('e1', 'drawing');
  late.reject(new Error('lost'));
  await third;
  assert.deepEqual([f.last().mode, f.last().pending, f.last().error, f.last().session], ['unknown', false, null, null]);
});

test('bingo keeps its session and flight across a same-event phase update without reading', async () => {
  const d = deferred();
  const f = bingoFixture();
  f.controller.setEvent('e1', 'drawing');
  f.replies.push(() => d.promise);
  const read = f.controller.start();
  f.controller.setEvent('e1', 'checking_bingo');
  assert.equal(f.last().pending, true);
  d.resolve(setup());
  await read;
  assert.deepEqual([f.last().mode, f.last().session, f.last().phase], ['setup', session, 'checking_bingo']);
  f.controller.setEvent('e1', null);
  await flush();
  assert.deepEqual([f.calls.length, f.controller.getState().session, f.controller.getState().phase], [2, session, null]);
});

test('bingo dispose unsubscribes exactly once, even if it throws, and late answers change nothing', async () => {
  let released = 0;
  const d = deferred();
  const f = bingoFixture({ onBingoPresentation: () => () => { released++; throw new Error('gone'); } });
  f.controller.setEvent('e1', 'drawing');
  f.replies.push(() => d.promise);
  const read = f.controller.start();
  const before = f.controller.getState();
  const seen = f.renders.length;
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(released, 1);
  d.resolve(setup());
  await read;
  f.controller.setEvent('e2', 'drawing');
  await f.controller.start();
  assert.deepEqual([f.renders.length, f.controller.getState(), f.calls], [seen, before, ['read:0']]);
});

test('bingo ignores presentation pushes while it holds a setup and no trusted award', async () => {
  const f = bingoFixture();
  f.controller.setEvent('e1', 'drawing');
  f.reply(setup());
  await f.controller.start();
  const seen = f.renders.length;
  f.push(declared().award);
  f.push({ eventId: 'e1', presentation: 'corrupt' });
  f.push(null);
  await flush();
  assert.deepEqual([f.renders.length, f.controller.getState().mode, f.controller.getState().session], [seen, 'setup', session]);
  assert.deepEqual(f.calls, ['subscribe', 'read:0']);
  f.controller.dispose();
  assert.equal(f.unsubscribed(), 1);
});

test('bingo presentation status must be a string, not a coercible array or object', async () => {
  const statuses = [['started'], { toString: () => 'started' }, new String('started'), null, undefined, 1, true];
  for (const status of statuses) {
    const f = bingoFixture();
    f.controller.setEvent('e1', 'drawing');
    f.reply(declared({ ...award, presentation: { ...award.presentation, status } }));
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().award, f.last().pending], ['uncertain', null, false]);
  }
});

test('bingo checks ownership after render before dispatching a read', async () => {
  for (const change of ['dispose', 'switch']) {
    const fresh = deferred();
    let armed = false;
    let joined: Promise<unknown> | undefined;
    const f = bingoFixture({}, () => {
      if (!armed) return;
      armed = false;
      if (change === 'dispose') f.controller.dispose();
      else {
        f.controller.setEvent('e2', 'drawing');
        joined = f.controller.start();
      }
    });
    f.controller.setEvent('e1', 'drawing');
    if (change === 'switch') f.replies.push(() => fresh.promise);
    armed = true;
    const old = f.controller.start();
    await old;
    const callsBeforeSettlement = [...f.calls];
    const pendingBeforeSettlement = f.controller.getState().pending;
    if (change === 'switch') {
      fresh.resolve(setup({ ...session, eventId: 'e2' }));
      await joined;
    }
    assert.deepEqual(callsBeforeSettlement, change === 'dispose' ? ['subscribe'] : ['subscribe', 'read:0']);
    if (change === 'switch') {
      assert.equal(pendingBeforeSettlement, true);
      assert.deepEqual([f.last().mode, f.last().pending, f.last().session.eventId], ['setup', false, 'e2']);
    } else assert.equal(f.unsubscribed(), 1);
  }
});

test('bingo reentrant starts from render and API join the actual flight settlement', async () => {
  for (const source of ['render', 'api']) {
    const d = deferred();
    let armed = false;
    let joined: Promise<unknown> | undefined;
    let settled = false;
    const reenter = () => {
      if (!armed) return;
      armed = false;
      joined = f.controller.start();
      joined.then(() => { settled = true; });
    };
    const f = bingoFixture({}, () => { if (source === 'render') reenter(); });
    f.controller.setEvent('e1', 'drawing');
    f.replies.push(() => {
      if (source === 'api') reenter();
      return d.promise;
    });
    armed = true;
    const first = f.controller.start();
    const second = f.controller.start();
    await flush();
    const settledBeforeReply = settled;
    const pendingBeforeReply = f.controller.getState().pending;
    d.resolve(setup());
    await Promise.all([first, second, joined]);
    assert.equal(settledBeforeReply, false, source);
    assert.equal(pendingBeforeReply, true, source);
    assert.equal(joined, first, source);
    assert.equal(second, first, source);
    assert.deepEqual([f.calls, f.last().mode, f.last().pending], [['subscribe', 'read:0'], 'setup', false]);
  }
});

// F2a: explicit begin and cancel share the read's single flight, ownership and event/disposal guards.
const idleAt = async (f: ReturnType<typeof bingoFixture>, phase = 'line_declared') => {
  f.controller.setEvent('e1', phase);
  await f.controller.start();
};

test('bingo begin dispatches only from a fresh idle line_declared event and adopts a validated clone', async () => {
  const f = bingoFixture();
  await f.controller.begin();
  f.controller.setEvent('e1', 'line_declared');
  await f.controller.begin();
  await f.controller.start();
  for (const phase of ['drawing', 'checking_bingo', null]) {
    f.controller.setEvent('e1', phase);
    await f.controller.begin();
  }
  assert.deepEqual(f.calls, ['subscribe', 'read:0']);
  assert.deepEqual([f.last().mode, f.last().pending], ['idle', false]);
  f.controller.setEvent('e1', 'line_declared');
  const reply = setup(structuredClone(session));
  f.answer(reply);
  await f.controller.begin();
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin']);
  assert.deepEqual([f.last().mode, f.last().session, f.last().error, f.last().pending], ['setup', session, null, false]);
  (reply.session as typeof session).calledNumbers.push(7);
  f.last().session.bingoPrize.lot = 'x';
  assert.deepEqual(f.controller.getState().session, session);
  await f.controller.begin();
  f.reply(declared());
  await f.controller.start();
  await f.controller.begin();
  await f.controller.cancel();
  f.reply(null);
  await f.controller.start();
  await f.controller.begin();
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin', 'read:0', 'read:0']);
});

test('bingo begin and cancel without their bridge fail closed without dispatch, and reads still work', async () => {
  const f = bingoFixture({ beginBingoSetup: undefined, cancelBingoSetup: 'nope' });
  await idleAt(f);
  await f.controller.begin();
  assert.deepEqual([f.last().mode, f.last().pending, typeof f.last().error], ['idle', false, 'string']);
  f.reply(setup());
  await f.controller.start();
  await f.controller.cancel();
  assert.deepEqual([f.last().mode, f.last().session, f.last().pending, typeof f.last().error],
    ['setup', session, false, 'string']);
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'read:0']);
});

test('bingo begin keeps idle on a known refusal; lost or malformed answers turn uncertain and never retry', async () => {
  for (const code of ['setup_active', 'not_available', 'tongo_active', 'presentation_busy', 'storage_failure',
    'invalid_request']) {
    const f = bingoFixture();
    await idleAt(f);
    f.answer(failure(code, `Refused ${code}.`));
    await f.controller.begin();
    await flush();
    assert.deepEqual([f.last().mode, f.last().error, f.last().pending, f.last().session],
      ['idle', `Refused ${code}.`, false, null], code);
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin'], code);
  }
  const lost = [() => Promise.reject(new Error('gone')), () => { throw new Error('sync'); }, async () => null,
    async () => setup({ ...session, eventId: 'e2' }), async () => setup({ ...session, calledNumbers: [0] }),
    async () => ({ ok: true, state: 'none' }), async () => ({ ok: true, state: 'cancelled' }), async () => declared(),
    async () => failure('stale_session', 'Stale.'), async () => failure('mystery', 'Hm.'),
    async () => ({ ok: false, code: 'setup_active' }), async () => ({ ok: false, code: 'setup_active', message: ' ' })];
  for (const answer of lost) {
    const f = bingoFixture();
    await idleAt(f);
    f.actions.push(answer);
    await f.controller.begin();
    await flush();
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, f.last().pending], ['uncertain', null, null, false]);
    assert.equal(typeof f.last().error, 'string');
    await f.controller.begin();
    await f.controller.cancel();
    await flush();
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin']);
    f.reply(setup());
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().session, f.last().error], ['setup', session, null]);
  }
});

test('bingo cancel sends the owned session and event, unwinds after a phase change and maps each answer', async () => {
  // An omitted message means any fail-closed string.
  const cases: Array<[() => unknown, string, unknown, (string | null)?]> = [
    [async () => ({ ok: true, state: 'cancelled' }), 'idle', null, null],
    [async () => failure('stale_session', 'Gone.'), 'uncertain', null, 'Gone.'],
    [async () => failure('setup_active', 'Busy.'), 'setup', session, 'Busy.'],
    [async () => failure('storage_failure', 'Later.'), 'setup', session, 'Later.'],
    [() => Promise.reject(new Error('lost')), 'uncertain', session], [() => { throw new Error('sync'); }, 'uncertain', session],
    [async () => null, 'uncertain', session], [async () => ({ ok: true, state: 'none' }), 'uncertain', session],
    [async () => ({ ok: true, state: 'cancelled', session }), 'uncertain', session],
    [async () => setup(), 'uncertain', session], [async () => failure('mystery', 'Hm.'), 'uncertain', session],
  ];
  for (const [answer, mode, kept, message] of cases) {
    const f = bingoFixture();
    await idleAt(f);
    await f.controller.cancel();
    f.reply(setup());
    await f.controller.start();
    f.controller.setEvent('e1', 'drawing');
    f.actions.push(answer);
    await f.controller.cancel();
    await flush();
    const label = `${mode}:${String(message)}`;
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'read:0', 'cancel:s1:e1'], label);
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, f.last().pending], [mode, kept, null, false], label);
    if (message === undefined) assert.equal(typeof f.last().error, 'string', label);
    else assert.equal(f.last().error, message, label);
    await f.controller.begin();
    f.reply({ ok: true, state: 'none' });
    await f.controller.start();
    assert.deepEqual([f.calls.length, f.last().mode, f.last().session], [5, 'idle', null], label);
  }
});

test('bingo competing begin, cancel and start calls join the actual action flight, including reentry', async () => {
  for (const [first, source] of [['begin', 'none'], ['begin', 'render'], ['begin', 'api'], ['cancel', 'render'],
    ['cancel', 'api']]) {
    const d = deferred();
    let armed = false;
    const joined: Promise<unknown>[] = [];
    const reenter = () => {
      if (!armed) return;
      armed = false;
      joined.push(f.controller.begin(), f.controller.cancel(), f.controller.start());
    };
    const f = bingoFixture({}, () => { if (source === 'render') reenter(); });
    await idleAt(f);
    if (first === 'cancel') {
      f.reply(setup());
      await f.controller.start();
    }
    f.actions.push(() => {
      if (source === 'api') reenter();
      return d.promise;
    });
    armed = true;
    const flight = first === 'begin' ? f.controller.begin() : f.controller.cancel();
    const others = [f.controller.begin(), f.controller.cancel(), f.controller.start()];
    let settled = false;
    void flight.then(() => { settled = true; });
    await flush();
    const label = `${first}:${source}`;
    assert.deepEqual([settled, f.controller.getState().pending], [false, true], label);
    d.resolve(first === 'begin' ? setup() : { ok: true, state: 'cancelled' });
    await Promise.all([flight, ...others, ...joined]);
    assert.equal(joined.length, source === 'none' ? 0 : 3, label);
    for (const promise of [...others, ...joined]) assert.equal(promise, flight, label);
    const sent = first === 'begin' ? 'begin' : 'cancel:s1:e1';
    assert.deepEqual(f.calls.filter((call) => !call.startsWith('read')), ['subscribe', sent], label);
    assert.deepEqual([f.last().mode, f.last().pending], [first === 'begin' ? 'setup' : 'idle', false], label);
  }
});

test('bingo rechecks owner, event and dispatch phase after render, but a phase change never orphans an action', async () => {
  for (const change of ['phase', 'dispose', 'switch']) {
    let armed = false;
    const f = bingoFixture({}, () => {
      if (!armed) return;
      armed = false;
      if (change === 'phase') f.controller.setEvent('e1', 'drawing');
      else if (change === 'dispose') f.controller.dispose();
      else f.controller.setEvent('e2', 'line_declared');
    });
    await idleAt(f);
    armed = true;
    await f.controller.begin();
    await flush();
    assert.deepEqual(f.calls, ['subscribe', 'read:0'], change);
    if (change !== 'dispose') assert.deepEqual([f.last().pending, f.last().session], [false, null], change);
  }
  const d = deferred();
  let armed = false;
  const f = bingoFixture({}, () => {
    if (!armed) return;
    armed = false;
    f.controller.setEvent('e1', 'drawing');
  });
  await idleAt(f);
  f.actions.push(() => d.promise);
  const begun = f.controller.begin();
  f.controller.setEvent('e1', 'checking_bingo');
  d.resolve(setup());
  await begun;
  assert.deepEqual([f.last().mode, f.last().session, f.last().phase], ['setup', session, 'checking_bingo']);
  armed = true;
  f.answer({ ok: true, state: 'cancelled' });
  await f.controller.cancel();
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin', 'cancel:s1:e1']);
  assert.deepEqual([f.last().mode, f.last().session, f.last().phase, f.last().pending], ['idle', null, 'drawing', false]);
});

test('bingo drops late action answers after an event switch or disposal and keeps the replacement flight', async () => {
  const old = deferred();
  const fresh = deferred();
  const f = bingoFixture();
  await idleAt(f);
  f.actions.push(() => old.promise);
  const begun = f.controller.begin();
  f.controller.setEvent('e2', 'line_declared');
  f.replies.push(() => fresh.promise);
  const read = f.controller.start();
  const seen = f.renders.length;
  old.resolve(setup());
  await begun;
  assert.deepEqual([f.renders.length, f.controller.getState().pending, f.controller.getState().mode],
    [seen, true, 'unknown']);
  fresh.resolve({ ok: true, state: 'none' });
  await read;
  assert.deepEqual([f.last().eventId, f.last().mode, f.last().pending, f.last().session], ['e2', 'idle', false, null]);
  const late = deferred();
  f.reply(setup({ ...session, eventId: 'e2' }));
  await f.controller.start();
  f.actions.push(() => late.promise);
  const cancelled = f.controller.cancel();
  const before = f.controller.getState();
  const count = f.renders.length;
  f.controller.dispose();
  late.resolve({ ok: true, state: 'cancelled' });
  await cancelled;
  assert.deepEqual([f.renders.length, f.controller.getState()], [count, before]);
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'begin', 'read:0', 'read:0', 'cancel:s1:e2']);
});

// F2b: explicit confirmation shares the same flight; only a valid explicit confirm refreshes facts through the hook.
const setupAt = async (f: ReturnType<typeof bingoFixture>, phase = 'line_declared') => {
  f.controller.setEvent('e1', phase);
  f.reply(setup());
  await f.controller.start();
};

test('bingo confirm sends only a positive safe integer for the owned line_declared setup, never coerced', async () => {
  let hooks = 0;
  const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
  await setupAt(f);
  const counts = [0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, '2', null, undefined, true, [2], {}, new Number(2), 2n];
  for (const count of counts) {
    await f.controller.confirm(count);
    assert.deepEqual([f.last().mode, f.last().session, f.last().pending, typeof f.last().error],
      ['setup', session, false, 'string'], String(count));
  }
  await f.controller.confirm();
  f.controller.setEvent('e1', 'drawing');
  await f.controller.confirm(2);
  assert.deepEqual([f.calls, f.last().session], [['subscribe', 'read:0'], session]);
  f.controller.setEvent('e1', 'line_declared');
  f.answer(declared());
  await f.controller.confirm(2);
  await flush();
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'confirm:s1:2']);
  assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().error, hooks],
    ['declared', award, null, null, 1]);
  f.last().award.award.winnerCount = 9;
  assert.deepEqual(f.controller.getState().award, award);
  await f.controller.confirm(2);
  f.reply({ ok: true, state: 'none' });
  await f.controller.start();
  await f.controller.confirm(1);
  f.reply(null);
  await f.controller.start();
  await f.controller.confirm(1);
  await flush();
  assert.deepEqual([f.calls.filter((call) => call.startsWith('confirm')).length, hooks], [1, 1]);
  const missing = bingoFixture({ confirmBingo: undefined });
  await setupAt(missing);
  await missing.controller.confirm(2);
  assert.deepEqual([missing.last().mode, missing.last().session, typeof missing.last().error], ['setup', session, 'string']);
  assert.deepEqual(missing.calls, ['subscribe', 'read:0']);
});

test('bingo confirm adopts only an exact bound declaration; refusals keep setup, lost outcomes stay uncertain', async () => {
  let hooks = 0;
  const g = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
  await idleAt(g);
  g.answer(setup());
  await g.controller.begin();
  g.answer({ ok: true, state: 'cancelled' });
  await g.controller.cancel();
  g.reply(declared());
  await g.controller.start();
  await flush();
  assert.deepEqual([g.last().mode, hooks], ['declared', 0]);
  // An omitted message means any fail-closed string. Storage failure is never treated as "nothing was written".
  const cases: Array<[() => unknown, string, unknown, (string | null)?]> = [
    [async () => failure('tongo_active', 'Tongo.'), 'setup', session, 'Tongo.'],
    [async () => failure('presentation_busy', 'Busy.'), 'setup', session, 'Busy.'],
    [async () => failure('setup_active', 'Open.'), 'setup', session, 'Open.'],
    [async () => failure('invalid_request', 'Bad.'), 'setup', session, 'Bad.'],
    [async () => failure('stale_session', 'Gone.'), 'uncertain', null, 'Gone.'],
    [async () => failure('storage_failure', 'Could not read the clock. Try again.'), 'uncertain', session],
    [async () => failure('storage_failure', 'Could not confirm the Bingo declaration.'), 'uncertain', session],
    [() => Promise.reject(new Error('lost')), 'uncertain', session], [() => { throw new Error('sync'); }, 'uncertain', session],
    [async () => null, 'uncertain', session], [async () => ({ ...declared(), extra: 1 }), 'uncertain', session],
    [async () => declared({ ...award, eventId: 'e2' }), 'uncertain', session],
    [async () => declared({ ...award, award: { ...award.award, winnerCount: 1, shareCents: 5000 } }), 'uncertain', session],
    [async () => declared({ ...award, presentation: undefined }), 'uncertain', session],
    [async () => setup(), 'uncertain', session], [async () => ({ ok: true, state: 'none' }), 'uncertain', session],
    [async () => failure('mystery', 'Hm.'), 'uncertain', session], [async () => failure('not_available', ''), 'uncertain', session],
  ];
  for (const [answer, mode, kept, message] of cases) {
    hooks = 0;
    const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
    await setupAt(f);
    f.actions.push(answer);
    await f.controller.confirm(2);
    await flush();
    const label = `${mode}:${String(message)}`;
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'confirm:s1:2'], label);
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, f.last().pending], [mode, kept, null, false], label);
    if (message === undefined) assert.equal(typeof f.last().error, 'string', label);
    else assert.equal(f.last().error, message, label);
    if (mode === 'uncertain') await f.controller.confirm(2);
    f.reply(setup());
    await f.controller.start();
    f.reply(setup());
    await f.controller.start();
    f.reply(declared());
    await f.controller.start();
    await flush();
    assert.deepEqual([f.calls.length, f.last().mode, f.last().award, hooks], [6, 'declared', award, 0], label);
  }
});

test('bingo committed hook runs once after the flight is released, sees the declared state and is contained', async () => {
  for (const kind of ['plain', 'throw', 'reject', 'reenter']) {
    const seen: State[] = [];
    const f = bingoFixture({}, () => {}, { committed: () => {
      seen.push(f.controller.getState());
      if (kind === 'throw') throw new Error('hook');
      if (kind === 'reject') return Promise.reject(new Error('hook'));
      if (kind === 'reenter') {
        void f.controller.confirm(2);
        void f.controller.cancel();
        void f.controller.begin();
      }
      return undefined;
    } });
    await setupAt(f);
    f.answer(declared());
    const confirmed = f.controller.confirm(2);
    assert.equal(seen.length, 0, kind);
    await confirmed;
    await flush();
    assert.equal(seen.length, 1, kind);
    assert.deepEqual([seen[0].mode, seen[0].pending, seen[0].award, seen[0].session], ['declared', false, award, null], kind);
    assert.deepEqual([f.last().mode, f.last().award, f.last().error, f.last().pending], ['declared', award, null, false], kind);
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'confirm:s1:2'], kind);
  }
});

test('bingo suppresses an obsolete confirm answer and its queued hook after an event switch or disposal', async () => {
  for (const change of ['switch-before-reply', 'dispose-before-reply', 'switch-at-render', 'dispose-at-render']) {
    let hooks = 0;
    let armed = false;
    const d = deferred();
    const fresh = deferred();
    let replacement: Promise<unknown> | undefined;
    const f = bingoFixture({}, (state) => {
      if (!armed || state.mode !== 'declared') return;
      armed = false;
      if (change === 'dispose-at-render') f.controller.dispose();
      else {
        f.controller.setEvent('e2', 'line_declared');
        f.controller.setEvent('e1', 'line_declared');
      }
    }, { committed: () => { hooks++; } });
    await setupAt(f);
    f.actions.push(() => d.promise);
    const confirmed = f.controller.confirm(2);
    if (change === 'switch-before-reply') {
      f.controller.setEvent('e2', 'line_declared');
      f.replies.push(() => fresh.promise);
      replacement = f.controller.start();
    } else if (change === 'dispose-before-reply') f.controller.dispose();
    else armed = true;
    const count = f.renders.length;
    d.resolve(declared());
    await confirmed;
    await flush();
    if (change === 'switch-before-reply') {
      const state = f.controller.getState();
      assert.deepEqual([f.renders.length, state.pending, state.mode, state.award], [count, true, 'unknown', null]);
      fresh.resolve({ ok: true, state: 'none' });
      await replacement;
      assert.deepEqual([f.last().eventId, f.last().mode, f.last().pending], ['e2', 'idle', false]);
    } else if (change === 'dispose-before-reply') assert.equal(f.renders.length, count);
    else if (change === 'switch-at-render') {
      assert.deepEqual([f.last().eventId, f.last().mode, f.last().award, f.last().session], ['e1', 'unknown', null, null]);
    } else assert.deepEqual([f.unsubscribed(), f.controller.getState().mode], [1, 'declared']);
    assert.deepEqual([hooks, f.calls.filter((call) => call.startsWith('confirm')).length], [0, 1], change);
  }
});

test('bingo confirm joins and is joined by every pending call, including render and API reentry', async () => {
  for (const source of ['none', 'render', 'api']) {
    const d = deferred();
    let armed = false;
    const joined: Promise<unknown>[] = [];
    const reenter = () => {
      if (!armed) return;
      armed = false;
      joined.push(f.controller.confirm(2), f.controller.confirm(0), f.controller.begin(), f.controller.cancel(),
        f.controller.start());
    };
    const f = bingoFixture({}, () => { if (source === 'render') reenter(); });
    await setupAt(f);
    f.actions.push(() => {
      if (source === 'api') reenter();
      return d.promise;
    });
    armed = true;
    const flight = f.controller.confirm(2);
    const others = [f.controller.confirm(2), f.controller.confirm('x'), f.controller.cancel(), f.controller.start()];
    await flush();
    assert.deepEqual([f.controller.getState().pending, f.controller.getState().error], [true, null], source);
    d.resolve(declared());
    await Promise.all([flight, ...others, ...joined]);
    assert.equal(joined.length, source === 'none' ? 0 : 5, source);
    for (const promise of [...others, ...joined]) assert.equal(promise, flight, source);
    assert.deepEqual([f.calls, f.last().mode], [['subscribe', 'read:0', 'confirm:s1:2'], 'declared'], source);
  }
  const d = deferred();
  const f = bingoFixture();
  await setupAt(f);
  f.replies.push(() => d.promise);
  const read = f.controller.start();
  assert.equal(f.controller.confirm(0), read);
  assert.equal(f.controller.confirm(2), read);
  d.resolve(setup());
  await read;
  assert.deepEqual([f.calls, f.last().error, f.last().mode], [['subscribe', 'read:0', 'read:0'], null, 'setup']);
});

test('bingo confirm phase gates sending after render but never discards a same-event answer after dispatch', async () => {
  let armed = false;
  let hooks = 0;
  const f = bingoFixture({}, () => {
    if (!armed) return;
    armed = false;
    f.controller.setEvent('e1', 'drawing');
  }, { committed: () => { hooks++; } });
  await setupAt(f);
  armed = true;
  await f.controller.confirm(2);
  assert.deepEqual([f.calls, f.last().mode, f.last().session, f.last().pending],
    [['subscribe', 'read:0'], 'setup', session, false]);
  f.controller.setEvent('e1', 'line_declared');
  const d = deferred();
  f.actions.push(() => d.promise);
  const confirmed = f.controller.confirm(2);
  f.controller.setEvent('e1', 'bingo_declared');
  d.resolve(declared());
  await confirmed;
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, f.last().phase, f.last().session, hooks],
    ['declared', award, 'bingo_declared', null, 1]);
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'confirm:s1:2']);
});

test('bingo holds the committed hook while a read started from the settled render is pending, then runs it once', async () => {
  for (const change of ['settle', 'switch', 'dispose']) {
    const seen: State[] = [];
    const d = deferred();
    let armed = false;
    let replacement: Promise<unknown> | undefined;
    const f = bingoFixture({}, (state) => {
      if (!armed || state.mode !== 'declared' || state.pending) return;
      armed = false;
      replacement = f.controller.start();
    }, { committed: () => { seen.push(f.controller.getState()); } });
    await setupAt(f);
    f.answer(declared());
    f.replies.push(() => d.promise);
    armed = true;
    await f.controller.confirm(2);
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual([seen.length, f.controller.getState().pending, f.calls],
      [0, true, ['subscribe', 'read:0', 'confirm:s1:2', 'read:0']], change);
    if (change === 'switch') {
      f.controller.setEvent('e2', 'line_declared');
      f.controller.setEvent('e1', 'line_declared');
    } else if (change === 'dispose') f.controller.dispose();
    d.resolve(declared());
    await replacement;
    await flush();
    const expected = change === 'settle' ? 1 : 0;
    assert.equal(seen.length, expected, change);
    if (expected) assert.deepEqual([seen[0].pending, seen[0].mode, seen[0].award], [false, 'declared', award]);
    f.reply(declared());
    await f.controller.start();
    await flush();
    assert.equal(seen.length, expected, change);
    assert.equal(f.calls.filter((call) => call.startsWith('confirm')).length, 1, change);
  }
});

// F3a: pushes update only a held, trusted award; a read without a setup stages them and reconciles at its answer.
// F3b extends staging to a dispatched confirm and to a read owning a setup; begin and cancel stay bound to their answer.
const at = (status: string, id = 'p1', startedAt: number | null = ['pending', 'failed'].includes(status) ? null : 1000) =>
  ({ ...award, presentation: { id, status, startedAt, deadlineAt: startedAt === null ? null : startedAt + 4000 } });
const declaredAt = async (f: ReturnType<typeof bingoFixture>, value: unknown = at('started')) => {
  f.controller.setEvent('e1', 'bingo_declared');
  f.reply(declared(value));
  await f.controller.start();
};
const reads = (f: ReturnType<typeof bingoFixture>) => f.calls.filter((call) => call !== 'subscribe');

test('bingo held award adopts only legal same-id lifecycle advances from pushes, as clones', async () => {
  let hooks = 0;
  const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
  await declaredAt(f, at('pending'));
  const seen = f.renders.length;
  const started = at('started');
  f.push(started);
  assert.deepEqual([f.last().mode, f.last().award, f.renders.length], ['declared', at('started'), seen + 1]);
  started.presentation.status = 'completed';
  f.last().award.presentation.status = 'failed';
  assert.deepEqual(f.controller.getState().award, at('started'));
  f.push(at('pending'));
  f.push(at('started'));
  assert.equal(f.renders.length, seen + 1);
  f.push(at('completed'));
  f.push(at('started'));
  f.push(at('pending'));
  assert.deepEqual([f.last().mode, f.last().award, f.renders.length], ['declared', at('completed'), seen + 2]);
  for (const [from, to] of [['pending', 'failed'], ['pending', 'interrupted'], ['pending', 'completed']]) {
    const g = bingoFixture();
    await declaredAt(g, at(from));
    g.push(at(to));
    assert.deepEqual([g.last().mode, g.last().award], ['declared', at(to)], to);
  }
  await flush();
  assert.deepEqual([reads(f), hooks], [['read:0'], 0]);
});

test('bingo impossible, conflicting or corrupt pushes fail closed and never unlock the held award', async () => {
  const tied = { ...award.award, lot: 'Jamón', lotResolution: 'pending' };
  const cases: Array<[unknown, unknown]> = [
    [at('started'), at('failed')], [at('failed'), at('started')], [at('completed'), at('interrupted')],
    [at('interrupted'), at('completed')], [at('started'), at('started', 'p1', 2000)],
    [at('started'), at('completed', 'p1', 2000)], [at('completed'), at('started', 'p1', 2000)],
    [at('started'), { ...at('started'), award: { ...award.award, winnerCount: 1, shareCents: 5000 } }],
    [at('started'), { ...at('started'), award: { ...award.award, totalCents: 6000, shareCents: 3000 } }],
    [{ ...at('started'), award: tied }, { ...at('started'), award: { ...tied, lotResolution: 'resolved' } }],
    [at('started'), null], [at('started'), 'x'], [at('started'), {}], [at('started'), { ...at('started'), eventId: '' }],
    [at('started'), { eventId: 'e1', presentation: 'corrupt' }],
    [at('started'), { ...at('started'), presentation: { ...at('started').presentation, status: 'playing' } }],
  ];
  for (const [held, pushed] of cases) {
    const label = JSON.stringify([held, pushed]);
    const f = bingoFixture();
    await declaredAt(f, held);
    f.push(pushed);
    assert.deepEqual([f.last().mode, f.last().award, f.last().pending, typeof f.last().error],
      ['uncertain', null, false, 'string'], label);
    for (const reply of [{ ok: true, state: 'none' }, setup({ ...session })]) {
      f.reply(reply);
      await f.controller.start();
      assert.deepEqual([f.last().mode, f.last().session, f.last().award], ['uncertain', null, null], label);
    }
    f.reply(declared(held));
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().award, reads(f).length], ['declared', held, 4], label);
  }
});

test('bingo pushes without a trusted award, a known event or a live controller change nothing', async () => {
  const f = bingoFixture();
  const quiet = (label: string) => {
    const seen = f.renders.length;
    const before = f.controller.getState();
    for (const value of [at('started'), at('completed'), null, { eventId: 'e1' }]) f.push(value);
    assert.deepEqual([f.renders.length, f.controller.getState()], [seen, before], label);
  };
  quiet('no event');
  f.controller.setEvent('e1', 'drawing');
  quiet('unknown');
  await f.controller.start();
  quiet('idle');
  f.reply(setup());
  await f.controller.start();
  quiet('setup');
  f.reply(failure('storage_failure', 'Later.'));
  await f.controller.start();
  quiet('uncertain');
  await declaredAt(f);
  const seen = f.renders.length;
  f.push({ ...at('completed'), eventId: 'e2' });
  f.push({ ...at('failed', 'p9'), eventId: 'e2' });
  assert.deepEqual([f.renders.length, f.last().mode, f.last().award], [seen, 'declared', at('started')]);
  f.controller.dispose();
  f.push(at('completed'));
  f.push(null);
  assert.deepEqual([f.renders.length, f.controller.getState().award], [seen, at('started')]);
  assert.deepEqual(reads(f), ['read:0', 'read:0', 'read:0', 'read:0']);
});

test('bingo treats a different pushed id as ambiguous; only an explicit read replaces it and retires the old', async () => {
  const f = bingoFixture();
  await declaredAt(f);
  f.push(at('pending', 'p2'));
  assert.deepEqual([f.last().mode, f.last().award, reads(f)], ['uncertain', null, ['read:0']]);
  f.push(at('completed'));
  assert.deepEqual([f.last().mode, f.last().award], ['uncertain', null]);
  f.reply(declared(at('pending', 'p2')));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award], ['declared', at('pending', 'p2')]);
  const seen = f.renders.length;
  f.push(at('completed'));
  f.push(at('interrupted'));
  assert.deepEqual([f.renders.length, f.last().award], [seen, at('pending', 'p2')]);
  f.reply(declared(at('completed')));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award], ['uncertain', null]);
  f.push(at('started', 'p2'));
  f.reply(declared(at('pending', 'p2')));
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award, reads(f).length], ['declared', at('started', 'p2'), 4]);
});

test('bingo read without a setup stages pushes and reconciles them with its answer', async () => {
  const none = { ok: true, state: 'none' };
  // [held award or null, pushes during the read, answer, expected award or null for uncertain]
  const cases: Array<[unknown, unknown[], unknown, unknown]> = [
    [null, [at('started')], none, null], [null, [at('started')], setup(), null],
    [null, [at('started')], failure('storage_failure', 'Later.'), null], [null, [at('started')], null, null],
    [null, [at('started')], { ok: true, state: 'mystery' }, null],
    [null, [at('completed')], declared(at('pending')), at('completed')],
    [null, [at('pending')], declared(at('started')), at('started')],
    [null, [at('started'), at('pending', 'p2')], declared(at('pending', 'p2')), null],
    [null, [at('started')], declared(at('failed')), null], [null, [null], declared(at('started')), null],
    [null, [{ eventId: 'e1', presentation: 'x' }], declared(at('started')), null],
    [null, [{ ...at('completed'), eventId: 'e2' }], declared(at('started')), at('started')],
    [at('started'), [at('pending', 'p2')], declared(at('started', 'p2')), at('started', 'p2')],
    [at('started'), [at('pending', 'p2')], declared(at('started')), null],
    [at('started'), [at('completed')], none, null], [at('started'), [at('completed')], null, null],
    [at('started'), [at('completed')], declared(at('started')), at('completed')],
    [at('started'), [at('interrupted')], declared(at('completed')), null],
  ];
  for (const [held, pushes, answer, expected] of cases) {
    const label = JSON.stringify([held, pushes, answer]);
    const d = deferred();
    const f = bingoFixture();
    if (held === null) f.controller.setEvent('e1', 'bingo_declared');
    else await declaredAt(f, held);
    f.replies.push(() => d.promise);
    const read = f.controller.start();
    const state = f.controller.getState();
    const seen = f.renders.length;
    for (const value of pushes) f.push(value);
    assert.deepEqual([f.renders.length, f.controller.getState()], [seen, state], label);
    d.resolve(answer);
    await read;
    assert.deepEqual([f.last().mode, f.last().award, f.last().pending],
      [expected === null ? 'uncertain' : 'declared', expected, false], label);
    if (expected !== null) continue;
    // A held award or a valid observation stays a known commit: a later none never unlocks it. Null or corrupt
    // evidence only failed this read closed.
    f.reply(none);
    await f.controller.start();
    const known = held !== null || pushes.some((value: any) => value?.eventId === 'e1' && value.presentation?.id === 'p1');
    assert.equal(f.last().mode, known ? 'uncertain' : 'idle', label);
  }
});

test('bingo pushes never settle an action or a setup read, nor consume its session or flight', async () => {
  for (const kind of ['begin', 'cancel', 'confirm', 'read']) {
    let hooks = 0;
    const d = deferred();
    const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
    if (kind === 'begin') await idleAt(f);
    else await setupAt(f);
    if (kind === 'read') f.replies.push(() => d.promise);
    else f.actions.push(() => d.promise);
    const flight = kind === 'read' ? f.controller.start() : f.controller[kind](2);
    const state = f.controller.getState();
    const seen = f.renders.length;
    for (const value of [at('completed'), at('pending', 'p2'), null, { eventId: 'e1' }]) f.push(value);
    assert.deepEqual([f.renders.length, f.controller.getState(), state.pending], [seen, state, true], kind);
    d.resolve({ begin: setup(), cancel: { ok: true, state: 'cancelled' }, confirm: declared(), read: setup() }[kind]);
    await flight;
    await flush();
    // Begin and cancel follow their answer alone. The owned confirm commits but the conflicting observations keep it
    // uncertain; the contradicted setup read keeps its session.
    const expected = { begin: ['setup', session, null], cancel: ['idle', null, null], confirm: ['uncertain', null, null],
      read: ['uncertain', session, null] }[kind];
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, f.last().pending], [...expected, false], kind);
    assert.equal(hooks, kind === 'confirm' ? 1 : 0, kind);
  }
});

test('bingo event switches clear held, staged and retired ids; push renders join reads and refresh nothing', async () => {
  let hooks = 0;
  let reenter = false;
  const joined: Promise<unknown>[] = [];
  const d = deferred();
  const f = bingoFixture({}, () => {
    if (!reenter) return;
    reenter = false;
    joined.push(f.controller.start(), f.controller.start());
  }, { committed: () => { hooks++; } });
  await declaredAt(f);
  f.push(at('pending', 'p2'));
  f.reply(declared(at('pending', 'p2')));
  await f.controller.start();
  f.controller.setEvent('e2', 'drawing');
  f.controller.setEvent('e1', 'bingo_declared');
  const seen = f.renders.length;
  f.push(at('completed', 'p2'));
  assert.deepEqual([f.renders.length, f.last().mode], [seen, 'unknown']);
  f.reply(declared());
  await f.controller.start();
  assert.deepEqual([f.last().mode, f.last().award], ['declared', award]);
  f.replies.push(() => d.promise);
  reenter = true;
  f.push(at('completed'));
  assert.deepEqual([joined.length, joined[0] === joined[1], f.controller.getState().pending], [2, true, true]);
  f.push(at('interrupted'));
  f.controller.setEvent('e2', 'drawing');
  assert.deepEqual([f.last().pending, f.last().mode], [false, 'unknown']);
  d.resolve(declared(at('completed')));
  await Promise.all(joined);
  f.controller.setEvent('e1', 'bingo_declared');
  await f.controller.start();
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, hooks], ['idle', null, 0]);
  assert.deepEqual(reads(f), ['read:0', 'read:0', 'read:0', 'read:0', 'read:0']);
});

test('bingo keeps a compatible advance seen during a failed read, so later answers cannot regress or conflict', async () => {
  const lost = [{ ok: true, state: 'none' }, setup(), failure('storage_failure', 'Later.'), null, { ok: true, state: 'x' },
    'reject', declared(at('pending', 'p2')), declared({ ...at('started'), award: { ...award.award, lot: 'Jamón' } })];
  for (const answer of lost) {
    const label = JSON.stringify(answer);
    const d = deferred();
    const f = bingoFixture();
    await declaredAt(f);
    f.replies.push(() => d.promise);
    const read = f.controller.start();
    const completed = at('completed');
    f.push(completed);
    completed.presentation.startedAt = 9;
    assert.deepEqual([f.controller.getState().pending, f.controller.getState().award], [true, at('started')], label);
    if (answer === 'reject') d.reject(new Error('lost'));
    else d.resolve(answer);
    await read;
    assert.deepEqual([f.last().mode, f.last().award, f.last().pending], ['uncertain', null, false], label);
    f.reply(declared(at('started')));
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().award], ['declared', at('completed')], label);
    for (const [reply, mode, shown] of [[at('interrupted'), 'uncertain', null], [at('completed'), 'declared', at('completed')]]) {
      f.reply(declared(reply));
      await f.controller.start();
      assert.deepEqual([f.last().mode, f.last().award], [mode, shown], label);
    }
    assert.equal(reads(f).length, 5, label);
  }
});

// F3b: a dispatched confirm stages pushes; only its exact answer commits, owes one refresh and sets the held award.
const confirmFixture = async () => {
  const hooks = { count: 0 };
  const d = deferred();
  const f = bingoFixture({}, () => {}, { committed: () => { hooks.count++; } });
  await setupAt(f);
  f.actions.push(() => d.promise);
  return { f, d, hooks, confirmed: f.controller.confirm(2) };
};

test('bingo confirm merges same-id pushes before or after its exact answer and owes one refresh', async () => {
  for (const order of ['before', 'after']) {
    const { f, d, hooks, confirmed } = await confirmFixture();
    const completed = at('completed');
    if (order === 'before') {
      f.push(at('started'));
      f.push(completed);
      completed.presentation.status = 'interrupted';
      assert.deepEqual([f.controller.getState().mode, f.controller.getState().pending, hooks.count], ['setup', true, 0]);
    }
    d.resolve(declared(at('pending')));
    await confirmed;
    if (order === 'after') {
      f.push(at('started'));
      f.push(completed);
    }
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().error, hooks.count],
      ['declared', at('completed'), null, null, 1], order);
    f.push(at('completed'));
    f.push(at('started'));
    f.reply(declared(at('pending')));
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, hooks.count], ['declared', at('completed'), 1], order);
    assert.deepEqual(f.calls, ['subscribe', 'read:0', 'confirm:s1:2', 'read:0'], order);
  }
});

test('bingo exact confirm commits once and stays locked when pushes conflict before or after it', async () => {
  const conflicts = [null, { eventId: 'e1', presentation: 'x' }, at('failed'), at('started', 'p1', 2000),
    { ...at('started'), award: { ...award.award, lot: 'Jamón', lotResolution: 'pending' } }, at('pending', 'p2')];
  for (const order of ['before', 'after']) {
    for (const pushed of conflicts) {
      const label = `${order}:${JSON.stringify(pushed)}`;
      const { f, d, hooks, confirmed } = await confirmFixture();
      if (order === 'before') f.push(pushed);
      d.resolve(declared());
      await confirmed;
      if (order === 'after') f.push(pushed);
      await flush();
      assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().pending, hooks.count],
        ['uncertain', null, null, false, 1], label);
      for (const reply of [{ ok: true, state: 'none' }, setup()]) {
        f.reply(reply);
        await f.controller.start();
        assert.deepEqual([f.last().mode, f.last().session], ['uncertain', null], label);
      }
      await f.controller.confirm(2);
      f.reply(declared());
      await f.controller.start();
      await flush();
      assert.deepEqual([f.last().mode, f.last().award, hooks.count], ['declared', award, 1], label);
      assert.equal(f.calls.filter((call) => call.startsWith('confirm')).length, 1, label);
    }
  }
});

test('bingo invalid, lost or refused confirm answers owe nothing even beside a convincing push', async () => {
  const replies: Array<[unknown, string, unknown]> = [
    [declared({ ...award, award: { ...award.award, winnerCount: 1, shareCents: 5000 } }), 'uncertain', session],
    [declared({ ...award, eventId: 'e2' }), 'uncertain', session], [{ ...declared(), extra: 1 }, 'uncertain', session],
    [null, 'uncertain', session], [failure('storage_failure', 'Later.'), 'uncertain', session],
    [failure('stale_session', 'Gone.'), 'uncertain', null], [failure('tongo_active', 'Tongo.'), 'setup', session],
  ];
  for (const [reply, mode, kept] of replies) {
    const label = JSON.stringify(reply);
    const { f, d, hooks, confirmed } = await confirmFixture();
    f.push(declared().award);
    f.push(at('completed'));
    d.resolve(reply);
    await confirmed;
    await flush();
    assert.deepEqual([f.last().mode, f.last().session, f.last().award, hooks.count], [mode, kept, null, 0], label);
    // Only an explicit read recovers, never a retransmit; an observed award stays known so a setup cannot unlock it.
    if (mode === 'uncertain') await f.controller.confirm(2);
    f.reply(setup());
    await f.controller.start();
    assert.equal(f.last().mode, mode === 'setup' ? 'setup' : 'uncertain', label);
    f.reply(declared(at('pending')));
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, hooks.count],
      ['declared', mode === 'setup' ? at('pending') : at('completed'), null, 0], label);
    assert.equal(f.calls.filter((call) => call.startsWith('confirm')).length, 1, label);
  }
});

test('bingo ignores pushes before confirm dispatch and keeps a contradicted setup read owning its session', async () => {
  let hooks = 0;
  let armed = false;
  const f = bingoFixture({}, () => {
    if (!armed) return;
    armed = false;
    f.push(at('completed'));
    f.push(null);
  }, { committed: () => { hooks++; } });
  await setupAt(f);
  armed = true;
  f.answer(declared());
  await f.controller.confirm(2);
  await flush();
  assert.deepEqual([f.last().mode, f.last().award, hooks], ['declared', award, 1]);
  const g = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
  await setupAt(g);
  const d = deferred();
  g.replies.push(() => d.promise);
  const read = g.controller.start();
  g.push(at('started'));
  d.resolve(setup());
  await read;
  assert.deepEqual([g.last().mode, g.last().session, g.last().award], ['uncertain', session, null]);
  await g.controller.confirm(2);
  await g.controller.cancel();
  await g.controller.begin();
  assert.deepEqual(g.calls, ['subscribe', 'read:0', 'read:0']);
  g.reply(declared(at('pending')));
  await g.controller.start();
  await flush();
  assert.deepEqual([g.last().mode, g.last().award, g.last().session, hooks], ['declared', at('started'), null, 1]);
});

test('bingo confirm staging dies with its event or controller; API reentry joins the live confirm', async () => {
  for (const change of ['switch', 'dispose', 'reenter']) {
    const hooks = { count: 0 };
    const d = deferred();
    let joined: Promise<unknown> | undefined;
    const f = bingoFixture({}, () => {}, { committed: () => { hooks.count++; } });
    await setupAt(f);
    f.actions.push(() => {
      if (change === 'reenter') {
        joined = f.controller.start();
        f.push(at('completed'));
      }
      return d.promise;
    });
    const confirmed = f.controller.confirm(2);
    if (change !== 'reenter') f.push(at('completed'));
    if (change === 'switch') {
      f.controller.setEvent('e2', 'line_declared');
      f.controller.setEvent('e1', 'line_declared');
    } else if (change === 'dispose') f.controller.dispose();
    const seen = f.renders.length;
    d.resolve(declared());
    await confirmed;
    await flush();
    if (change === 'reenter') {
      assert.equal(joined, confirmed);
      assert.deepEqual([f.last().mode, f.last().award, hooks.count], ['declared', at('completed'), 1]);
      continue;
    }
    assert.deepEqual([f.renders.length, hooks.count], [seen, 0], change);
    if (change === 'dispose') continue;
    f.push(at('completed'));
    assert.deepEqual([f.last().mode, f.last().award, f.last().session, f.last().pending], ['unknown', null, null, false]);
    await f.controller.start();
    assert.equal(f.last().mode, 'idle');
  }
});

// G1a/G1b: explicit retry of the shown failed award and repeat of the shown interrupted one, only behind fresh clear
// guards. Only the exact answer rotates to the new id main returns; pushes alone never rotate, and nothing reads or
// acts by itself.
const clear = { tongoPlaying: false, presentationBusy: false, otherSetupActive: false };
const manualAt = async (f: ReturnType<typeof bingoFixture>, status = 'failed') => {
  await declaredAt(f, at(status));
  f.controller.setGuards(clear);
};
const sent = (f: ReturnType<typeof bingoFixture>) => f.calls.filter((call) => /^(retry|repeat)/.test(call));
const none = { ok: true, state: 'none' };
const kinds = [['retry', 'failed'], ['repeat', 'interrupted']] as const;

test('bingo setGuards is synchronous and side-effect free, and manual actions need every guard freshly false', async () => {
  const f = bingoFixture();
  await declaredAt(f, at('failed'));
  const before = f.controller.getState();
  const seen = f.renders.length;
  await f.controller.retry('p1');
  const throwing = { get tongoPlaying() { throw new Error('getter'); }, presentationBusy: false, otherSetupActive: false };
  const unknown = [undefined, null, 'clear', [], {}, throwing, { tongoPlaying: false, presentationBusy: false },
    { ...clear, tongoPlaying: true }, { ...clear, presentationBusy: true }, { ...clear, otherSetupActive: true },
    { ...clear, tongoPlaying: 0 }, { ...clear, presentationBusy: 'false' }, { ...clear, otherSetupActive: new Boolean(false) }];
  for (const guards of unknown) {
    f.controller.setGuards(clear);
    assert.equal(f.controller.setGuards(guards), undefined);
    await f.controller.retry('p1');
  }
  await flush();
  assert.deepEqual([f.calls, f.renders.length, f.controller.getState()], [['subscribe', 'read:0'], seen, before]);
  f.controller.setGuards(clear);
  assert.equal(f.renders.length, seen);
  f.answer(declared(at('pending', 'p2')));
  await f.controller.retry('p1');
  assert.deepEqual([sent(f), f.last().mode, f.last().award], [['retry:p1'], 'declared', at('pending', 'p2')]);
});

test('bingo manual actions admit only the exact shown id and status, bingo_declared and no setup', async () => {
  type Case = [string, (f: ReturnType<typeof bingoFixture>) => Promise<unknown>, (f: ReturnType<typeof bingoFixture>) => unknown];
  const cases: Case[] = [];
  for (const id of ['p2', ' p1', 'P1', '', 'p'.repeat(65), new String('p1'), ['p1'], undefined, 1]) {
    cases.push([`id ${String(id)}`, (f) => manualAt(f), (f) => f.controller.retry(id)]);
  }
  for (const status of ['pending', 'started', 'completed', 'interrupted']) {
    cases.push([`retry ${status}`, (f) => manualAt(f, status), (f) => f.controller.retry('p1')]);
  }
  for (const status of ['pending', 'started', 'completed', 'failed']) {
    cases.push([`repeat ${status}`, (f) => manualAt(f, status), (f) => f.controller.repeat('p1')]);
  }
  // A phase or event change resets the guards, so fresh clear guards are sent again to isolate the gate under test.
  for (const phase of ['drawing', 'line_declared', 'checking_bingo', null]) {
    cases.push([`phase ${phase}`, async (f) => {
      await manualAt(f);
      f.controller.setEvent('e1', phase);
      f.controller.setGuards(clear);
    }, (f) => f.controller.retry('p1')]);
  }
  cases.push(['uncertain', async (f) => { await manualAt(f); f.push(at('started')); }, (f) => f.controller.retry('p1')]);
  cases.push(['other event', async (f) => {
    await manualAt(f);
    f.controller.setEvent('e2', 'bingo_declared');
    f.controller.setGuards(clear);
  }, (f) => f.controller.retry('p1')]);
  cases.push(['owned setup', async (f) => { await setupAt(f, 'bingo_declared'); f.controller.setGuards(clear); },
    (f) => f.controller.retry('p1')]);
  cases.push(['idle', async (f) => { await idleAt(f, 'bingo_declared'); f.controller.setGuards(clear); },
    (f) => f.controller.repeat('p1')]);
  for (const [label, prepare, call] of cases) {
    const f = bingoFixture();
    await prepare(f);
    const before = f.controller.getState();
    const calls = [...f.calls];
    const seen = f.renders.length;
    await call(f);
    await flush();
    assert.deepEqual([f.calls, f.renders.length, f.controller.getState()], [calls, seen, before], label);
  }
});

test('bingo manual actions without their bridge show an error, never dispatch and keep reads usable', async () => {
  for (const bridge of [undefined, null, 'nope']) {
    for (const [kind, status] of [['retry', 'failed'], ['repeat', 'interrupted']] as const) {
      const f = bingoFixture({ retryBingoPresentation: bridge, repeatBingoPresentation: bridge });
      await manualAt(f, status);
      await f.controller[kind]('p1');
      assert.deepEqual([f.last().mode, f.last().award, f.last().pending, typeof f.last().error],
        ['declared', at(status), false, 'string'], kind);
      f.reply(declared(at(status)));
      await f.controller.start();
      assert.deepEqual([f.last().mode, f.last().award, f.last().error, f.calls], ['declared', at(status), null,
        ['subscribe', 'read:0', 'read:0']], kind);
    }
  }
});

test('bingo guards reset on every event or phase change, so only a fresh complete update permits one retry', async () => {
  const shownIn = (eventId: string, status: string) => ({ ...at(status), eventId });
  const readIn = async (f: ReturnType<typeof bingoFixture>, eventId: string, status: string) => {
    f.controller.setEvent(eventId, 'bingo_declared');
    f.reply(declared(shownIn(eventId, status)));
    await f.controller.start();
  };
  const changes: Record<string, (f: ReturnType<typeof bingoFixture>, status: string) => Promise<unknown>> = {
    'A->B': (f, status) => readIn(f, 'e2', status),
    'A->B->A': async (f, status) => { f.controller.setEvent('e2', 'bingo_declared'); await readIn(f, 'e1', status); },
    'ineligible phase': async (f) => { f.controller.setEvent('e1', 'drawing'); f.controller.setEvent('e1', 'bingo_declared'); },
    'unknown phase': async (f) => { f.controller.setEvent('e1', null); f.controller.setEvent('e1', 'bingo_declared'); },
  };
  for (const [kind, status] of kinds) for (const [name, change] of Object.entries(changes)) {
    const label = `${kind}:${name}`;
    const f = bingoFixture();
    await declaredAt(f, at(status));
    await f.controller[kind]('p1');
    f.controller.setGuards(clear);
    await change(f, status);
    const eventId = f.last().eventId as string;
    assert.deepEqual([f.last().mode, f.last().award], ['declared', shownIn(eventId, status)], label);
    await f.controller[kind]('p1');
    f.controller.setGuards({ tongoPlaying: false, presentationBusy: false });
    await f.controller[kind]('p1');
    assert.deepEqual(sent(f), [], label);
    f.controller.setGuards(clear);
    f.answer(declared({ ...at('pending', 'p2'), eventId }));
    await f.controller[kind]('p1');
    await f.controller[kind]('p1');
    assert.deepEqual([sent(f), f.last().mode, f.last().award], [[`${kind}:p1`], 'declared', { ...at('pending', 'p2'), eventId }],
      label);
  }
});

test('bingo manual actions recheck every gate after render and every competing call joins the actual flight', async () => {
  const changes: Record<string, (f: ReturnType<typeof bingoFixture>) => void> = {
    busy: (f) => f.controller.setGuards({ ...clear, presentationBusy: true }),
    tongo: (f) => f.controller.setGuards({ ...clear, tongoPlaying: true }),
    omitted: (f) => f.controller.setGuards({ tongoPlaying: false, presentationBusy: false }),
    phase: (f) => f.controller.setEvent('e1', 'drawing'),
    switch: (f) => { f.controller.setEvent('e2', 'bingo_declared'); f.controller.setEvent('e1', 'bingo_declared'); },
    dispose: (f) => f.controller.dispose(),
  };
  for (const [kind, status] of kinds) for (const [name, change] of Object.entries(changes)) {
    let armed = false;
    const f = bingoFixture({}, () => {
      if (!armed) return;
      armed = false;
      change(f);
    });
    await manualAt(f, status);
    armed = true;
    await f.controller[kind]('p1');
    await flush();
    assert.deepEqual(sent(f), [], `${kind}:${name}`);
    if (name !== 'dispose') assert.deepEqual([f.last().pending, f.last().error], [false, null], name);
  }
  // Only the exact shown failed id, with no owned setup; a missing bridge shows an error and reads stay usable.
  for (const [status, id] of [['failed', 'p2'], ['failed', ' p1'], ['failed', new String('p1')], ['interrupted', 'p1'],
    ['completed', 'p1'], ['setup', 'p1']] as const) {
    const f = bingoFixture();
    if (status === 'setup') {
      await setupAt(f, 'bingo_declared');
      f.controller.setGuards(clear);
    } else await manualAt(f, status);
    const before = f.controller.getState();
    await f.controller.retry(id);
    assert.deepEqual([sent(f), f.controller.getState()], [[], before], `${status}:${String(id)}`);
  }
  const g = bingoFixture({ retryBingoPresentation: undefined });
  await manualAt(g);
  await g.controller.retry('p1');
  assert.deepEqual([g.last().mode, g.last().award, g.last().pending, typeof g.last().error],
    ['declared', at('failed'), false, 'string']);
  g.reply(declared(at('failed')));
  await g.controller.start();
  assert.deepEqual([g.last().mode, g.last().error, g.calls], ['declared', null, ['subscribe', 'read:0', 'read:0']]);
  for (const [source, kind, status] of [['none', 'retry', 'failed'], ['render', 'retry', 'failed'], ['api', 'retry', 'failed'],
    ['render', 'repeat', 'interrupted'], ['api', 'repeat', 'interrupted']] as const) {
    const d = deferred();
    let armed = false;
    const joined: Promise<unknown>[] = [];
    const reenter = () => {
      if (!armed) return;
      armed = false;
      joined.push(f.controller.retry('p1'), f.controller.retry('p2'), f.controller.retry('zz'), f.controller.start(),
        f.controller.begin(), f.controller.confirm(2), f.controller.cancel(), f.controller.repeat('p1'));
    };
    const f = bingoFixture({}, () => { if (source === 'render') reenter(); });
    await manualAt(f, status);
    f.actions.push(() => {
      if (source === 'api') reenter();
      return d.promise;
    });
    armed = true;
    const flight = f.controller[kind]('p1');
    const others = [f.controller.retry('p1'), f.controller.retry(undefined), f.controller.start(), f.controller.repeat('p1'),
      f.controller.repeat(undefined)];
    await flush();
    assert.deepEqual([f.controller.getState().pending, f.controller.getState().mode], [true, 'declared'], source);
    d.resolve(declared(at('pending', 'p2')));
    await Promise.all([flight, ...others, ...joined]);
    assert.equal(joined.length, source === 'none' ? 0 : 8, source);
    for (const promise of [...others, ...joined]) assert.equal(promise, flight, source);
    assert.deepEqual([f.calls, f.last().mode, f.last().award], [['subscribe', 'read:0', `${kind}:p1`], 'declared',
      at('pending', 'p2')], source);
  }
});

test('bingo manual rotation adopts the exact new id, merges its pushes and retires the source id', async () => {
  for (const [kind, status] of kinds) for (const order of ['before', 'after', 'reverse']) {
    const label = `${kind}:${order}`;
    let hooks = 0;
    const args: unknown[][] = [];
    const d = deferred();
    const f = bingoFixture({ [`${kind}BingoPresentation`]: (...given: unknown[]) => { args.push(given); return d.promise; } },
      () => {}, { committed: () => { hooks++; } });
    await manualAt(f, status);
    const flight = f.controller[kind]('p1');
    const values = [at(status), at('pending', 'p2'), at('started', 'p2')];
    // Reverse: the returned id's started push arrives first, then the compatible source push, then the pending reply.
    const pushes = () => (order === 'reverse' ? values.reverse() : values).forEach((value) => f.push(value));
    if (order !== 'after') {
      const state = f.controller.getState();
      pushes();
      assert.deepEqual(f.controller.getState(), state, label);
    }
    const reply = declared(at('pending', 'p2'));
    d.resolve(reply);
    await flight;
    (reply.award as any).presentation.status = status;
    if (order === 'after') pushes();
    await flush();
    assert.deepEqual([args, f.last().mode, f.last().award, f.last().error, hooks],
      [[['p1']], 'declared', at('started', 'p2'), null, 0], label);
    f.last().award.presentation.id = 'p1';
    // The retired source is ignored and unreachable; only an explicit read moves on, and it never redeclares.
    const seen = f.renders.length;
    f.push(at(status));
    f.push(at('started'));
    await f.controller[kind]('p1');
    await f.controller[kind]('p2');
    assert.deepEqual([f.renders.length, f.controller.getState().award, args.length], [seen, at('started', 'p2'), 1], label);
    f.reply(declared(at(status)));
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().award], ['uncertain', null], label);
    f.reply(declared(at('pending', 'p2')));
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, args.length, reads(f).length, hooks],
      ['declared', at('started', 'p2'), 1, 3, 0], label);
  }
});

test('bingo manual answer rotates despite ambiguous evidence but stays uncertain, never guessing an order', async () => {
  // The last case pushes the returned id first, then an incompatible source observation.
  const evidence = [[at('pending', 'p3')], [null], [{ eventId: 'e1', presentation: 'x' }], [at('started')],
    [{ ...at('failed'), award: { ...award.award, lot: 'Jamón', lotResolution: 'pending' } }], [at('started', 'p2', 2000)],
    [at('failed', 'p2')], [{ ...at('started', 'p2'), award: { ...award.award, winnerCount: 1, shareCents: 5000 } }],
    [at('started', 'p2'), at('started')]];
  for (const pushes of evidence) {
    const label = JSON.stringify(pushes);
    let hooks = 0;
    const d = deferred();
    const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
    await manualAt(f);
    f.actions.push(() => d.promise);
    const flight = f.controller.retry('p1');
    pushes.forEach((value) => f.push(value));
    d.resolve(declared(at('started', 'p2')));
    await flight;
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, f.last().pending, typeof f.last().error, hooks],
      ['uncertain', null, false, 'string', 0], label);
    for (const reply of [none, setup()]) {
      f.reply(reply);
      await f.controller.start();
      assert.deepEqual([f.last().mode, f.last().session], ['uncertain', null], label);
    }
    await f.controller.retry('p1');
    await f.controller.retry('p2');
    // The returned id is the held anchor and the source is retired, whatever arrived first.
    f.reply(declared(at('failed')));
    await f.controller.start();
    assert.equal(f.last().mode, 'uncertain', label);
    f.reply(declared(at('started', 'p2')));
    await f.controller.start();
    await flush();
    assert.deepEqual([f.last().mode, f.last().award, sent(f), hooks], ['declared', at('started', 'p2'), ['retry:p1'], 0],
      label);
  }
});

test('bingo manual refusals keep the old award; lost, invalid or same-id answers stay uncertain on the old id', async () => {
  const p2 = at('pending', 'p2');
  const answers: Array<[(() => unknown) | 'same', boolean]> = [
    ...['invalid_request', 'not_available', 'setup_active', 'tongo_active', 'presentation_busy', 'presentation_refused']
      .map((code): [() => unknown, boolean] => [async () => failure(code, `No ${code}.`), true]),
    [async () => failure('storage_failure', 'Later.'), false], [() => Promise.reject(new Error('lost')), false],
    [() => { throw new Error('sync'); }, false], [async () => null, false], [async () => ({ ok: true }), false],
    [async () => none, false], [async () => ({ ...declared(p2), extra: 1 }), false],
    [async () => declared({ ...p2, eventId: 'e2' }), false],
    [async () => declared({ ...p2, award: { ...award.award, totalCents: 6000, shareCents: 3000 } }), false],
    [async () => declared({ ...p2, presentation: { ...p2.presentation, status: 'playing' } }), false],
    // The same id as the source, for either action.
    ['same', false], [async () => failure('stale_session', 'Gone.'), false],
    [async () => failure('mystery', 'Hm.'), false], [async () => failure('not_available', ' '), false],
  ];
  for (const [answer, refused] of answers) {
    for (const [kind, status] of kinds) for (const push of [false, true]) {
      const label = `${kind}:${String(answer)}:${push}`;
      let hooks = 0;
      const f = bingoFixture({}, () => {}, { committed: () => { hooks++; } });
      await manualAt(f, status);
      f.actions.push(() => {
        if (push) f.push(at('started', 'p2'));
        return answer === 'same' ? declared(at(status)) : (answer as () => unknown)();
      });
      await f.controller[kind]('p1');
      await flush();
      const shown = refused && !push;
      assert.deepEqual([f.last().mode, f.last().award, f.last().pending, typeof f.last().error],
        [shown ? 'declared' : 'uncertain', shown ? at(status) : null, false, 'string'], label);
      if (refused) assert.match(f.last().error as string, /^No /, label);
      await f.controller[kind]('p1');
      if (!shown) {
        f.reply(none);
        await f.controller.start();
        assert.equal(f.last().mode, 'uncertain', label);
      }
      // A push alone never rotated: the old id still settles an explicit read.
      f.reply(declared(at(status)));
      await f.controller.start();
      await flush();
      assert.deepEqual([f.last().mode, f.last().award, sent(f).length, hooks], ['declared', at(status), shown ? 2 : 1, 0],
        label);
    }
  }
  // An answer with a retired id rotates nothing.
  for (const [kind, status] of kinds) {
    const f = bingoFixture();
    await manualAt(f, status);
    f.answer(declared(p2));
    await f.controller[kind]('p1');
    f.push(at(status, 'p2'));
    f.answer(declared(at('pending')));
    await f.controller[kind]('p2');
    assert.deepEqual([f.last().mode, f.last().award, sent(f)], ['uncertain', null, [`${kind}:p1`, `${kind}:p2`]], kind);
    f.reply(declared(at(status, 'p2')));
    await f.controller.start();
    assert.deepEqual([f.last().mode, f.last().award], ['declared', at(status, 'p2')], kind);
  }
});

test('bingo manual answers die with their event or controller, and a later phase change never discards one', async () => {
  for (const [kind, status] of kinds) for (const change of ['switch', 'dispose', 'phase']) {
    const d = deferred();
    const fresh = deferred();
    let replacement: Promise<unknown> | undefined;
    const f = bingoFixture();
    await manualAt(f, status);
    f.actions.push(() => d.promise);
    const flight = f.controller[kind]('p1');
    f.push(at('pending', 'p2'));
    if (change === 'switch') {
      f.controller.setEvent('e2', 'bingo_declared');
      f.controller.setEvent('e1', 'bingo_declared');
      f.replies.push(() => fresh.promise);
      replacement = f.controller.start();
    } else if (change === 'dispose') f.controller.dispose();
    else f.controller.setEvent('e1', 'drawing');
    const seen = f.renders.length;
    const before = f.controller.getState();
    d.resolve(declared(at('pending', 'p2')));
    await flight;
    await flush();
    if (change === 'phase') {
      assert.deepEqual([f.last().mode, f.last().award, f.last().phase], ['declared', at('pending', 'p2'), 'drawing']);
      continue;
    }
    assert.deepEqual([f.renders.length, f.controller.getState()], [seen, before], change);
    if (change === 'dispose') continue;
    assert.deepEqual([before.pending, before.mode], [true, 'unknown']);
    fresh.resolve(declared(at(status)));
    await replacement;
    assert.deepEqual([f.last().mode, f.last().award, sent(f)], ['declared', at(status), [`${kind}:p1`]], change);
  }
});

// G2: the legacy check's detached identity, read only when asked, from a fixture already in e1 checking_bingo.
const check = { eventId: 'e1', phase: 'checking_bingo', auditSequence: 7, lastTransitionAt: '2024-05-01T10:00:00.000Z' };
const legacyCheck = (value: unknown = check) => ({ ok: true, state: 'legacy_check', check: value });
const noLegacy = { status: 'none', check: null };
function legacyFixture(answers: Array<() => unknown> = [], onRender?: (state: State) => void) {
  const f = bingoFixture({ readLegacyBingoCheck: (...args: unknown[]) => {
    f.calls.push(`legacy:${args.length}`);
    return (answers.shift() ?? (async () => legacyCheck()))();
  } }, onRender);
  f.controller.setEvent('e1', 'checking_bingo');
  return { ...f, answers };
}

test('bingo legacy check reads only when asked and exposes an isolated four-field identity', async () => {
  const f = legacyFixture();
  assert.deepEqual(f.last().legacy, noLegacy);
  await f.controller.start();
  f.push(null);
  f.controller.setEvent('e1', 'checking_bingo');
  f.controller.setGuards({ tongoPlaying: false, presentationBusy: false, otherSetupActive: false });
  await flush();
  assert.deepEqual(f.calls, ['subscribe', 'read:0']);
  const reply = { ...check };
  f.answers.push(async () => legacyCheck(reply));
  await f.controller.checkLegacy();
  reply.auditSequence = 8;
  assert.deepEqual([f.last().mode, f.last().pending, f.last().error, f.last().legacy],
    ['idle', false, null, { status: 'available', check }]);
  f.last().legacy.check.auditSequence = 99;
  f.controller.getState().legacy.check.eventId = 'e2';
  assert.deepEqual(f.controller.getState().legacy, { status: 'available', check });
  assert.notEqual(f.controller.getState().legacy.check, f.controller.getState().legacy.check);
  await flush();
  assert.deepEqual(f.calls, ['subscribe', 'read:0', 'legacy:0']);
});

test('bingo legacy not_available is none; failures, foreign or malformed answers are uncertain without authority', async () => {
  const f = legacyFixture();
  await f.controller.checkLegacy();
  f.answers.push(async () => failure('not_available', 'There is no legacy Bingo check to recover.'));
  await f.controller.checkLegacy();
  assert.deepEqual([f.last().legacy, f.last().mode, f.last().error, f.last().pending], [noLegacy, 'unknown', null, false]);
  const bad: Array<() => unknown> = [
    failure('storage_failure', 'Could not read the Bingo state. Try again.'), failure('not_available', ''),
    { ...failure('not_available', 'x'), extra: 1 }, failure('stale_session', 'x'), failure('invalid_request', 'x'),
    null, undefined, { ok: true, state: 'none' }, { ok: true, state: 'recovered' }, { ...legacyCheck(), extra: 1 },
    legacyCheck(null), legacyCheck([check]), legacyCheck({ ...check, eventId: 'e2' }), legacyCheck({ ...check, eventId: '' }),
    legacyCheck({ ...check, phase: 'checking_line' }), legacyCheck({ ...check, auditSequence: 0 }),
    legacyCheck({ ...check, auditSequence: 1.5 }), legacyCheck({ ...check, auditSequence: '7' }),
    legacyCheck({ ...check, auditSequence: 2 ** 53 }), legacyCheck({ ...check, lastTransitionAt: '2024-05-01T10:00:00Z' }),
    legacyCheck({ ...check, lastTransitionAt: 'soon' }), legacyCheck({ ...check, extra: 1 }),
    legacyCheck({ eventId: 'e1', phase: 'checking_bingo', auditSequence: 7 }),
  ].map((value) => async () => value);
  bad.push(() => Promise.reject(new Error('lost')), () => { throw new Error('sync'); });
  for (const [index, answer] of bad.entries()) {
    await f.controller.checkLegacy();
    assert.equal(f.last().legacy.status, 'available');
    f.answers.push(answer);
    await f.controller.checkLegacy();
    assert.deepEqual([f.last().legacy, f.last().mode, f.last().pending, typeof f.last().error],
      [{ status: 'uncertain', check: null }, 'unknown', false, 'string'], String(index));
  }
  await flush();
  assert.equal(f.calls.filter((call) => !call.startsWith('legacy:0')).length, 1);
  assert.equal(f.calls.length, 2 + 2 * bad.length + 1);
});

test('bingo legacy check needs a known checking_bingo event, no setup and no held award; no bridge only errs', async () => {
  for (const [id, phase] of [[null, 'checking_bingo'], ['e1', 'drawing'], ['e1', 'line_declared'], ['e1', null],
    ['e1', 'Checking_bingo'], ['e1', 'bingo_declared']] as const) {
    const f = legacyFixture();
    f.controller.setEvent(id, phase);
    await f.controller.checkLegacy();
    assert.deepEqual([f.calls, f.last().legacy, f.last().pending], [['subscribe'], noLegacy, false], `${id}:${phase}`);
  }
  const owned = legacyFixture();
  owned.reply(setup());
  await owned.controller.start();
  await owned.controller.checkLegacy();
  assert.deepEqual([owned.calls, owned.last().mode, owned.last().session], [['subscribe', 'read:0'], 'setup', session]);
  const held = legacyFixture();
  held.reply(declared());
  await held.controller.start();
  held.reply(null);
  await held.controller.start();
  await held.controller.checkLegacy();
  assert.deepEqual([held.calls.length, held.last().mode, held.last().legacy], [3, 'uncertain', noLegacy]);
  const closed = bingoFixture({ readBingoSetup: undefined });
  closed.controller.setEvent('e1', 'checking_bingo');
  await closed.controller.checkLegacy();
  assert.deepEqual([closed.calls, closed.last().mode], [['subscribe'], 'uncertain']);
  for (const bridge of [undefined, null, 'nope']) {
    const f = bingoFixture({ readLegacyBingoCheck: bridge });
    f.controller.setEvent('e1', 'checking_bingo');
    await f.controller.checkLegacy();
    assert.deepEqual([f.calls, f.last().legacy, f.last().pending, typeof f.last().error],
      [['subscribe'], noLegacy, false, 'string']);
    await f.controller.start();
    assert.deepEqual([f.calls, f.last().mode, f.last().error], [['subscribe', 'read:0'], 'idle', null]);
  }
});

test('bingo legacy check shares the actual flight, joins reentry and rechecks its context after render', async () => {
  const d = deferred();
  const joined: unknown[] = [];
  let f!: ReturnType<typeof legacyFixture>;
  f = legacyFixture([() => d.promise], (state) => {
    if (state.pending && joined.length === 0) joined.push(f.controller.checkLegacy(), f.controller.start(), f.controller.begin());
  });
  const first = f.controller.checkLegacy();
  assert.deepEqual([...joined, f.controller.checkLegacy(), f.controller.start()].map((p) => p === first), [true, true, true, true, true]);
  d.resolve(legacyCheck());
  await first;
  assert.deepEqual([f.calls, f.last().legacy, f.last().pending], [['subscribe', 'legacy:0'], { status: 'available', check }, false]);
  const r = deferred();
  f.replies.push(() => r.promise);
  const read = f.controller.start();
  assert.equal(f.controller.checkLegacy(), read);
  r.resolve({ ok: true, state: 'none' });
  await read;
  assert.deepEqual([f.calls, f.last().mode], [['subscribe', 'legacy:0', 'read:0'], 'idle']);
  for (const change of ['phase', 'switch', 'dispose']) {
    let armed = false;
    let g!: ReturnType<typeof legacyFixture>;
    g = legacyFixture([], (state) => {
      if (!armed || !state.pending) return;
      armed = false;
      if (change === 'phase') g.controller.setEvent('e1', 'drawing');
      else if (change === 'switch') g.controller.setEvent('e2', 'checking_bingo');
      else g.controller.dispose();
    });
    g.reply(null);
    await g.controller.start();
    const message = g.last().error;
    armed = true;
    await g.controller.checkLegacy();
    await flush();
    assert.deepEqual([g.calls, g.controller.getState().legacy], [['subscribe', 'read:0'], noLegacy], change);
    if (change === 'phase') assert.deepEqual([g.last().mode, g.last().error, typeof message], ['uncertain', message, 'string']);
  }
  const u = legacyFixture();
  u.reply(null);
  await u.controller.start();
  const message = u.last().error;
  await u.controller.checkLegacy();
  assert.deepEqual([u.last().mode, u.last().error, u.last().legacy.status], ['uncertain', message, 'available']);
  u.answers.push(async () => failure('storage_failure', 'Could not read the Bingo state. Try again.'));
  await u.controller.checkLegacy();
  assert.deepEqual([u.last().mode, u.last().error, u.last().legacy.status], ['uncertain', message, 'uncertain']);
});

test('bingo legacy context changes drop late answers and the available identity before render', async () => {
  const f = legacyFixture();
  await f.controller.checkLegacy();
  f.controller.setEvent('e1', 'checking_bingo');
  assert.deepEqual(f.last().legacy, { status: 'available', check });
  for (const [id, phase] of [['e1', 'drawing'], ['e2', 'checking_bingo']] as const) {
    await f.controller.checkLegacy();
    f.controller.setEvent(id, phase);
    if (id === 'e2') f.controller.setEvent('e1', 'checking_bingo');
    assert.deepEqual(f.last().legacy, noLegacy, `${id}:${phase}`);
    if (phase === 'drawing') f.controller.setEvent('e1', 'checking_bingo');
  }
  for (const late of [legacyCheck(), failure('storage_failure', 'x')]) {
    const d = deferred();
    f.answers.push(() => d.promise);
    const flight = f.controller.checkLegacy();
    f.controller.setEvent('e1', 'drawing');
    f.controller.setEvent('e1', 'checking_bingo');
    d.resolve(late);
    await flight;
    assert.deepEqual([f.last().legacy, f.last().pending, f.last().error], [noLegacy, false, null]);
  }
  const old = deferred();
  const fresh = deferred();
  f.answers.push(() => old.promise, () => fresh.promise);
  const away = f.controller.checkLegacy();
  f.controller.setEvent('e2', 'checking_bingo');
  f.controller.setEvent('e1', 'checking_bingo');
  const replacement = f.controller.checkLegacy();
  assert.notEqual(replacement, away);
  old.resolve(legacyCheck());
  await away;
  assert.deepEqual([f.controller.getState().pending, f.controller.getState().legacy], [true, noLegacy]);
  fresh.resolve(legacyCheck());
  await replacement;
  assert.deepEqual([f.last().pending, f.last().legacy], [false, { status: 'available', check }]);
  const late = deferred();
  f.answers.push(() => late.promise);
  const last = f.controller.checkLegacy();
  const seen = f.renders.length;
  f.controller.dispose();
  late.resolve(legacyCheck());
  await last;
  await f.controller.checkLegacy();
  assert.deepEqual([f.renders.length, f.controller.getState().legacy, f.calls.length], [seen, noLegacy, 9]);
});
