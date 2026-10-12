import assert from 'node:assert/strict';
import test from 'node:test';
import { lineResolved, pageBlocked, parseWinners } from '../src/bingo-ui.mjs';
import { createLineLotController } from '../src/line-lot-controller.mjs';
import { createLineController } from '../src/operator-controller.mjs';

// The Bingo declaration predicates of the operator page (H3a): the page locks a begin or confirm respects, the typed
// winner count and the persisted Line evidence. Line and lot states come from their real controllers, not fixtures.
const presentation = { id: 'p1', status: 'completed', startedAt: 1000, deadlineAt: 5000 };
const lineAward = (lot: string, winnerCount: number, lotResolution: string) => ({ eventId: 'e1',
  award: { winnerCount, totalCents: 1000, shareCents: Math.floor(1000 / winnerCount), remainderCents: 1000 % winnerCount,
    lot, lotResolution }, presentation });
const tied = lineAward('Jamón', 2, 'pending');
const lotSnapshot = { eventId: 'e1', auditSequence: 4, winnerCount: 2, lot: 'Jamón',
  presentation: { id: 'p1', status: 'completed' },
  fact: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 2, colorId: 'blue' } };

// The line state the page renders after reading `reply` under event e1; `hold` keeps a second read in flight.
async function lineState(reply: unknown, hold = false) {
  let last: any = null;
  let read = async () => reply;
  const controller = createLineController({ readLineSetup: () => read() }, { render: (state: unknown) => { last = state; } });
  controller.setEvent('e1');
  await controller.start();
  if (hold) { read = () => new Promise(() => {}); void controller.start(); }
  return last;
}
async function lotState(snapshot: unknown | null) {
  const lot = createLineLotController({ readLineLot: async () => ({ ok: true, kind: 'current', snapshot }) });
  lot.setContext({ eventId: 'e1' });
  if (snapshot !== null) await lot.start();
  return lot.getState();
}

test('pageBlocked is clear with no lock and blocked by each of the six page locks alone', () => {
  assert.equal(pageBlocked({}), false);
  for (const flag of ['selecting', 'activating', 'eventsPending', 'eventsStale', 'tongoBusy', 'lineBlocked']) {
    assert.equal(pageBlocked({ [flag]: true }), true, flag);
  }
});

test('parseWinners accepts only a positive safe integer in full digits, as a number', () => {
  for (const [text, count] of [['1', 1], ['12', 12], ['9007199254740991', Number.MAX_SAFE_INTEGER], ['007', 7], [' 3 ', 3]]) {
    assert.strictEqual(parseWinners(text), count, String(text));
  }
  for (const text of [2, null, undefined, '', '   ', '0', '-1', '1.5', '1e3', '0x10', '+1', '9007199254740992', 'two']) {
    assert.equal(parseWinners(text), null, String(text));
  }
});

test('lineResolved needs the active event declared Line award with no lot to settle or an award-owned resolution', async () => {
  const notRequired = await lineState({ ok: true, state: 'declared', award: lineAward('', 2, 'not_required') });
  assert.equal(notRequired.mode, 'declared');
  assert.equal(lineResolved(notRequired, null, 'e1'), true);
  assert.equal(lineResolved(await lineState({ ok: true, state: 'declared', award: lineAward('Jamón', 2, 'resolved') }), null, 'e1'), true);
  assert.equal(lineResolved(notRequired, null, null), false, 'no active event');
  assert.equal(lineResolved(notRequired, null, 'e2'), false, 'another event');
  assert.equal(lineResolved({ ...notRequired, award: null }, null, 'e1'), false, 'declared without an award');
  assert.equal(lineResolved(await lineState({ ok: true, state: 'none' }), null, 'e1'), false, 'historical: no award held');
  const setup = await lineState({ ok: true, state: 'setup',
    session: { sessionId: 's1', eventId: 'e1', calledNumbers: [4], linePrize: { amount: 10, lot: '' } } });
  assert.equal(lineResolved({ ...setup, award: notRequired.award }, null, 'e1'), false, 'setup mode');
  const asking = await lineState({ ok: true, state: 'declared', award: lineAward('', 2, 'not_required') }, true);
  assert.deepEqual([asking.mode, asking.pending], ['declared', true]);
  assert.equal(lineResolved(asking, null, 'e1'), false, 'a Line request in flight');
});

test('lineResolved takes a pending tied lot only from a validated resolved read of exactly that award', async () => {
  const line = await lineState({ ok: true, state: 'declared', award: tied });
  const lot = await lotState(lotSnapshot);
  assert.equal(lot.status, 'resolved');
  assert.equal(lineResolved(line, lot, 'e1'), true);
  assert.equal(lineResolved(line, null, 'e1'), false, 'no lot state');
  assert.equal(lineResolved(line, await lotState(null), 'e1'), false, 'lot unread');
  const pendingLot = await lotState({ ...lotSnapshot, fact: { origin: 'none', resolution: 'pending' } });
  assert.notEqual(pendingLot.status, 'resolved');
  assert.equal(lineResolved(line, pendingLot, 'e1'), false, 'lot still pending');
  const changed = (over: object) => ({ ...lot, snapshot: { ...lot.snapshot, ...over } });
  assert.equal(lineResolved(line, changed({ eventId: 'e2' }), 'e1'), false, 'lot event');
  assert.equal(lineResolved(line, changed({ presentation: { id: 'p2', status: 'completed' } }), 'e1'), false, 'presentation id');
  assert.equal(lineResolved(line, changed({ winnerCount: 3 }), 'e1'), false, 'winner count');
  assert.equal(lineResolved(line, changed({ lot: 'Queso' }), 'e1'), false, 'lot name');
  assert.equal(lineResolved(line, changed({ fact: { origin: 'none', resolution: 'pending' } }), 'e1'), false, 'resolution');
});

// The binding's committed refresh (H3c), driven through the real Bingo controller: a validated setup read, an exact
// declared confirm and a counted unsubscribe from the fake bridge. Each refresh call stays deferred until settled.
import { createBingoBinding } from '../src/bingo-ui.mjs';

const bingoSession = { sessionId: 's1', eventId: 'e1', calledNumbers: [12, 5], bingoPrize: { amount: 50, lot: '' } };
const bingoAward = { eventId: 'e1', award: { winnerCount: 2, totalCents: 5000, shareCents: 2500, remainderCents: 0, lot: '',
  lotResolution: 'not_required' }, presentation: { id: 'b1', status: 'started', startedAt: 1000, deadlineAt: 5000 } };
const flush = () => new Promise((done) => setImmediate(done));
function bindingFixture(onRender: (state: any) => void = () => {}) {
  const calls: string[] = [];
  const refreshes: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const renders: any[] = [];
  let unsubscribed = 0;
  let bound = false;
  const api = {
    onBingoPresentation: () => () => { unsubscribed++; },
    readBingoSetup: async () => { calls.push('read'); return { ok: true, state: 'setup', session: bingoSession }; },
    confirmBingo: async (id: string, count: number) => {
      calls.push(`confirm:${id}:${count}`);
      return { ok: true, state: 'declared', award: bingoAward };
    },
  };
  // The controller renders once while it is created, before `onRender` can reach the binding.
  const binding = createBingoBinding(api, { render: (state: any) => { renders.push(state); if (bound) onRender(state); },
    refresh: () => new Promise((resolve, reject) => { calls.push('refresh'); refreshes.push({ resolve, reject }); }) });
  bound = true;
  return { binding, calls, refreshes, renders, unsubscribed: () => unsubscribed };
}
// Reads the e1 setup and confirms two winners: the committed refresh is then delivered once, after the release.
async function declare(f: ReturnType<typeof bindingFixture>) {
  f.binding.sync('e1', 'line_declared', {});
  await f.binding.reread();
  assert.equal(f.renders.at(-1).mode, 'setup');
  await f.binding.confirm(2);
  assert.equal(f.renders.at(-1).mode, 'declared');
}

test('the committed refresh renders pending before it runs once and settles a success to none', async () => {
  const seen: Array<[string, number]> = [];
  const f = bindingFixture(() => { seen.push([f.binding.refreshState('e1'), f.refreshes.length]); });
  await declare(f);
  assert.deepEqual([seen.at(-1), f.refreshes.length, f.binding.refreshState('e1')], [['pending', 0], 1, 'pending']);
  const painted = f.renders.length;
  f.refreshes[0].resolve(true);
  await flush();
  assert.deepEqual([f.binding.refreshState('e1'), f.renders.length], ['none', painted + 1]);
  f.binding.retryRefresh();
  assert.deepEqual(f.calls, ['read', 'confirm:s1:2', 'refresh']);
});

test('a failed committed refresh stays failed for its event; only an explicit retry runs one new read-only attempt', async () => {
  const f = bindingFixture();
  await declare(f);
  f.binding.retryRefresh();
  assert.equal(f.refreshes.length, 1, 'no retry while pending');
  f.refreshes[0].resolve(false);
  await flush();
  assert.deepEqual([f.binding.refreshState('e1'), f.binding.refreshState('e2')], ['failed', 'none']);
  f.binding.retryRefresh();
  assert.deepEqual([f.refreshes.length, f.binding.refreshState('e1')], [2, 'pending']);
  f.refreshes[1].reject(new Error('read'));
  await flush();
  assert.equal(f.binding.refreshState('e1'), 'failed', 'a rejection is contained as failed');
  f.binding.retryRefresh();
  f.refreshes[2].resolve(true);
  await flush();
  assert.equal(f.binding.refreshState('e1'), 'none');
  assert.deepEqual(f.calls, ['read', 'confirm:s1:2', 'refresh', 'refresh', 'refresh']);
});

test('disposing with a committed refresh outstanding or failed clears it, paints nothing more and unsubscribes once', async () => {
  for (const outcome of ['success', 'failure', 'rejection', 'failed-before']) {
    const f = bindingFixture();
    await declare(f);
    if (outcome === 'failed-before') {
      f.refreshes[0].resolve(false);
      await flush();
      assert.equal(f.binding.refreshState('e1'), 'failed', outcome);
    }
    const painted = f.renders.length;
    f.binding.dispose();
    f.binding.dispose();
    assert.deepEqual([f.unsubscribed(), f.binding.refreshState('e1')], [1, 'none'], outcome);
    if (outcome === 'rejection') f.refreshes[0].reject(new Error('read'));
    else f.refreshes[0].resolve(outcome === 'success');
    await flush();
    f.binding.retryRefresh();
    f.binding.sync('e1', 'bingo_declared', {});
    await f.binding.reread();
    await flush();
    assert.deepEqual([f.renders.length, f.refreshes.length, f.binding.refreshState('e1'), f.unsubscribed()],
      [painted, 1, 'none', 1], outcome);
    assert.deepEqual(f.calls, ['read', 'confirm:s1:2', 'refresh'], outcome);
  }
});

test('a disposal or event switch from the pending render prevents the refresh from being dispatched', async () => {
  for (const change of ['dispose', 'switch']) {
    let armed = true;
    const f = bindingFixture(() => {
      if (!armed || f.binding.refreshState('e1') !== 'pending') return;
      armed = false;
      if (change === 'dispose') f.binding.dispose();
      else f.binding.sync('e2', 'line_declared', {});
    });
    f.binding.sync('e1', 'line_declared', {});
    await f.binding.reread();
    await f.binding.confirm(2);
    await flush();
    assert.equal(armed, false, change);
    assert.deepEqual([f.refreshes.length, f.binding.refreshState('e1'), f.unsubscribed()],
      [0, 'none', change === 'dispose' ? 1 : 0], change);
    f.binding.retryRefresh();
    assert.deepEqual(f.calls, ['read', 'confirm:s1:2'], change);
  }
});

test('an event change, a way back included, orphans the older attempt: its late answer neither overwrites nor paints', async () => {
  const f = bindingFixture();
  await declare(f);
  f.binding.sync('e2', 'line_declared', {});
  f.binding.sync('e1', 'line_declared', {});
  assert.equal(f.binding.refreshState('e1'), 'none');
  await declare(f);
  assert.deepEqual([f.refreshes.length, f.binding.refreshState('e1')], [2, 'pending']);
  const painted = f.renders.length;
  f.refreshes[0].resolve(false);
  await flush();
  assert.deepEqual([f.binding.refreshState('e1'), f.renders.length], ['pending', painted]);
  f.refreshes[1].resolve(true);
  await flush();
  assert.deepEqual([f.binding.refreshState('e1'), f.renders.length], ['none', painted + 1]);
});
