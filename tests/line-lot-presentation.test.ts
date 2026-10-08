import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { LINE_LOT_CHANNELS } from '../src/line-lot-ipc.ts';
import { LINE_LOT_PRESENT_CHANNEL, registerLineLotPresentation } from '../src/line-lot-presentation.ts';

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => any;
const url = 'file:///app/operator.html';
const id = { eventId: 'e1', auditSequence: 4, presentationId: 'p1' };
const lot = (fact: object = { origin: 'none', resolution: 'pending' }): any => ({ eventId: 'e1', auditSequence: 4,
  winnerCount: 5, lot: 'Hamper', presentation: { id: 'p1', status: 'completed' }, fact });
const won = (participantNumber = 2, colorId = 'blue'): any => lot({ origin: 'numbered_v1', resolution: 'resolved',
  paletteVersion: 1, participantNumber, colorId });
const legacy = () => lot({ origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' });

function fixture(write?: (f: any, r: any) => any, state: any = lot()) {
  const sender = {};
  const frame = { url };
  let current: { url: string } = frame;
  const handlers = new Map<string, Handler>();
  const f: any = { state, published: [] as any[], reads: 0, hooks: {} as Record<string, () => void>, pub: true };
  const store = {
    loadLineLotResult() { f.reads++; f.hooks.load?.(); return f.state; },
    resolveLineLot(_e: unknown, r: any) { if (write) return write(f, r); f.state = won(r.participantNumber, r.colorId); return f.state; },
  };
  const guard = createOperatorGuard(sender, () => current, url);
  f.present = registerLineLotPresentation({ handle: (c: string, h: Handler) => handlers.set(c, h) }, store, {
    authorize: (e: any) => { guard(e); f.hooks.auth?.(); },
    select: () => { f.hooks.select?.(); return { participantNumber: 2, colorId: 'blue' }; },
    publish: (signal: unknown) => { f.published.push(signal); f.hooks.publish?.(); if (f.fail) throw new Error('x'); return f.pub; },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender, senderFrame: current }, ...args);
  return Object.assign(f, { sender, frame, handlers, call, setFrame: (n: any) => { current = n; },
    draw: () => call(LINE_LOT_CHANNELS.draw, id), send: (...a: unknown[]) => call(LINE_LOT_PRESENT_CHANNEL, ...a) });
}
const clone = (s: any): any => structuredClone(s);

test('own committed draw hands off once, with an opaque whitelisted signal', () => {
  const f = fixture();
  const r = f.draw();
  assert.equal(r.kind, 'committed');
  assert.deepEqual(f.send(r.snapshot), { ok: true });
  assert.deepEqual(Object.keys(f.published[0]).sort(), ['colorId', 'id', 'participantNumber']);
  assert.deepEqual([f.published[0].participantNumber, f.published[0].colorId, typeof f.published[0].id], [2, 'blue', 'string']);
  assert.equal(f.send(r.snapshot).code, 'ineligible');
  assert.equal(f.published.length, 1);
});

test('stored-only, current, read, recovered, write-then-throw and legacy facts are never eligible', () => {
  const cases: [string, any, (f: any) => void][] = [
    ['stored only', fixture(undefined, won()), () => {}],
    ['current', fixture(undefined, won()), (f) => assert.equal(f.draw().kind, 'current')],
    ['read', fixture(undefined, won()), (f) => assert.equal(f.call(LINE_LOT_CHANNELS.read).kind, 'current')],
    ['recovered', fixture((f, r) => { f.state = won(r.participantNumber, r.colorId); throw new Error('ack'); }),
      (f) => assert.equal(f.draw().kind, 'recovered')],
    ['legacy', fixture(undefined, legacy()), (f) => f.call(LINE_LOT_CHANNELS.read)],
  ];
  for (const [, f, act] of cases) { act(f); assert.match(f.send(f.state).code, /^(ineligible|invalid_request)$/); assert.equal(f.published.length, 0); }
});

test('every tuple mismatch rejects without consuming the valid handoff', () => {
  const edits: ((s: any) => void)[] = [(s) => { s.eventId = 'e2'; }, (s) => { s.auditSequence = 5; }, (s) => { s.winnerCount = 6; },
    (s) => { s.lot = 'Other'; }, (s) => { s.presentation.id = 'p2'; }, (s) => { s.presentation.status = 'started'; },
    (s) => { s.fact.participantNumber = 3; }, (s) => { s.fact.participantNumber = 8; }, (s) => { s.fact.colorId = 'red'; },
    (s) => { s.fact.paletteVersion = 2; }, (s) => { s.fact.origin = 'legacy_v8'; }, (s) => { s.fact.resolution = 'pending'; }];
  for (const edit of edits) {
    const f = fixture();
    const r = f.draw();
    const bad = clone(r.snapshot);
    edit(bad);
    assert.equal(f.send(bad).ok, false);
    assert.equal(f.published.length, 0);
    assert.equal(f.send(r.snapshot).ok, true);
  }
});

test('malformed shapes and accessors reject before any getter and keep the handoff', () => {
  const f = fixture();
  const r = f.draw();
  let getters = 0;
  const withGetter = (target: any, key: string) => Object.defineProperty(target, key, { enumerable: true, get() { getters++; return 1; } });
  const shapes: unknown[] = [withGetter(clone(r.snapshot), 'lot'), (() => { const s = clone(r.snapshot); withGetter(s.fact, 'colorId'); return s; })(),
    { ...clone(r.snapshot), extra: 1 }, (() => { const s = clone(r.snapshot); s.fact.extra = 1; return s; })(),
    (() => { const s = clone(r.snapshot); s.presentation.extra = 1; return s; })(), { ...clone(r.snapshot), [Symbol('x')]: 1 },
    (() => { const s = clone(r.snapshot); delete s.lot; return s; })(), Object.assign(Object.create({ inherited: 1 }), clone(r.snapshot)),
    [], null, 'text', 7];
  for (const shape of shapes) assert.equal(f.send(shape).code, 'invalid_request');
  assert.deepEqual([f.send().code, f.send(r.snapshot, 1).code, getters, f.published.length], ['invalid_request', 'invalid_request', 0, 0]);
  assert.equal(f.send(r.snapshot).ok, true);
});

test('mutating the draw acknowledgement cannot alter the issued handoff', () => {
  const f = fixture();
  const r = f.draw();
  const original = clone(r.snapshot);
  r.snapshot.fact.participantNumber = 9;
  assert.equal(f.send(r.snapshot).code, 'stale_identity');
  assert.equal(f.send(original).ok, true);
});

test('a changed or unreadable fresh store rejects without consuming', () => {
  const f = fixture();
  const r = f.draw();
  f.state = won(3, 'green');
  assert.equal(f.send(r.snapshot).code, 'stale_identity');
  f.hooks.load = () => { throw new Error('private'); };
  assert.equal(f.send(r.snapshot).code, 'storage_failure');
  f.hooks.load = undefined;
  f.state = r.snapshot;
  assert.equal(f.send(r.snapshot).ok, true);
});

test('unauthorized, subframe and wrong URL fail before arguments are read; handoff survives', () => {
  const f = fixture();
  const r = f.draw();
  let touched = 0;
  const trap = new Proxy({}, { getPrototypeOf() { touched++; return null; }, ownKeys() { touched++; return []; }, get() { touched++; } });
  const handler = f.handlers.get(LINE_LOT_PRESENT_CHANNEL)!;
  assert.throws(() => handler({ sender: {}, senderFrame: f.frame }, trap), /Unauthorized/);
  assert.throws(() => handler({ sender: f.sender, senderFrame: { url } }, trap), /Unauthorized/);
  f.setFrame({ url: 'file:///other.html' });
  assert.throws(() => handler({ sender: f.sender, senderFrame: f.frame }, trap), /Unauthorized/);
  f.setFrame(f.frame);
  assert.deepEqual([touched, f.send(r.snapshot).ok], [0, true]);
});

test('invalidation during the draw, the fresh read or before submission voids the handoff', () => {
  const hooks: [string, (f: any) => void][] = [['select', (f) => { f.hooks.select = () => f.present.invalidate(); }],
    ['fresh read', (f) => { f.hooks.load = () => { if (f.reads === 2) f.present.invalidate(); }; }]];
  for (const [, arm] of hooks) {
    const f = fixture();
    arm(f);
    const r = f.draw();
    assert.equal(r.kind, 'committed');
    assert.equal(f.send(r.snapshot).code, 'ineligible');
  }
  const late = fixture();
  const r = late.draw();
  late.hooks.load = () => late.present.invalidate();
  assert.equal(late.send(r.snapshot).code, 'ineligible');
  late.hooks.load = undefined;
  assert.equal(late.send(r.snapshot).code, 'ineligible');
  assert.equal(late.published.length, 0);
});

test('same-frame same-URL reload and event away/back are invalidations; another frame is another actor', () => {
  for (const times of [1, 2]) {
    const f = fixture();
    const r = f.draw();
    for (let i = 0; i < times; i++) f.present.invalidate();
    assert.equal(f.send(r.snapshot).code, 'ineligible');
  }
  const f = fixture();
  const r = f.draw();
  f.setFrame({ url });
  assert.equal(f.send(r.snapshot).code, 'ineligible');
  assert.equal(f.published.length, 0);
});

test('publication is consumed before delivery: throw, absent target and reentrancy never repeat', () => {
  for (const arm of [(f: any) => { f.fail = true; }, (f: any) => { f.pub = false; },
    (f: any) => { f.hooks.publish = () => { f.again = f.send(f.last); }; }]) {
    const f = fixture();
    const r = f.draw();
    f.last = r.snapshot;
    arm(f);
    assert.deepEqual(f.send(r.snapshot), { ok: true });
    if (f.again !== undefined) assert.equal(f.again.code, 'ineligible');
    assert.equal(f.send(r.snapshot).code, 'ineligible');
    assert.equal(f.published.length, 1);
  }
});

const swaps: [string, (f: any) => void, (f: any) => void][] = [
  ['frame', (f) => f.setFrame({ url }), (f) => f.setFrame(f.frame)],
  ['url', (f) => { f.frame.url = 'file:///other.html'; }, (f) => { f.frame.url = url; }]];

test('present authorizes again after the fresh read: a swapped frame or URL rejects and keeps the handoff once', () => {
  for (const [, swap, restore] of swaps) {
    const f = fixture();
    const r = f.draw();
    f.hooks.load = () => swap(f);
    assert.throws(() => f.send(r.snapshot), /Unauthorized/);
    f.hooks.load = undefined;
    restore(f);
    assert.equal(f.published.length, 0);
    assert.deepEqual([f.send(r.snapshot).ok, f.send(r.snapshot).code, f.published.length], [true, 'ineligible', 1]);
  }
});

test('the draw mint authorizes after its fresh read: a swapped frame keeps the ack but issues no ticket', () => {
  for (const [, swap, restore] of swaps) {
    const f = fixture();
    f.hooks.load = () => { if (f.reads === 2) swap(f); };
    const r = f.draw();
    assert.deepEqual([r.kind, r.snapshot.fact.participantNumber], ['committed', 2]);
    f.hooks.load = undefined;
    restore(f);
    assert.equal(f.send(r.snapshot).code, 'ineligible');
    assert.equal(f.published.length, 0);
  }
});

test('an authorization that throws or invalidates after a fresh read fails closed', () => {
  const arm = (f: any, mode: string, nth: number) => {
    f.hooks.auth = () => { const m = f.armed; f.armed = ''; if (m === 'throw') throw new Error('private'); if (m === 'invalidate') f.present.invalidate(); };
    f.hooks.load = () => { if (f.reads === nth) f.armed = mode; };
  };
  for (const mode of ['throw', 'invalidate']) {
    const d = fixture();
    arm(d, mode, 2);
    const r = d.draw();
    assert.deepEqual([r.kind, r.snapshot.fact.participantNumber], ['committed', 2]);
    d.armed = '';
    assert.equal(d.send(r.snapshot).code, 'ineligible');
    const p = fixture();
    const q = p.draw();
    arm(p, mode, 3);
    if (mode === 'throw') assert.throws(() => p.send(q.snapshot), /^Error: Unauthorized event request$/);
    else assert.equal(p.send(q.snapshot).code, 'ineligible');
    assert.equal(p.published.length, 0);
    p.hooks.load = undefined;
    assert.equal(p.send(q.snapshot).ok, mode === 'throw');
  }
});
