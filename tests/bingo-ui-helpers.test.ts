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

// The manual retry (H4a): the page's admission, and the binding running it after the controller's pending render,
// right before the bridge, through the real Bingo controller with a declared award whose celebration failed.
import { manualAdmitted } from '../src/bingo-ui.mjs';

const failedAward = { ...bingoAward, presentation: { id: 'b1', status: 'failed', startedAt: null, deadlineAt: null } };
const clearGuards = { tongoPlaying: false, presentationBusy: false, otherSetupActive: false };
const expected = { eventId: 'e1', id: 'b1', status: 'failed' };
const clearPage = { selecting: false, activating: false, eventsPending: false, eventsStale: false, tongoBusy: false,
  lineBlocked: false, owner: true, linePending: false, lineRefresh: 'none', lineForeign: false, eventPending: false,
  guards: clearGuards, eventId: 'e1', phase: 'bingo_declared', owed: 'none' };
const shownState = { mode: 'declared', pending: true, eventId: 'e1', session: null, award: failedAward, legacy: { status: 'none' },
  refresh: 'none' };

test('manualAdmitted needs every page gate and exactly the shown award, never blocked by its own pending reservation', () => {
  assert.equal(manualAdmitted(clearPage, shownState, expected), true, 'pending: the action\'s own reservation');
  const pages: Array<[string, unknown]> = [['selecting', true], ['activating', true], ['eventsPending', true], ['eventsStale', true],
    ['tongoBusy', true], ['lineBlocked', true], ['owner', false], ['linePending', true], ['lineRefresh', 'pending'],
    ['lineRefresh', 'failed'], ['lineForeign', true], ['eventPending', true], ['eventId', 'e2'], ['eventId', null],
    ['phase', 'line_declared'], ['phase', null], ['owed', 'pending'], ['owed', 'failed'], ['guards', null]];
  for (const key of Object.keys(clearGuards)) pages.push(['guards', { ...clearGuards, [key]: null }], ['guards', { ...clearGuards, [key]: true }]);
  for (const [key, value] of pages) {
    assert.equal(manualAdmitted({ ...clearPage, [key]: value }, shownState, expected), false, `${key}: ${JSON.stringify(value)}`);
  }
  const states: Array<[string, unknown]> = [['mode', 'uncertain'], ['mode', 'setup'], ['eventId', 'e2'], ['session', bingoSession],
    ['legacy', { status: 'available' }], ['refresh', 'pending'], ['refresh', 'failed'], ['award', null],
    ['award', { ...failedAward, eventId: 'e2' }], ['award', { ...failedAward, presentation: { ...failedAward.presentation, id: 'b2' } }],
    ['award', { ...failedAward, presentation: { ...failedAward.presentation, status: 'interrupted' } }]];
  for (const [key, value] of states) {
    assert.equal(manualAdmitted(clearPage, { ...shownState, [key]: value }, expected), false, `${key}: ${JSON.stringify(value)}`);
  }
  for (const other of [{ id: 'b0' }, { status: 'completed' }, { eventId: 'e2' }]) {
    assert.equal(manualAdmitted(clearPage, shownState, { ...expected, ...other }), false, JSON.stringify(other));
  }
});

// A binding over the e1 failed award, read and guarded; `onRender` then sees every later render.
async function failedBinding(onRender: (state: any) => void = () => {}) {
  const sent: string[] = [];
  const renders: any[] = [];
  let armed = false;
  const api = { onBingoPresentation: () => () => {}, readBingoSetup: async () => ({ ok: true, state: 'declared', award: failedAward }),
    retryBingoPresentation: async (id: string) => {
      sent.push(id);
      return { ok: true, state: 'declared', award: { ...failedAward, presentation: { ...failedAward.presentation, id: 'b2', status: 'pending' } } };
    } };
  const binding = createBingoBinding(api, { render: (state: any) => { renders.push(state); if (armed) onRender(state); },
    refresh: async () => true });
  binding.sync('e1', 'bingo_declared', clearGuards);
  await binding.reread();
  assert.equal(renders.at(-1).award.presentation.status, 'failed');
  armed = true;
  return { binding, sent, renders };
}

test('the page check runs after the pending render, admits its own reservation and sends the exact id once', async () => {
  const seen: boolean[] = [];
  const f = await failedBinding((state) => { seen.push(state.pending); });
  let checks = 0;
  await f.binding.retry('b1', () => { checks++; return manualAdmitted(clearPage, f.renders.at(-1), expected); });
  assert.deepEqual([seen[0], checks, f.sent], [true, 1, ['b1']]);
  assert.deepEqual([f.renders.at(-1).mode, f.renders.at(-1).award.presentation.id], ['declared', 'b2']);
});

test('a gate closed, an event switch or a disposal from the pending render stops the bridge; a reentrant retry joins', async () => {
  for (const change of ['gate', 'switch', 'dispose', 'reentry', 'no check', 'stale id']) {
    let open = true;
    let armed = true;
    const f = await failedBinding((state) => {
      if (!armed || !state.pending) return;
      armed = false;
      if (change === 'gate') open = false;
      else if (change === 'switch') f.binding.sync('e2', 'bingo_declared', clearGuards);
      else if (change === 'dispose') f.binding.dispose();
      else if (change === 'reentry') void f.binding.retry('b1', () => false);
    });
    const ready = change === 'no check' ? undefined : () => open;
    await f.binding.retry(change === 'stale id' ? 'b0' : 'b1', ready as any);
    assert.deepEqual(f.sent, change === 'reentry' ? ['b1'] : [], change);
    if (change === 'gate' || change === 'no check') {
      const last = f.renders.at(-1);
      assert.deepEqual([last.mode, last.award.presentation.id, last.error], ['declared', 'b1',
        'The Bingo presentation cannot be started now.'], change);
    }
  }
});
