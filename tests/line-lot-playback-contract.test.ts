import assert from 'node:assert/strict';
import test from 'node:test';
import { dataCopy, knownWinner, sameWinner, validSignal } from '../src/line-lot-playback-contract.mjs';
import { ID, adversarialSignals, award, colorOf, nonPlayableAwards, playbackFixture, signal }
  from './fixtures/line-lot-playback-cases.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const trapped = (trap: string) => new Proxy({ a: 1 }, { [trap]() { throw new Error(`ran ${trap}`); } });

test('dataCopy returns detached own-data copies of plain and null-prototype objects', () => {
  const source = { a: 1, nested: { b: 2 } };
  const copy = dataCopy(source, null);
  assert.deepEqual(copy, { a: 1, nested: { b: 2 } });
  assert.notEqual(copy, source);
  copy.a = 9;
  assert.equal(source.a, 1);
  const bare = Object.assign(Object.create(null), { x: 1, y: 2 });
  assert.deepEqual(dataCopy(bare, ['y', 'x']), { x: 1, y: 2 });
  assert.equal(Object.getPrototypeOf(dataCopy(bare, null)), Object.prototype);
});

test('dataCopy rejects non-plain, accessor, symbol, non-enumerable and wrong-keyset values', () => {
  let ran = false;
  const accessor = { a: 1 };
  Object.defineProperty(accessor, 'b', { enumerable: true, get() { ran = true; return 2; } });
  const hidden = { a: 1 };
  Object.defineProperty(hidden, 'b', { enumerable: false, value: 2 });
  class Point { a = 1; }
  const rejected = [null, 'x', 7, [], new Point(), Object.create({ a: 1 }), accessor, hidden, { a: 1, [Symbol('s')]: 2 }];
  for (const value of rejected) assert.equal(dataCopy(value, null), null);
  assert.equal(ran, false);
  assert.equal(dataCopy({ a: 1 }, ['a', 'b']), null);
  assert.equal(dataCopy({ a: 1, b: 2, c: 3 }, ['a', 'b']), null);
  assert.deepEqual(dataCopy({ a: 1, b: 2 }, ['b', 'a']), { a: 1, b: 2 });
});

test('dataCopy keeps own __proto__ as data and survives throwing proxy traps', () => {
  const copy = dataCopy(JSON.parse('{"__proto__":{"polluted":true},"a":1}'), null);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal(copy.polluted, undefined);
  assert.deepEqual(Object.keys(copy), ['__proto__', 'a']);
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    assert.equal(dataCopy(trapped(trap), null), null, trap);
    assert.equal(knownWinner(trapped(trap)), undefined, trap);
    assert.equal(validSignal(trapped(trap)), null, trap);
  }
});

test('knownWinner copies a numbered winner detached from the award', () => {
  const source = award('e1', 10, 3);
  const known = knownWinner(source);
  assert.deepEqual(known, { eventId: 'e1', winner: { participantNumber: 3, colorId: 'green' } });
  source.lotResult.participantNumber = 4;
  source.eventId = 'e2';
  assert.deepEqual(known, { eventId: 'e1', winner: { participantNumber: 3, colorId: 'green' } });
  assert.deepEqual(knownWinner(Object.assign(Object.create(null), award('e7', 12, 7))),
    { eventId: 'e7', winner: { participantNumber: 7, colorId: 'red' } });
});

test('knownWinner reports a null winner for valid legacy, pending, not-required and plain awards', () => {
  for (const a of [...nonPlayableAwards(), award('e1', 10, null)]) assert.deepEqual(knownWinner(a), { eventId: 'e1', winner: null });
});

test('knownWinner is undefined for invalid roots, results, accessors and coercion', () => {
  const getter = award();
  Object.defineProperty(getter, 'lot', { enumerable: true, get() { throw new Error('ran getter'); } });
  const badResult = (patch: object) => ({ ...award(), lotResult: { ...award().lotResult, ...patch } });
  const invalid = [undefined, null, 'x', [], getter, Object.create(award()), { ...award(), shareCents: 99 },
    { ...award(), remainderCents: 1 }, { ...award(), eventId: ' ' }, { ...award(), totalCents: 1050 },
    { ...award(), lotResult: [] }, { ...award(), lotResult: Object.create(award().lotResult) },
    badResult({ participantNumber: '3' }), badResult({ participantNumber: 0 }), badResult({ participantNumber: 11 }),
    badResult({ colorId: 'blue' }), badResult({ colorId: 'magenta' }), badResult({ paletteVersion: 2 }),
    { ...award(), lotResult: { origin: 'numbered_v1', resolution: 'pending' } },
    { ...award('e1', 10, null, 'pending'), lotResult: { origin: 'none', resolution: 'resolved' } }];
  for (const value of invalid) assert.equal(knownWinner(value), undefined);
});

test('knownWinner accepts MAX_SAFE_INTEGER winner numbers and repeated palette colours', () => {
  assert.deepEqual(knownWinner(award('e1', MAX, MAX)), { eventId: 'e1', winner: { participantNumber: MAX, colorId: colorOf(MAX) } });
  assert.equal(knownWinner(award('e1', 10, 7)).winner.colorId, knownWinner(award('e1', 10, 1)).winner.colorId);
});

test('validSignal returns a detached exact copy of a valid signal', () => {
  const source = signal(ID(1), 3, 'green');
  const copy = validSignal(source);
  assert.deepEqual(copy, { id: ID(1), participantNumber: 3, colorId: 'green' });
  assert.notEqual(copy, source);
  source.participantNumber = 4;
  assert.equal(copy.participantNumber, 3);
  assert.deepEqual(validSignal(Object.assign(Object.create(null), signal(ID(2), 1, 'red'))), signal(ID(2), 1, 'red'));
});

test('validSignal accepts boundary ids, MAX_SAFE numbers and repeated palette colours without caps', () => {
  assert.notEqual(validSignal(signal('x'.repeat(128))), null);
  assert.equal(validSignal(signal('x'.repeat(129))), null);
  assert.notEqual(validSignal(signal(ID(1), MAX, colorOf(MAX))), null);
  assert.equal(validSignal(signal(ID(1), MAX + 1, colorOf(1))), null);
  for (const number of [1, 7, 13, 91, 1000]) assert.deepEqual(validSignal(signal(ID(number), number, colorOf(number)))?.participantNumber, number);
  assert.equal(validSignal(signal(ID(1), 3, colorOf(3))).colorId, validSignal(signal(ID(2), 9, colorOf(9))).colorId);
});

test('validSignal rejects zero, negative, NaN, Infinity, coerced and unknown-colour values', () => {
  for (const n of [0, -1, NaN, Infinity, 1.5, '3', 3n, null]) assert.equal(validSignal(signal(ID(1), n as any, 'green')), null);
  for (const id of ['', 7, null]) assert.equal(validSignal(signal(id as any)), null);
  for (const colorId of ['magenta', 'Green', '', 3, null]) assert.equal(validSignal(signal(ID(1), 3, colorId as any)), null);
});

test('validSignal classifies all adversarial vectors; mismatched number/colour stay structurally valid for B', () => {
  const vectors = adversarialSignals();
  assert.equal(vectors.length, 14);
  const accepted = vectors.map((v, i) => (validSignal(v) === null ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(accepted, [9, 10, 11]);
  assert.notEqual(adversarialSignals()[4], vectors[4]);
});

test('sameWinner compares typed winners and null exactly', () => {
  const winner = { participantNumber: 3, colorId: 'green' };
  assert.equal(sameWinner(null, null), true);
  assert.equal(sameWinner(winner, winner), true);
  assert.equal(sameWinner(winner, { ...winner }), true);
  assert.equal(sameWinner(winner, null), false);
  assert.equal(sameWinner(null, winner), false);
  assert.equal(sameWinner(winner, { ...winner, participantNumber: 4 }), false);
  assert.equal(sameWinner(winner, { ...winner, colorId: 'red' }), false);
});

test('shared fixtures return fresh data on every call', () => {
  assert.notEqual(award(), award());
  assert.notEqual(signal(), signal());
  const [a, b] = [nonPlayableAwards(), nonPlayableAwards()];
  assert.equal(a.length, 3);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  assert.equal(nonPlayableAwards()[0].eventId, 'e1');
});

test('playbackFixture drives a constructor-injected inert factory through every port', () => {
  let options: any;
  const f = playbackFixture((o: any) => { options = o; return { observeAward() {}, observeFrame() {} }; });
  assert.equal(f.hasHandler(), false);
  const unsubscribe = options.subscribe((s: unknown) => f.views.push(s as any));
  f.send({ participantNumber: 3, colorId: 'green' });
  assert.deepEqual([f.hasHandler(), f.views.length], [true, 1]);
  options.onChange({ participantNumber: 3, colorId: 'green' });
  options.onChange(null);
  const id = options.setTimer(() => f.log.push('fired'), 4000);
  options.setTimer(() => f.log.push('late'), 9000);
  f.advance(4000);
  assert.deepEqual(f.delays, [4000, 9000]);
  assert.equal(f.timers.size, 1);
  options.clearTimer(id + 1);
  unsubscribe();
  assert.deepEqual([f.timers.size, f.hasHandler(), f.unsubscriptions()], [0, false, 1]);
  assert.deepEqual(f.log, ['view', 'hide', 'fired', 'clear']);
  f.confirm();
});
