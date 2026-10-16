import assert from 'node:assert/strict';
import test from 'node:test';
import { createBingoController } from '../src/bingo-controller.mjs';

// Bingo operator controller: validated read, event context, lifecycle (F1) and explicit begin/cancel (F2a).
// Pushes are inert until F3.
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
  session: any; award: any };
function bingoFixture(overrides: Record<string, unknown> = {}, onRender: (state: State) => void = () => {}) {
  const calls: string[] = [];
  const renders: State[] = [];
  const replies: Array<() => unknown> = [];
  const actions: Array<() => unknown> = [];
  let push: (value: unknown) => void = () => { throw new Error('not subscribed'); };
  let unsubscribed = 0;
  const spy = (name: string) => () => { calls.push(name); return Promise.resolve({ ok: true, state: 'none' }); };
  // Begin and cancel record their exact arguments and answer from their own queue.
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
    beginBingoSetup: act('begin'), cancelBingoSetup: act('cancel'), confirmBingo: spy('confirm'),
    retryBingoPresentation: spy('retry'), repeatBingoPresentation: spy('repeat'),
    readLegacyBingoCheck: spy('legacy-read'), cancelLegacyBingoCheck: spy('legacy-cancel'),
    ...overrides,
  };
  const controller = createBingoController(api, { render: (state: State) => { renders.push(state); onRender(state); } });
  return { controller, calls, renders, replies, actions, push: (value: unknown) => push(value),
    unsubscribed: () => unsubscribed, last: () => renders.at(-1) as State,
    reply: (value: unknown) => replies.push(async () => value), answer: (value: unknown) => actions.push(async () => value) };
}

test('bingo subscribes before any read and never reads, writes or plays by itself', async () => {
  const f = bingoFixture();
  assert.deepEqual(Object.keys(f.controller).sort(), ['begin', 'cancel', 'dispose', 'getState', 'setEvent', 'start']);
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

test('bingo F1 ignores presentation pushes until the push slice exists', async () => {
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
