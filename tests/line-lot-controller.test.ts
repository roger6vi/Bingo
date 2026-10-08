import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineLotController } from '../src/line-lot-controller.mjs';
import { LINE_LOT_PALETTE, participantColor } from '../src/line-lot-contract.ts';

const ID = { eventId: 'e1', auditSequence: 4, presentationId: 'p1' };
const pending = (over: Record<string, unknown> = {}): any => ({ eventId: 'e1', auditSequence: 4, winnerCount: 5,
  lot: 'Hamper', presentation: { id: 'p1', status: 'completed' }, fact: { origin: 'none', resolution: 'pending' }, ...over });
const numbered = (participantNumber: number, colorId: string, over: Record<string, unknown> = {}): any => pending({
  fact: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber, colorId }, ...over });
const legacy = (): any => pending({ fact: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' } });
const ok = (snapshot: unknown, kind = 'current'): any => ({ ok: true, kind, snapshot });
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

function fixture(first: any = ok(pending()), context: any = { eventId: 'e1', busy: false, tongoPlaying: false }) {
  const f: any = { reads: 0, draws: [] as unknown[], celebrate: 0, renders: [] as any[], committed: [] as unknown[],
    read: () => first, draw: () => ok(numbered(3, 'green'), 'committed') };
  const api = { readLineLot: async () => { f.reads++; return f.read(); },
    drawLineLot: async (id: unknown) => { f.draws.push(id); return f.draw(); },
    celebrate: () => { f.celebrate++; } };
  const c = createLineLotController(api, { render: (s: any) => f.renders.push(s) },
    { onCommitted: (s: unknown) => f.committed.push(s) });
  f.c = c; f.state = () => c.getState(); f.ctx = (over: object = {}) => c.setContext({ ...context, ...over });
  return f;
}
async function ready(first?: any, context?: any) { const f = fixture(first, context); f.ctx(); await f.c.start(); return f; }

test('startup is read-only: numbered, legacy and unnamed contexts', async () => {
  const f = fixture(); assert.equal(f.state().status, 'unknown');
  await f.c.start(); assert.deepEqual([f.reads, f.draws.length], [0, 0]); // no context yet: nothing to ask
  f.ctx(); const reading = f.c.resync(); assert.equal(f.state().status, 'loading'); await reading;
  assert.deepEqual([f.reads, f.draws.length, f.state().status, f.state().canDraw], [1, 0, 'actionable', true]);
  const n = await ready(ok(numbered(3, 'green')));
  assert.deepEqual([n.state().status, n.state().winner, n.state().canDraw, n.draws.length],
    ['resolved', { kind: 'number', participantNumber: 3, colorId: 'green' }, false, 0]);
  const l = await ready(ok(legacy())); assert.deepEqual([l.state().status, l.state().winner], ['resolved', { kind: 'unknown' }]);
  const r = await ready(ok(pending({ winnerCount: 1, fact: { origin: 'none', resolution: 'not_required' } })));
  assert.deepEqual([r.state().status, r.state().winner, r.state().canDraw], ['resolved', null, false]);
});

test('only completed, pending, tied, non-empty lots with an idle context can draw', async () => {
  const cases: [string, any, any?][] = [
    ['not_required', pending({ fact: { origin: 'none', resolution: 'not_required' } })],
    ['started', pending({ presentation: { id: 'p1', status: 'started' } })],
    ['pending presentation', pending({ presentation: { id: 'p1', status: 'pending' } })],
    ['failed', pending({ presentation: { id: 'p1', status: 'failed' } })],
    ['interrupted', pending({ presentation: { id: 'p1', status: 'interrupted' } })],
    ['single winner', pending({ winnerCount: 1 })], ['empty lot', pending({ lot: '' })],
    ['busy', pending(), { eventId: 'e1', busy: true }], ['tongo', pending(), { eventId: 'e1', tongoPlaying: true }]];
  for (const [name, snapshot, context] of cases) {
    const f = await ready(ok(snapshot), context);
    assert.equal(f.state().canDraw, false, name); await f.c.draw(); assert.equal(f.draws.length, 0, name);
  }
  const f = await ready(ok(pending()), { eventId: 'e1', busy: true });
  assert.equal(f.state().status, 'pending'); f.ctx({ busy: false }); assert.equal(f.state().canDraw, true);
  f.ctx({ tongoPlaying: true }); assert.equal(f.state().canDraw, false);
  const w = await ready(ok(pending()), { eventId: 'other' }); // reply for a different event than the page's
  assert.deepEqual([w.state().status, w.state().canDraw, w.state().snapshot], ['recovery', false, null]);
  const n = fixture(); await n.c.draw(); assert.equal(n.draws.length, 0);
});

test('deferred double clicks send one exact draw and invent no winner before the ack', async () => {
  const f = await ready(); const gate = deferred(); f.draw = () => gate.promise;
  const first = f.c.draw(); const second = f.c.draw();
  assert.equal(f.state().status, 'pending'); assert.deepEqual([f.state().busy, f.state().canDraw, f.state().winner], [true, false, null]);
  await tick(); assert.deepEqual(f.draws, [ID]); assert.equal(f.reads, 1);
  await f.c.resync(); assert.equal(f.reads, 1); // read cannot overlap a draw
  gate.resolve(ok(numbered(3, 'green'), 'committed')); await Promise.all([first, second]);
  assert.equal(f.draws.length, 1);
  assert.deepEqual([f.state().status, f.state().source, f.state().winner, f.state().busy],
    ['resolved', 'committed', { kind: 'number', participantNumber: 3, colorId: 'green' }, false]);
  assert.equal(f.committed.length, 1); assert.equal((f.committed[0] as any).fact.participantNumber, 3);
  await f.c.draw(); assert.equal(f.draws.length, 1);
});

test('current and recovered replies are never reported as committed draws', async () => {
  const f = await ready(); f.draw = () => ok(numbered(2, 'blue'), 'current'); await f.c.draw();
  assert.deepEqual([f.state().status, f.state().source, f.committed.length], ['resolved', 'current', 0]);
  const g = await ready(); g.draw = () => ok(pending(), 'recovered'); await g.c.draw();
  assert.deepEqual([g.state().status, g.state().source, g.state().winner, g.state().canDraw, g.committed.length],
    ['actionable', 'recovered', null, true, 0]);
  const h = await ready(); h.draw = () => ok(pending(), 'committed'); await h.c.draw(); // ack without a winner
  assert.equal(h.state().status, 'recovery'); assert.equal(h.committed.length, 0);
});

test('failures enter read-only recovery until an explicit read succeeds', async () => {
  const replies: [string, () => any][] = [
    ['throw', () => { throw new Error('secret'); }], ['reject', () => Promise.reject(new Error('x'))],
    ['malformed', () => ({ nope: true })], ['null', () => null],
    ['stale', () => ({ ok: false, code: 'stale_identity', message: 'changed' })],
    ['read_required', () => ({ ok: false, code: 'read_required', message: 'read' })],
    ['other identity', () => ok(pending({ presentation: { id: 'p2', status: 'completed' } }), 'committed')]];
  for (const [name, reply] of replies) {
    const f = await ready(); f.draw = reply; await f.c.draw();
    assert.deepEqual([f.state().status, f.state().canDraw], ['recovery', false], name);
    assert.doesNotMatch(String(f.state().message), /secret/);
    await f.c.draw(); assert.equal(f.draws.length, 1, `${name}: no retry`);
    f.read = () => ({ ok: false, code: 'storage_failure', message: 'down' }); await f.c.resync();
    assert.deepEqual([f.state().status, f.state().canDraw], ['recovery', false], `${name}: failed read`);
    await f.c.draw(); assert.equal(f.draws.length, 1);
    f.read = () => ok(pending()); await f.c.resync();
    assert.deepEqual([f.state().status, f.state().canDraw], ['actionable', true], `${name}: read unlocks`);
  }
  const f = fixture(); f.read = () => ({ ok: false, code: 'not_available', message: 'none' }); f.ctx(); await f.c.start();
  assert.deepEqual([f.state().status, f.state().canDraw], ['error', false]);
});

test('a context switch resets, resyncs read-only and ignores late replies', async () => {
  const f = fixture(); const late = deferred(); f.read = () => late.promise; f.ctx(); const oldRead = f.c.start();
  f.read = () => ok(pending({ eventId: 'e2' })); f.ctx({ eventId: 'e2' }); await tick();
  assert.deepEqual([f.reads, f.state().snapshot.eventId, f.draws.length], [2, 'e2', 0]);
  late.resolve(ok(numbered(1, 'red'))); await oldRead; await tick();
  assert.deepEqual([f.state().snapshot.eventId, f.state().status], ['e2', 'actionable']);
  const gate = deferred(); f.draw = () => gate.promise; const drawing = f.c.draw(); await tick();
  assert.deepEqual(f.draws, [{ ...ID, eventId: 'e2' }]);
  f.read = () => new Promise(() => {}); f.ctx({ eventId: 'e3' }); assert.deepEqual([f.state().status, f.state().snapshot], ['loading', null]);
  gate.resolve(ok(numbered(2, 'blue', { eventId: 'e2' }), 'committed')); await drawing;
  assert.deepEqual([f.state().status, f.state().snapshot, f.committed.length], ['loading', null, 0]);
});

test('a resolved winner never regresses from a later stale reply', async () => {
  const f = await ready(ok(numbered(3, 'green')));
  for (const stale of [pending(), numbered(4, 'yellow'), pending({ auditSequence: 3 }), numbered(1, 'red', { auditSequence: 3 })]) {
    f.read = () => ok(stale); await f.c.resync();
    assert.deepEqual(f.state().winner, { kind: 'number', participantNumber: 3, colorId: 'green' });
  }
  f.read = () => ok(pending({ auditSequence: 5, presentation: { id: 'p2', status: 'completed' } })); await f.c.resync();
  assert.deepEqual([f.state().status, f.state().snapshot.auditSequence], ['actionable', 5]);
});

test('palette v1 colors are O(1) and match the persisted contract', async () => {
  for (let n = 1; n <= 13; n++) {
    const f = await ready(ok(numbered(n, participantColor(n).id, { winnerCount: 13 })));
    assert.equal(f.state().winner.colorId, LINE_LOT_PALETTE.colors[(n - 1) % 6].id);
  }
  const seven = await ready(ok(numbered(7, 'red', { winnerCount: 7 }))); assert.equal(seven.state().winner.colorId, 'red');
  const big = Number.MAX_SAFE_INTEGER;
  const max = await ready(ok(numbered(big, participantColor(big).id, { winnerCount: big })));
  assert.equal(max.state().winner.participantNumber, big);
  const huge = await ready(ok(pending({ winnerCount: big }))); assert.equal(huge.state().canDraw, true);
});

test('invalid ranges, colors, versions, provenance and getters are rejected before any action', async () => {
  const res = (fact: object, over: object = {}) => pending({ fact, ...over });
  const num = (over: object, top: object = {}) => res({ origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 3, colorId: 'green', ...over }, top);
  const getter = pending(); Object.defineProperty(getter, 'lot', { enumerable: true, get: () => 'Hamper' });
  const bad: unknown[] = [num({ colorId: 'red' }), num({ participantNumber: 6 }), num({ participantNumber: 0 }), num({ participantNumber: 1.5 }),
    num({ paletteVersion: 2 }), num({ extra: 1 }), num({ colorId: undefined }), num({}, { winnerCount: 1 }), num({}, { lot: '' }),
    num({}, { presentation: { id: 'p1', status: 'started' } }), res({ origin: 'weird', resolution: 'pending' }),
    res({ origin: 'none', resolution: 'resolved' }), res({ origin: 'none', resolution: 'pending', participantNumber: 1 }),
    res({ origin: 'legacy_v8', resolution: 'resolved', winner: 3 }), res({ origin: 'legacy_v8', resolution: 'pending', winner: 'unknown' }),
    res({ origin: 'none', resolution: 'unknown' }), pending({ winnerCount: 0 }), pending({ winnerCount: 1.5 }), pending({ lot: 7 }),
    pending({ eventId: '' }), pending({ auditSequence: 0 }), pending({ presentation: { id: '', status: 'completed' } }),
    pending({ presentation: { id: 'p1', status: 'bogus' } }), pending({ presentation: { id: 'p1', status: 'completed', x: 1 } }),
    pending({ extra: 1 }), getter, [pending()], Object.create(pending()), pending({ fact: [] })];
  for (const snapshot of bad) {
    const f = await ready(ok(snapshot)); assert.deepEqual([f.state().status, f.state().canDraw, f.state().snapshot], ['recovery', false, null], JSON.stringify(snapshot));
    await f.c.draw(); assert.equal(f.draws.length, 0);
  }
  for (const reply of [{ ok: true, kind: 'bogus', snapshot: pending() }, { ok: true, kind: 'current', snapshot: pending(), x: 1 }, { ok: 'yes' }]) {
    const f = await ready(reply); assert.equal(f.state().status, 'recovery');
  }
});

test('state is detached and frozen, ordinary context untouched, no celebration, dispose is final', async () => {
  const raw = pending(); const context = Object.freeze({ eventId: 'e1', busy: false, tongoPlaying: false, drawBlocked: false, liveBlocked: false });
  const f = await ready(ok(raw), context);
  raw.lot = 'Changed'; raw.presentation.id = 'p9';
  assert.deepEqual([f.state().snapshot.lot, f.state().snapshot.presentation.id], ['Hamper', 'p1']);
  assert.ok(Object.isFrozen(f.state()) && Object.isFrozen(f.state().snapshot) && Object.isFrozen(f.state().snapshot.fact));
  await f.c.draw(); f.draw = () => { throw new Error('x'); }; assert.equal(f.celebrate, 0);
  assert.deepEqual(context, { eventId: 'e1', busy: false, tongoPlaying: false, drawBlocked: false, liveBlocked: false });
  const gate = deferred(); f.read = () => gate.promise; const reading = f.c.resync(); const before = f.renders.length;
  f.c.dispose(); gate.resolve(ok(numbered(1, 'red'))); await reading;
  assert.equal(f.renders.length, before); f.ctx({ eventId: 'e5' }); await f.c.draw(); await f.c.resync();
  assert.deepEqual([f.reads, f.celebrate], [2, 0]);
});

test('contradictory none/legacy facts recover; valid unnamed or single-winner facts resolve without a winner', async () => {
  const none = (resolution: string, over: object = {}) => pending({ fact: { origin: 'none', resolution }, ...over });
  const old = (over: object = {}) => pending({ fact: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' }, ...over });
  for (const s of [none('pending', { winnerCount: 1 }), none('pending', { lot: '' }), none('not_required'), old({ winnerCount: 1 }), old({ lot: '' })]) {
    const f = await ready(ok(s)); assert.deepEqual([f.state().status, f.state().canDraw], ['recovery', false], JSON.stringify(s));
  }
  for (const s of [none('not_required', { winnerCount: 1 }), none('not_required', { lot: '' })]) {
    const f = await ready(ok(s)); assert.deepEqual([f.state().status, f.state().winner, f.state().canDraw, f.draws.length], ['resolved', null, false, 0]);
  }
  const l = await ready(ok(old({ presentation: { id: 'p1', status: 'started' } }))); // old incomplete presentation stays supported
  assert.deepEqual([l.state().status, l.state().winner], ['resolved', { kind: 'unknown' }]);
});

test('failed reads with storage_failure/read_required lock a known pending lot until a read succeeds', async () => {
  for (const code of ['storage_failure', 'read_required']) {
    const f = await ready(); f.read = () => ({ ok: false, code, message: 'x' }); await f.c.resync();
    assert.deepEqual([f.state().status, f.state().canDraw], ['recovery', false], code);
    await f.c.draw(); await f.c.resync(); assert.deepEqual([f.draws.length, f.state().canDraw], [0, false], `${code}: still locked`);
    f.read = () => ok(pending()); await f.c.resync(); assert.deepEqual([f.state().status, f.state().canDraw], ['actionable', true], code);
  }
});

test('a stale draw ack never replaces a resolved read or re-emits a commit', async () => {
  for (const [read, name] of [[numbered(4, 'yellow'), 'other winner'], [numbered(3, 'green'), 'same fact']] as [any, string][]) {
    const f = await ready(); const gate = deferred(); f.draw = () => gate.promise; const drawing = f.c.draw(); await tick();
    f.read = () => ok(read); await f.c.start(); gate.resolve(ok(numbered(3, 'green'), 'committed')); await drawing;
    const expected = { kind: 'number', participantNumber: read.fact.participantNumber, colorId: read.fact.colorId };
    assert.deepEqual([f.state().winner, f.state().status, f.committed.length, f.draws.length], [expected, 'resolved', 0, 1], name);
    assert.equal(f.state().winner.participantNumber, read.fact.participantNumber, name);
  }
});

test('a late draw ack never unlocks a read-required recovery; only an explicit read does', async () => {
  const replies: [string, any][] = [['current', ok(pending())], ['recovered', ok(pending(), 'recovered')],
    ['current resolved', ok(numbered(3, 'green'))], ['committed', ok(numbered(3, 'green'), 'committed')]];
  for (const code of ['storage_failure', 'read_required']) for (const [name, ack] of replies) {
    const f = await ready(); const gate = deferred(); f.draw = () => gate.promise; const drawing = f.c.draw(); await tick();
    f.read = () => ({ ok: false, code, message: 'x' }); await f.c.start(); gate.resolve(ack); await drawing;
    const tag = `${code}/${name}`; assert.deepEqual([f.state().status, f.state().canDraw, f.state().winner, f.committed.length], ['recovery', false, null, 0], tag);
    assert.equal(f.renders.at(-1), f.state(), tag); await f.c.draw(); await tick(); assert.deepEqual([f.draws.length, f.reads], [1, 2], tag);
    f.read = () => ok(pending()); await f.c.resync(); assert.deepEqual([f.state().status, f.state().canDraw], ['actionable', true], tag);
    await f.c.draw(); assert.equal(f.draws.length, 2, tag);
  }
});
