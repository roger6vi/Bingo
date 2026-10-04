import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { PRIZE_CHANNELS, registerPrizeIpc } from '../src/prize-ipc.ts';
import { NO_PRIZES, type EventPrizes } from '../src/event-prizes.ts';

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;
const prizes = (lineAmount: number, lineLot: string, bingoAmount: number, bingoLot: string): EventPrizes =>
  ({ line: { amount: lineAmount, lot: lineLot }, bingo: { amount: bingoAmount, lot: bingoLot } });

function fixture(setup?: () => boolean) {
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let active: string | null = 'a';
  let stored = new Map<string, EventPrizes>([['a', prizes(10, 'Lote', 0, '')]]);
  let failure: string | null = null;
  const store = {
    loadPrizes() {
      calls.push('load');
      if (failure === 'load') throw new Error('secret');
      return active === null ? null : { eventId: active, prizes: stored.get(active) ?? NO_PRIZES };
    },
    updateEventPrizes(id: string, next: EventPrizes) {
      calls.push(`update:${id}:${JSON.stringify(next)}`);
      if (failure === 'update' || id !== active) throw new Error('secret');
      stored = new Map(stored).set(id, next);
      return next;
    },
  };
  registerPrizeIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
    store, createOperatorGuard(sender, () => frame, frame.url), () => {
      calls.push('notify');
      if (failure === 'notify') throw new Error('display gone');
    }, setup);
  const invoke = (channel: string, args: unknown[] = [], from: object = sender) =>
    handlers.get(channel)!({ sender: from, senderFrame: frame }, ...args);
  return { handlers, invoke, calls, setFailure: (value: string) => { failure = value; },
    setActive: (id: string | null) => { active = id; } };
}

const invalid = { ok: false, code: 'invalid_request', message: 'Invalid prize request.' };

test('registers exactly get and update, both operator-only', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], Object.values(PRIZE_CHANNELS));
  for (const channel of Object.values(PRIZE_CHANNELS)) {
    assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
  }
  assert.deepEqual(f.calls, []);
});

test('get returns the active event id with a copy of its committed prizes', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.get), { ok: true, eventId: 'a', prizes: prizes(10, 'Lote', 0, '') });
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.get, [1]), invalid);
  f.setActive(null);
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.get), { ok: false, code: 'event_unavailable', message: 'No active event is available.' });
  f.setFailure('load');
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.get), { ok: false, code: 'storage_failure', message: 'Could not read the prizes. Try again.' });
});

test('update trims lots, commits, notifies the public display, and returns the committed prizes', () => {
  const f = fixture();
  const result = f.invoke(PRIZE_CHANNELS.update, ['a', prizes(150, ' Jamón ', 0, 'Cesta')]);
  assert.deepEqual(result, { ok: true, eventId: 'a', prizes: prizes(150, 'Jamón', 0, 'Cesta') });
  assert.deepEqual(f.calls, [`update:a:${JSON.stringify(prizes(150, 'Jamón', 0, 'Cesta'))}`, 'notify']);
});

test('malformed prize requests never reach the store', () => {
  const f = fixture();
  const ok = prizes(1, '', 2, '');
  const bad: unknown[][] = [[], ['a'], [ok], ['a', ok, 1], [1, ok], ['', ok], ['x'.repeat(65), ok],
    ['a', null], ['a', 'x'], ['a', []], ['a', { line: ok.line }], ['a', { ...ok, extra: ok.line }],
    ['a', Object.assign(Object.create(null), ok)], ['a', { line: { ...ok.line, extra: 1 }, bingo: ok.bingo }],
    ['a', { line: { amount: 1 }, bingo: ok.bingo }]];
  for (const amount of [-1, 100_001, 2.5, Number.NaN, '5', null]) bad.push(['a', { line: { amount, lot: '' }, bingo: ok.bingo }]);
  for (const lot of ['l'.repeat(121), 3, null]) bad.push(['a', { line: ok.line, bingo: { amount: 0, lot } }]);
  bad.forEach((args, index) => assert.deepEqual(f.invoke(PRIZE_CHANNELS.update, args), invalid, `case ${index}`));
  assert.deepEqual(f.calls, []);
});

test('a storage failure or inactive event returns a stable error without notifying or leaking details', () => {
  const f = fixture();
  const failure = { ok: false, code: 'storage_failure', message: 'Could not save the prizes. Reload the events and try again.' };
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.update, ['b', prizes(1, '', 0, '')]), failure);
  f.setFailure('update');
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.update, ['a', prizes(1, '', 0, '')]), failure);
  assert.equal(f.calls.includes('notify'), false);
});

test('a failed public delivery never turns a committed save into an error', () => {
  const f = fixture();
  f.setFailure('notify');
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.update, ['a', prizes(5, '', 5, '')]),
    { ok: true, eventId: 'a', prizes: prizes(5, '', 5, '') });
});

test('an open first-line setup refuses prize updates before the store but still reads', () => {
  let open = true;
  const f = fixture(() => open);
  const request = ['a', prizes(5, 'Otro', 0, '')];
  assert.deepEqual(f.invoke(PRIZE_CHANNELS.update, request),
    { ok: false, code: 'line_setup_active', message: 'Finish or cancel the first-line setup first.' });
  assert.deepEqual(f.calls, []);
  assert.equal((f.invoke(PRIZE_CHANNELS.get) as { ok: boolean }).ok, true);
  open = false;
  assert.equal((f.invoke(PRIZE_CHANNELS.update, request) as { ok: boolean }).ok, true);
});
