import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { participantColor } from '../src/line-lot-contract.ts';
import { BINGO_LOT_CHANNELS, registerBingoLotIpc } from '../src/bingo-lot-ipc.ts';

// B1a slice: the 13 uncertainty/recovery/refresh-sweep tests are deferred whole to B1b, which restores the
// entire exact original test blob e5ecbfa5f792b9e1ccd40fb566597fa933ffdb35 (12 + 13 = 25 tests).

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => any;
const url = 'file:///app/operator.html';
const id = { eventId: 'e1', auditSequence: 4, presentationId: 'p1' };
const pending = (over: Record<string, unknown> = {}): any => ({ eventId: 'e1', auditSequence: 4, winnerCount: 5,
  lot: 'Hamper', presentation: { id: 'p1', status: 'completed' }, fact: { origin: 'none', resolution: 'pending' },
  ...over });
const numbered = (participantNumber: number, colorId: string): any => pending({
  fact: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber, colorId } });
const legacy = (): any => pending({ fact: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' } });

function fixture(options: { state?: any; ports?: Record<string, unknown>; write?: (f: any, e: any, r: any) => any;
  select?: (count: number) => any } = {}) {
  const sender = {};
  let frame: { url: string } | null = { url };
  const handlers = new Map<string, Handler>();
  const f: any = { state: 'state' in options ? options.state : pending(), loads: 0, writes: [] as any[],
    selections: [] as number[], failLoad: false };
  const store = {
    // Deliberately a Bingo-only store: loadLineLotResult does not exist, so any internal call to the Line
    // store port would throw and fail these tests. Every passing assertion is also binding evidence.
    loadBingoLotResult() { f.loads++; if (f.failLoad) throw new Error('secret read'); return f.state; },
    resolveBingoLot(expected: unknown, result: any) {
      f.writes.push({ expected, result });
      if (options.write) return options.write(f, expected, result);
      f.state = numbered(result.participantNumber, result.colorId);
      return f.state;
    },
  };
  registerBingoLotIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, store, {
    authorize: createOperatorGuard(sender, () => frame, url),
    select: (count) => { f.selections.push(count); return options.select ? options.select(count)
      : { participantNumber: 2, colorId: 'blue' }; },
    ...options.ports });
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: frame }, ...args);
  Object.assign(f, { sender, call, setFrame: (next: any) => { frame = next; },
    read: () => call(BINGO_LOT_CHANNELS.read), draw: (...args: unknown[]) => call(BINGO_LOT_CHANNELS.draw, ...args),
    handlers, untouched: () => f.loads === 0 && f.writes.length === 0 && f.selections.length === 0 });
  return f;
}

test('registers exactly the two named bingo channels and never a Line channel', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()].sort(), ['bingo:lot:draw', 'bingo:lot:read']);
  for (const line of ['line:lot:read', 'line:lot:draw']) assert.equal(f.handlers.has(line), false);
});

test('unauthorized senders, frames and URLs fail before store or entropy', () => {
  for (const channel of Object.values(BINGO_LOT_CHANNELS)) {
    const f = fixture();
    const handler = f.handlers.get(channel)!;
    const real = { url };
    assert.throws(() => handler({ sender: {}, senderFrame: real }, id), /Unauthorized/);
    f.setFrame(null);
    assert.throws(() => handler({ sender: f.sender, senderFrame: real }, id), /Unauthorized/);
    f.setFrame({ url });
    assert.throws(() => handler({ sender: f.sender, senderFrame: { url } }, id), /Unauthorized/);
    f.setFrame({ url: 'file:///app/public.html' });
    assert.throws(() => handler({ sender: f.sender, senderFrame: { url: 'file:///app/public.html' } }, id), /Unauthorized/);
    assert.throws(() => f.call(channel, id), /Unauthorized/);
    let ran = false;
    const getter = { eventId: 'e1', presentationId: 'p1' };
    Object.defineProperty(getter, 'auditSequence', { enumerable: true, get() { ran = true; return 4; } });
    assert.throws(() => handler({ sender: {}, senderFrame: real }, getter), /Unauthorized/);
    assert.equal(ran, false);
    assert.ok(f.untouched());
  }
});

test('read returns a detached current snapshot and never draws', () => {
  const f = fixture();
  const result = f.read();
  assert.deepEqual(result, { ok: true, kind: 'current', snapshot: pending() });
  result.snapshot.lot = 'changed';
  assert.equal(f.state.lot, 'Hamper');
  assert.deepEqual([f.selections.length, f.writes.length], [0, 0]);
  assert.equal(f.read().ok && f.read().snapshot.fact.origin, 'none');
  f.failLoad = true;
  const failed = f.read();
  assert.equal(failed.code, 'storage_failure');
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  const absent = fixture({ state: null }).read();
  assert.equal(absent.code, 'not_available');
  assert.equal(absent.message, 'No bingo lot is available.');
  assert.equal(f.call(BINGO_LOT_CHANNELS.read, id).code, 'invalid_request');
});

test('draw accepts only one exact plain data identity', () => {
  const f = fixture();
  let getterRan = false;
  const withGetter = { eventId: 'e1', presentationId: 'p1' };
  Object.defineProperty(withGetter, 'auditSequence', { enumerable: true, get() { getterRan = true; return 4; } });
  const withSymbol = { ...id, [Symbol('x')]: 1 };
  const hidden = { ...id }; Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
  class Identity { eventId = 'e1'; auditSequence = 4; presentationId = 'p1'; get nothing() { return 1; } }
  const bad: unknown[][] = [[], [id, id], [null], ['e1'], [[id]], [{ ...id, count: 3 }], [{ ...id, winner: 1 }],
    [{ eventId: 'e1', auditSequence: 4 }], [withGetter], [withSymbol], [hidden], [Object.create(id)],
    [new Identity()], [{ ...id, eventId: '' }], [{ ...id, presentationId: '' }], [{ ...id, eventId: 1 }],
    [{ ...id, auditSequence: 0 }], [{ ...id, auditSequence: 1.5 }], [{ ...id, auditSequence: '4' }],
    [{ ...id, auditSequence: Number.MAX_SAFE_INTEGER + 1 }]];
  for (const args of bad) assert.equal(f.draw(...args).code, 'invalid_request', `case ${bad.indexOf(args)}`);
  assert.equal(getterRan, false);
  assert.ok(f.untouched());
  assert.equal(f.draw(Object.assign(Object.create(null), id)).kind, 'committed');
});

test('ineligible, unfinished, busy, Tongo and stale states reject before entropy or write', () => {
  const cases: [string, any, Record<string, unknown>, unknown, string][] = [
    ['presentation pending', pending({ presentation: { id: 'p1', status: 'pending' } }), {}, id, 'presentation_busy'],
    ['presentation started', pending({ presentation: { id: 'p1', status: 'started' } }), {}, id, 'presentation_busy'],
    ['presentation failed', pending({ presentation: { id: 'p1', status: 'failed' } }), {}, id, 'presentation_busy'],
    ['presentation interrupted', pending({ presentation: { id: 'p1', status: 'interrupted' } }), {}, id, 'presentation_busy'],
    ['not required', pending({ fact: { origin: 'none', resolution: 'not_required' } }), {}, id, 'ineligible'],
    ['no lot', pending({ lot: '' }), {}, id, 'ineligible'],
    ['single winner', pending({ winnerCount: 1 }), {}, id, 'ineligible'],
    ['no award', null, {}, id, 'not_available'],
    ['coordinator busy', pending(), { busy: () => true }, id, 'presentation_busy'],
    ['Tongo playing', pending(), { tongoPlaying: () => true }, id, 'tongo_active'],
    ['stale event', pending(), {}, { ...id, eventId: 'e2' }, 'stale_identity'],
    ['stale audit', pending(), {}, { ...id, auditSequence: 5 }, 'stale_identity'],
    ['stale presentation', pending(), {}, { ...id, presentationId: 'p2' }, 'stale_identity'],
  ];
  for (const [name, state, ports, expected, code] of cases) {
    const f = fixture({ state, ports });
    const result = f.draw(expected);
    assert.equal(result.code, code, name);
    assert.doesNotMatch(result.message, /line/i, name);
    assert.deepEqual([f.selections.length, f.writes.length], [0, 0], name);
  }
  const unreadable = fixture();
  unreadable.failLoad = true;
  assert.equal(unreadable.draw(id).code, 'storage_failure');
  assert.deepEqual([unreadable.selections.length, unreadable.writes.length], [0, 0]);
});

test('an already resolved or legacy lot returns current state with zero entropy', () => {
  for (const state of [numbered(3, 'green'), legacy()]) {
    const f = fixture({ state });
    assert.deepEqual(f.draw(id), { ok: true, kind: 'current', snapshot: state });
    assert.deepEqual([f.selections.length, f.writes.length], [0, 0]);
  }
});

test('a successful draw selects once, writes once through resolveBingoLot with a copied identity, and is committed', () => {
  const f = fixture();
  const expected = { ...id };
  const result = f.draw(expected);
  assert.deepEqual(f.selections, [5]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { expected: id, result: { participantNumber: 2, colorId: 'blue' } });
  assert.notEqual(f.writes[0].expected, expected);
  assert.deepEqual(result, { ok: true, kind: 'committed', snapshot: numbered(2, 'blue') });
});

test('an unreadable acknowledgement requires an explicit read and never rerolls', () => {
  const f = fixture({ write: (state) => { state.state = numbered(2, 'blue'); state.failLoad = true; throw new Error('x'); } });
  const result = f.draw(id);
  assert.equal(result.code, 'read_required');
  assert.doesNotMatch(JSON.stringify(result), /line/i);
  f.failLoad = false;
  assert.deepEqual(f.read(), { ok: true, kind: 'current', snapshot: numbered(2, 'blue') });
  assert.equal(f.draw(id).kind, 'current');
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
  const gone = fixture({ write: (state) => { state.state = null; throw new Error('x'); } });
  assert.equal(gone.draw(id).code, 'stale_identity');
});

test('a failing selection writes nothing and releases the guard', () => {
  let fail = true;
  const f = fixture({ select: () => { if (fail) throw new Error('entropy'); return { participantNumber: 1, colorId: 'red' }; } });
  assert.equal(f.draw(id).code, 'selection_failed');
  assert.equal(f.writes.length, 0);
  fail = false;
  assert.equal(f.draw(id).kind, 'committed');
});

test('a reentrant draw attempt adds no selection or write and the guard is released afterwards', () => {
  let inner: any;
  const f = fixture({ select: () => { inner = f.draw(id); return { participantNumber: 3, colorId: 'green' }; } });
  assert.equal(f.draw(id).kind, 'committed');
  assert.equal(inner.code, 'draw_in_progress');
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
  assert.equal(f.draw(id).kind, 'current');
});

// Static public refresh: only a verified permanent numbered result reaches the port, once, and never changes the outcome.
const refreshFixture = (options: Parameters<typeof fixture>[0] = {}) => {
  const refreshed: any[] = [];
  const f = fixture({ ...options, ports: { refresh: (snapshot: any) => { refreshed.push(snapshot); }, ...options.ports } });
  return Object.assign(f, { refreshed });
};

test('a guarded commit refreshes the public view once with the verified numbered snapshot', () => {
  const f = refreshFixture();
  const result = f.draw(id);
  assert.equal(result.kind, 'committed');
  assert.deepEqual(f.refreshed, [numbered(2, 'blue')]);
  assert.notEqual(f.refreshed[0], result.snapshot);
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
});

test('source boundary: the adapter is inert reuse, never a Line channel, publisher or playback entry', () => {
  const ipc = readFileSync(new URL('../src/bingo-lot-ipc.ts', import.meta.url), 'utf8');
  assert.match(ipc, /registerLineLotIpc/); // shared rules come from the audited Line implementation, not a copy
  assert.doesNotMatch(ipc, /'line:/); // no Line channel literal is ever hardcoded or forwarded
  assert.doesNotMatch(ipc, /\bpublish\b|\bbegin\b|randomUUID|presentation-wiring|preload/);
});
