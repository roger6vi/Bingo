import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { BINGO_CHANNELS, registerBingoIpc } from '../src/bingo-ipc.ts';
import { drawManual } from '../src/event-core.ts';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { createEventStore } from '../src/event-store.ts';

type Frame = { url: string };
type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;
type View = { sessionId: string; eventId: string; calledNumbers: number[]; bingoPrize: { amount: number; lot: string } };

const LINE = { auditSequence: 2, presentationId: 'lp', lotResolution: 'not_required' };
const baseline = (eventId = 'a', head = '2026-10-01T09:00:00.000Z') => ({ eventId, calledNumbers: [7, 42],
  phase: 'line_declared', lastTransitionAt: head, auditSequence: 3, bingoPrize: { amount: 20, lot: 'Jamón' }, line: LINE });
const storedAward = () => ({ eventId: 'a', presentation: { id: 'bp', status: 'pending', startedAt: null, deadlineAt: null },
  award: { winnerCount: 1, totalCents: 2000, shareCents: 2000, remainderCents: 0, lot: 'Jamón', lotResolution: 'pending' } });
const notEligible = () => Object.assign(new Error('secret not eligible'), { code: 'bingo_not_eligible' });

function fixture(ports: Record<string, unknown> = {}) {
  const sender = {};
  const url = 'file:///app/operator.html';
  let frame: Frame = { url };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const state: { base: ReturnType<typeof baseline> | null; returned: ReturnType<typeof baseline> | null; award: unknown;
    fail: string | null } = { base: baseline(), returned: null, award: null, fail: null };
  const store = {
    loadBingoDeclarationBaseline() {
      calls.push('baseline');
      if (state.fail === 'baseline') throw new Error('secret corrupt');
      if (state.base === null) throw notEligible();
      state.returned = structuredClone(state.base);
      return state.returned;
    },
    loadBingoAward() {
      calls.push('award');
      if (state.fail === 'award') throw new Error('secret read');
      return state.award;
    },
    declareBingoDirectly() { calls.push('WRITE'); throw new Error('no writes'); },
    update() { calls.push('WRITE'); throw new Error('no writes'); },
  };
  const playback: string[] = [];
  const bingo = registerBingoIpc({ handle: (channel: string, handler: Handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, { authorize: createOperatorGuard(sender, () => frame, url),
    retry: () => playback.push('retry'), repeat: () => playback.push('repeat'), committed: () => playback.push('committed'),
    ...ports });
  const invoke = (channel: string, args: unknown[] = [], fromFrame: object | null = frame, from: object = sender) =>
    handlers.get(channel)!({ sender: from, senderFrame: fromFrame }, ...args) as Record<string, unknown>;
  return { invoke, handlers, calls, bingo, sender, state, playback, get frame() { return frame; },
    reload() { frame = { url }; return frame; } };
}
const begin = (f: ReturnType<typeof fixture>) => {
  const result = f.invoke(BINGO_CHANNELS.begin);
  assert.equal(result.state, 'setup', JSON.stringify(result));
  return result.session as View;
};
const code = (result: Record<string, unknown>) => [result.ok, result.code];
const STALE = { ok: false, code: 'stale_session', message: 'This Bingo setup is no longer current. Reopen it.' };

test('registers only the three setup channels and rejects wrong sender, frame or URL before any store access', () => {
  const f = fixture();
  assert.deepEqual(Object.values(BINGO_CHANNELS), ['bingo:begin', 'bingo:read', 'bingo:cancel']);
  assert.deepEqual([...f.handlers.keys()], Object.values(BINGO_CHANNELS));
  for (const channel of Object.values(BINGO_CHANNELS)) {
    assert.throws(() => f.invoke(channel, [], f.frame, {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], null), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], { url: 'file:///app/operator.html' }), /Unauthorized/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.bingo.active(), false);
  // Same accepted sender and the same current main frame object; only its page URL changes.
  const wrongUrl = fixture();
  const view = begin(wrongUrl);
  const owner = wrongUrl.frame;
  owner.url = 'https://evil.example/operator.html';
  for (const [channel, args] of [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
    [BINGO_CHANNELS.cancel, [view.sessionId, 'a']]] as const) {
    assert.throws(() => wrongUrl.invoke(channel, [...args], owner, wrongUrl.sender), /Unauthorized/);
  }
  assert.deepEqual(wrongUrl.calls, ['baseline'], 'no store read after the URL changed');
  assert.equal(wrongUrl.bingo.active(), true);
  owner.url = 'file:///app/operator.html';
  assert.deepEqual(wrongUrl.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'], owner),
    { ok: true, state: 'cancelled' }, 'the session and its owner were untouched');
});

test('strict arity and exact typing reject malformed or extra arguments before any store access', () => {
  const f = fixture();
  const invalid = { ok: false, code: 'invalid_request', message: 'Invalid Bingo request.' };
  assert.deepEqual(f.invoke(BINGO_CHANNELS.begin, [1]), invalid);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.begin, [undefined]), invalid);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.read, [{}]), invalid);
  for (const args of [[], ['s'], ['s', 'a', 'x'], [1, 'a'], ['s', 2], ['', 'a'], ['s', ''], ['x'.repeat(65), 'a'],
    ['s', 'x'.repeat(65)], [new String('s'), 'a'], [{ sessionId: 's', eventId: 'a' }]]) {
    assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, args), invalid, JSON.stringify(args));
  }
  assert.deepEqual(f.calls, []);
});

test('begin keeps a private copied complete baseline and returns an opaque bounded session view', () => {
  const f = fixture();
  const view = begin(f);
  assert.match(view.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...view, sessionId: '' }, { sessionId: '', eventId: 'a', calledNumbers: [7, 42],
    bingoPrize: { amount: 20, lot: 'Jamón' } });
  assert.equal(f.bingo.active(), true);
  view.calledNumbers.push(99);
  view.bingoPrize.amount = 1;
  f.state.returned!.calledNumbers.push(5);
  f.state.returned!.bingoPrize.lot = 'mutated';
  const again = f.invoke(BINGO_CHANNELS.read);
  assert.deepEqual(again, { ok: true, state: 'setup', session: { ...view, calledNumbers: [7, 42],
    bingoPrize: { amount: 20, lot: 'Jamón' } } });
  assert.equal(f.calls.includes('WRITE'), false);
  assert.deepEqual(f.playback, []);
});

test('a second begin is refused while a setup is open, without rereading the store', () => {
  const f = fixture();
  begin(f);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.begin),
    { ok: false, code: 'setup_active', message: 'A Bingo setup is already open. Reopen it to continue.' });
  assert.deepEqual(f.calls, ['baseline']);
});

test('begin is eligible only for a resolved persisted line; ineligible and unreadable storage fail closed', () => {
  const f = fixture();
  f.state.base = null;
  assert.deepEqual(f.invoke(BINGO_CHANNELS.begin),
    { ok: false, code: 'not_available', message: 'The Bingo cannot be declared now.' });
  f.state.base = baseline();
  f.state.fail = 'baseline';
  const failed = f.invoke(BINGO_CHANNELS.begin);
  assert.deepEqual(code(failed), [false, 'storage_failure']);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(f.bingo.active(), false);
  assert.equal(f.calls.includes('WRITE'), false);
});

test('Tongo, a shared presentation and another setup refuse begin before any store access; read is unaffected', () => {
  const busy = { tongo: false, presenting: false, other: false };
  const f = fixture({ tongoPlaying: () => busy.tongo, presentationBusy: () => busy.presenting,
    otherSetupActive: () => busy.other });
  busy.tongo = true;
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.begin)), [false, 'tongo_active']);
  busy.tongo = false; busy.presenting = true;
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.begin)), [false, 'presentation_busy']);
  busy.presenting = false; busy.other = true;
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.begin)), [false, 'setup_active']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.read), { ok: true, state: 'none' });
  busy.other = false;
  begin(f);
  assert.equal(f.bingo.active(), true);
});

test('a replaced frame never silently owns the setup; it adopts only through an authorized read', () => {
  const f = fixture();
  const oldFrame = f.frame;
  const view = begin(f);
  const replacement = f.reload();
  assert.throws(() => f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'], oldFrame), /Unauthorized/);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'], replacement), STALE);
  assert.equal(f.bingo.active(), true);
  const adopted = f.invoke(BINGO_CHANNELS.read, [], replacement);
  assert.deepEqual([adopted.state, (adopted.session as View).sessionId], ['setup', view.sessionId]);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'], replacement), { ok: true, state: 'cancelled' });
  assert.equal(f.bingo.active(), false);
  assert.equal(f.calls.includes('WRITE'), false);
});

test('cancel is explicit and bound to the exact session and event; a repeat is stale', () => {
  const f = fixture();
  const view = begin(f);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, ['other', 'a']), STALE);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'b']), STALE);
  assert.equal(f.bingo.active(), true);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']), { ok: true, state: 'cancelled' });
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']), STALE);
  assert.deepEqual(f.calls, ['baseline']);
});

test('read drops a setup whose baseline is stale or whose event switched, and never adopts it', () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.base = baseline('b'); },
    (f: ReturnType<typeof fixture>) => { f.state.base = baseline('a', '2026-10-01T09:30:00.000Z'); },
    (f: ReturnType<typeof fixture>) => { f.state.base = null; }]) {
    const f = fixture();
    const view = begin(f);
    change(f);
    assert.deepEqual(f.invoke(BINGO_CHANNELS.read, [], f.reload()), STALE);
    assert.equal(f.bingo.active(), false);
    assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']), STALE);
    assert.equal(f.calls.includes('WRITE'), false);
  }
});

test('read reports the committed award over any setup and fails closed on unreadable storage', () => {
  const f = fixture();
  const view = begin(f);
  f.state.fail = 'award';
  const failed = f.invoke(BINGO_CHANNELS.read, [], f.reload());
  assert.deepEqual(code(failed), [false, 'storage_failure']);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(f.bingo.active(), true);
  assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']), STALE, 'a failed read adopts nothing');
  f.state.fail = 'baseline';
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.read)), [false, 'storage_failure']);
  assert.equal(f.bingo.active(), true);
  f.state.fail = null;
  f.state.award = storedAward();
  const declared = f.invoke(BINGO_CHANNELS.read);
  assert.deepEqual(declared, { ok: true, state: 'declared', award: storedAward() });
  (declared.award as { award: { lot: string } }).award.lot = 'x';
  assert.deepEqual(f.invoke(BINGO_CHANNELS.read), { ok: true, state: 'declared', award: storedAward() });
  assert.equal(f.bingo.active(), false);
  assert.equal(f.calls.includes('WRITE'), false);
  assert.deepEqual(f.playback, []);
});

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
after(() => {
  for (const store of stores) { try { store.close(); } catch { /* Already closed. */ } }
  for (const d of directories) fs.rmSync(d, { recursive: true, force: true });
});

test('with the real store: begin needs a delivered line, then reads and cancels without changing persistence', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-ipc-'));
  directories.push(directory);
  const path = join(directory, 'event.sqlite');
  const store = createEventStore(path);
  stores.push(store);
  const event = store.createEvent({ name: 'E', date: '2025-01-01', place: 'X' });
  store.selectEvent(event.id);
  store.updateEventPrizes(event.id, { line: { amount: 5, lot: '' }, bingo: { amount: 10, lot: 'Jamón' } });
  store.update((c) => drawManual(c, 7));
  const sender = {};
  const frame = { url: 'u' };
  const handlers = new Map<string, Handler>();
  registerBingoIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } }, store,
    { authorize: createOperatorGuard(sender, () => frame, 'u') });
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: frame }, ...args) as Record<string, unknown>;
  assert.deepEqual(code(invoke(BINGO_CHANNELS.begin)), [false, 'not_available']);
  const line = store.declareLineDirectly(store.loadLineDeclarationBaseline(), 1, '2025-01-01T00:00:01.000Z');
  assert.deepEqual(code(invoke(BINGO_CHANNELS.begin)), [false, 'not_available'], 'line delivery not resolved');
  store.startLinePresentation(line.presentation.id, 1000);
  store.completeLinePresentation(line.presentation.id, 5000);
  const bytes = fs.readFileSync(path);
  const view = invoke(BINGO_CHANNELS.begin).session as View;
  assert.deepEqual([view.eventId, view.calledNumbers, view.bingoPrize], [event.id, [7], { amount: 10, lot: 'Jamón' }]);
  assert.equal(invoke(BINGO_CHANNELS.read).state, 'setup');
  assert.deepEqual(invoke(BINGO_CHANNELS.cancel, view.sessionId, view.eventId), { ok: true, state: 'cancelled' });
  assert.deepEqual(invoke(BINGO_CHANNELS.read), { ok: true, state: 'none' });
  assert.equal(store.loadBingoAward(), null);
  assert.deepEqual(fs.readFileSync(path), bytes, 'no persistence writes');
});
