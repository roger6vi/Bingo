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
