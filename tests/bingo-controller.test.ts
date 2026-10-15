import assert from 'node:assert/strict';
import test from 'node:test';
import { createBingoController } from '../src/bingo-controller.mjs';

// F1 of the Bingo operator controller: validated read, event context and lifecycle. Pushes are inert until F3.
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
  let push: (value: unknown) => void = () => { throw new Error('not subscribed'); };
  let unsubscribed = 0;
  const spy = (name: string) => () => { calls.push(name); return Promise.resolve({ ok: true, state: 'none' }); };
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
    beginBingoSetup: spy('begin'), cancelBingoSetup: spy('cancel'), confirmBingo: spy('confirm'),
    retryBingoPresentation: spy('retry'), repeatBingoPresentation: spy('repeat'),
    readLegacyBingoCheck: spy('legacy-read'), cancelLegacyBingoCheck: spy('legacy-cancel'),
    ...overrides,
  };
  const controller = createBingoController(api, { render: (state: State) => { renders.push(state); onRender(state); } });
  return { controller, calls, renders, replies, push: (value: unknown) => push(value), unsubscribed: () => unsubscribed,
    last: () => renders.at(-1) as State, reply: (value: unknown) => replies.push(async () => value) };
}

test('bingo subscribes before any read and never reads, writes or plays by itself', async () => {
  const f = bingoFixture();
  assert.deepEqual(Object.keys(f.controller).sort(), ['dispose', 'getState', 'setEvent', 'start']);
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
