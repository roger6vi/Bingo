import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { participantColor } from '../src/line-lot-contract.ts';
import { LINE_LOT_CHANNELS, registerLineLotIpc } from '../src/line-lot-ipc.ts';

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
  const f: any = { state: 'state' in options ? options.state : pending(), loads: 0, writes: [] as any[], selections: [] as number[],
    failLoad: false };
  const store = {
    loadLineLotResult() { f.loads++; if (f.failLoad) throw new Error('secret read'); return f.state; },
    resolveLineLot(expected: unknown, result: any) {
      f.writes.push({ expected, result });
      if (options.write) return options.write(f, expected, result);
      f.state = numbered(result.participantNumber, result.colorId);
      return f.state;
    },
  };
  registerLineLotIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, store, {
    authorize: createOperatorGuard(sender, () => frame, url),
    select: (count) => { f.selections.push(count); return options.select ? options.select(count)
      : { participantNumber: 2, colorId: 'blue' }; },
    ...options.ports });
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: frame }, ...args);
  Object.assign(f, { sender, call, setFrame: (next: any) => { frame = next; },
    read: () => call(LINE_LOT_CHANNELS.read), draw: (...args: unknown[]) => call(LINE_LOT_CHANNELS.draw, ...args),
    handlers, untouched: () => f.loads === 0 && f.writes.length === 0 && f.selections.length === 0 });
  return f;
}

test('registers exactly the two named operator channels', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()].sort(), ['line:lot:draw', 'line:lot:read']);
});

test('unauthorized senders, frames and URLs fail before store or entropy', () => {
  for (const channel of Object.values(LINE_LOT_CHANNELS)) {
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
  assert.equal(fixture({ state: null }).read().code, 'not_available');
  assert.equal(f.call(LINE_LOT_CHANNELS.read, id).code, 'invalid_request');
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
    assert.equal(f.draw(expected).code, code, name);
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

test('a successful draw selects once, writes once with a copied identity, and is committed', () => {
  const f = fixture();
  const expected = { ...id };
  const result = f.draw(expected);
  assert.deepEqual(f.selections, [5]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { expected: id, result: { participantNumber: 2, colorId: 'blue' } });
  assert.notEqual(f.writes[0].expected, expected);
  assert.deepEqual(result, { ok: true, kind: 'committed', snapshot: numbered(2, 'blue') });
});

test('a competitor-committed winner is returned as recovered without selecting again', () => {
  const f = fixture({ write: (state) => { state.state = numbered(4, 'yellow'); throw new Error('Line lot changed concurrently'); } });
  const result = f.draw(id);
  assert.deepEqual(result, { ok: true, kind: 'recovered', snapshot: numbered(4, 'yellow') });
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
});

test('a failure before commit rereads the pending lot without a second selection', () => {
  const f = fixture({ write: () => { throw new Error('secret write'); } });
  const result = f.draw(id);
  assert.deepEqual(result, { ok: true, kind: 'recovered', snapshot: pending() });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
});

test('a commit followed by a throw, or a mismatched acknowledgement, rereads the committed fact', () => {
  for (const ack of ['throw', 'wrong']) {
    const f = fixture({ write: (state, _e, r) => {
      state.state = numbered(r.participantNumber, r.colorId);
      if (ack === 'throw') throw new Error('lost acknowledgement');
      return numbered(5, 'purple');
    } });
    assert.deepEqual(f.draw(id), { ok: true, kind: 'recovered', snapshot: numbered(2, 'blue') }, ack);
    assert.deepEqual([f.selections.length, f.writes.length], [1, 1], ack);
  }
});

test('an unreadable acknowledgement requires an explicit read and never rerolls', () => {
  const f = fixture({ write: (state) => { state.state = numbered(2, 'blue'); state.failLoad = true; throw new Error('x'); } });
  const result = f.draw(id);
  assert.equal(result.code, 'read_required');
  f.failLoad = false;
  assert.deepEqual(f.read(), { ok: true, kind: 'current', snapshot: numbered(2, 'blue') });
  assert.equal(f.draw(id).kind, 'current');
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
  const gone = fixture({ write: (state) => { state.state = null; throw new Error('x'); } });
  assert.equal(gone.draw(id).code, 'stale_identity');
});

test('an unreadable acknowledgement latches draws until an authorized strict read succeeds', () => {
  const f = fixture({ write: (s) => { s.state = numbered(2, 'blue'); s.failLoad = true; throw new Error('x'); } });
  assert.equal(f.draw(id).code, 'read_required');
  const loads = f.loads;
  assert.equal(f.draw(id).code, 'read_required');
  assert.deepEqual([f.loads, f.selections.length, f.writes.length], [loads, 1, 1]);
  assert.equal(f.read().code, 'storage_failure');
  f.failLoad = false;
  assert.equal(f.call(LINE_LOT_CHANNELS.read, id).code, 'invalid_request');
  f.setFrame(null);
  assert.throws(() => f.read(), /Unauthorized/);
  f.setFrame({ url });
  assert.equal(f.draw(id).code, 'read_required');
  assert.equal(f.read().kind, 'current');
  assert.deepEqual(f.draw(id), { ok: true, kind: 'current', snapshot: numbered(2, 'blue') });
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
});

test('a latched pending lot stays latched on a null read and, once read, allows one explicit retry', () => {
  let broken = true;
  const f = fixture({ write: (s, _e, r) => { if (broken) { s.failLoad = true; throw new Error('x'); }
    s.state = numbered(r.participantNumber, r.colorId); return s.state; } });
  assert.equal(f.draw(id).code, 'read_required');
  f.failLoad = false;
  f.state = null;
  assert.equal(f.read().code, 'not_available');
  assert.equal(f.draw(id).code, 'read_required');
  f.state = pending();
  assert.equal(f.read().kind, 'current');
  broken = false;
  assert.equal(f.draw(id).kind, 'committed');
  assert.deepEqual([f.selections.length, f.writes.length], [2, 2]);
});

test('a mismatched acknowledgement recovers by reread, never commits or rerolls', () => {
  const resolved = (n: number) => ({ ...numbered(n, participantColor(n).id), winnerCount: 8 });
  const acks = [resolved(8), { ...resolved(2), eventId: 'e2' }, { ...resolved(2), auditSequence: 5 },
    { ...resolved(2), presentation: { id: 'p2', status: 'completed' } }];
  for (const ack of acks) {
    const f = fixture({ state: pending({ winnerCount: 8 }), write: (s, _e, r) => { s.state = resolved(r.participantNumber); return ack; } });
    assert.deepEqual(f.draw(id), { ok: true, kind: 'recovered', snapshot: resolved(2) });
    assert.deepEqual([f.loads, f.selections.length, f.writes.length], [2, 1, 1]);
  }
});

test('an explicit second request after a pre-commit failure selects and writes once more', () => {
  let tries = 0;
  const f = fixture({ write: (s, _e, r) => { if (tries++ === 0) throw new Error('x'); s.state = numbered(r.participantNumber, r.colorId); return s.state; } });
  assert.equal(f.draw(id).kind, 'recovered');
  assert.deepEqual([f.selections.length, f.writes.length], [1, 1]);
  assert.equal(f.draw(id).kind, 'committed');
  assert.deepEqual([f.selections.length, f.writes.length], [2, 2]);
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

test('source boundary: operator-named preload only, no public permission, no celebration side effect', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const preload = read('../src/preload.ts');
  assert.match(preload, /readLineLot: \(\) => ipcRenderer\.invoke\('line:lot:read'\)/);
  assert.match(preload, /drawLineLot: \(expected: \{[^}]*\}\) =>\s+ipcRenderer\.invoke\('line:lot:draw', expected\)/);
  assert.match(preload, /import type \{ LineLotSnapshot \} from '\.\/event-store';/);
  assert.match(preload, /presentLineLot: \(snapshot: LineLotSnapshot\) => ipcRenderer\.invoke\('line:lot:present', snapshot\)/);
  assert.doesNotMatch(read('../src/public-preload.ts'), /LineLot|line:lot/);
  const main = read('../src/main.ts');
  assert.match(main, /registerLineLotPresentation\(ipcMain, store, \{ authorize: operatorOnly,/);
  const ipc = read('../src/line-lot-ipc.ts');
  assert.doesNotMatch(ipc, /line-presentation|\bpublish\w*\(|\.begin\(|committed\?\./);
});
