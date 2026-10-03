import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTongoIpc, TONGO_CHANNEL, TONGO_DURATION_MS, type TongoPresentation } from '../src/tongo-ipc.ts';
import type { GamePhase } from '../src/game-phase.ts';

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;

function fixture(phase: GamePhase | null = 'drawing', lineBusy?: () => boolean) {
  const sender = {}, frame = {}, handlers = new Map<string, Handler>();
  const published: TongoPresentation[] = [], timers: Array<{ done: () => void; delay: number }> = [];
  let current: { phase: GamePhase; calledNumbers: number[] } | null =
    phase === null ? null : { phase, calledNumbers: [4, 8] };
  let delivery: 'ok' | 'closed' | 'throws' = 'ok';
  let loads = 0, readFails = false;
  const tongo = registerTongoIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } }, {
    load: () => {
      loads++;
      if (readFails) throw new Error('private storage detail');
      return current;
    },
  }, {
    authorize: (event) => { if (event.sender !== sender || event.senderFrame !== frame) throw new Error('Unauthorized event request'); },
    publish: (presentation) => {
      if (delivery === 'throws') throw new Error('send failed');
      if (delivery === 'closed') return false;
      published.push(presentation);
      return true;
    },
    schedule: (done, delay) => { timers.push({ done, delay }); },
    lineBusy,
  });
  const invoke = (args: unknown[] = [], from: object = sender, fromFrame: object | null = frame) =>
    handlers.get(TONGO_CHANNEL)!({ sender: from, senderFrame: fromFrame }, ...args);
  return { tongo, handlers, invoke, published, timers, loads: () => loads, current: () => current,
    setDelivery: (value: typeof delivery) => { delivery = value; },
    failRead: () => { readFails = true; }, setPhase: (next: GamePhase) => { current = { ...current!, phase: next }; } };
}

test('one fixed channel starts one transient presentation without changing the event', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], [TONGO_CHANNEL]);
  const before = structuredClone(f.current());
  const presentation = { kind: 'tongo', id: 1, durationMs: TONGO_DURATION_MS };
  assert.deepEqual(f.invoke(), { ok: true, presentation });
  assert.deepEqual(f.published, [presentation]);
  assert.deepEqual(f.current(), before);
  assert.equal(f.tongo.playing(), true);
  assert.deepEqual(f.timers.map(({ delay }) => delay), [3000]);
});

test('repeated input is refused while playing, then a fresh id is allowed', () => {
  const f = fixture();
  f.invoke();
  assert.deepEqual(f.invoke(), { ok: false, code: 'busy', message: 'Tongo is already playing on the public window.' });
  assert.equal(f.published.length, 1);
  f.timers[0].done();
  assert.equal(f.tongo.playing(), false);
  assert.deepEqual(f.invoke(), { ok: true, presentation: { kind: 'tongo', id: 2, durationMs: 3000 } });
});

test('unauthorized and malformed requests never read, publish, or block', () => {
  const f = fixture();
  assert.throws(() => f.invoke([], {}), /unauthorized/i);
  assert.throws(() => f.invoke([], undefined, null), /unauthorized/i);
  for (const args of [[1], ['line'], [{ kind: 'tongo' }], [undefined]]) {
    assert.deepEqual(f.invoke(args), { ok: false, code: 'invalid_request', message: 'Invalid Tongo request.' });
  }
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.published, []);
  assert.equal(f.tongo.playing(), false);
});

test('only the playable phases may celebrate; unreadable or missing events fail generically', () => {
  for (const phase of ['checking_line', 'checking_bingo', 'bingo_declared', 'finished'] as const) {
    const f = fixture(phase);
    assert.deepEqual(f.invoke(), { ok: false, code: 'not_playable', message: 'Tongo is only available during play.' });
    assert.deepEqual(f.published, []);
  }
  const lineDeclared = fixture('line_declared');
  assert.equal((lineDeclared.invoke() as { ok: boolean }).ok, true);
  assert.equal((fixture(null).invoke() as { code: string }).code, 'not_playable');
  const unreadable = fixture();
  unreadable.failRead();
  assert.deepEqual(unreadable.invoke(),
    { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' });
  assert.equal(unreadable.tongo.playing(), false);
});

test('a closed or failing public window yields no acknowledgement, no block, and no consumed id', () => {
  const f = fixture();
  for (const delivery of ['closed', 'throws'] as const) {
    f.setDelivery(delivery);
    assert.deepEqual(f.invoke(), { ok: false, code: 'public_unavailable',
      message: 'Open the public window, then try Tongo again.' });
    assert.equal(f.tongo.playing(), false);
    assert.deepEqual(f.timers, []);
  }
  f.setDelivery('ok');
  assert.deepEqual(f.invoke(), { ok: true, presentation: { kind: 'tongo', id: 1, durationMs: 3000 } });
});

test('Tongo is refused while a line presentation runs, without touching the store or the display', () => {
  let busy = true;
  const f = fixture('drawing', () => busy);
  const refused = f.invoke();
  assert.deepEqual(refused, { ok: false, code: 'line_presentation_active',
    message: 'Wait for the line celebration to finish, then try Tongo again.' });
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.published, []);
  busy = false;
  assert.equal((f.invoke() as { ok: boolean }).ok, true);
});
