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
const legacyCheck = () => ({ eventId: 'a', phase: 'checking_bingo' as const, auditSequence: 3,
  lastTransitionAt: '2026-10-01T09:00:00.000Z' });

function fixture(ports: Record<string, unknown> = {}) {
  const sender = {};
  const url = 'file:///app/operator.html';
  let frame: Frame = { url };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const state: { base: ReturnType<typeof baseline> | null; returned: ReturnType<typeof baseline> | null; award: unknown;
    fail: string | null; confirmation: 'declared' | 'unchanged' | 'stale' | 'throw'; onConfirmation?: () => void
  } = { base: baseline(), returned: null, award: null, fail: null, confirmation: 'throw' };
  const attempts: Array<{ expected: unknown; count: number; at: string }> = [];
  const confirmations: typeof attempts = [];
  const legacy = { value: { ...legacyCheck(), privateField: 'main only' }, error: null as Error | null,
    onLoad: undefined as (() => void) | undefined };
  const store = {
    loadLegacyBingoCheck() {
      calls.push('legacy');
      legacy.onLoad?.();
      if (legacy.error) throw legacy.error;
      return legacy.value;
    },
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
    declareBingoDirectly(expected: unknown, count: number, at: string) {
      calls.push('WRITE');
      attempts.push({ expected, count, at });
      if (state.fail === 'declare') throw new Error('secret uncertain');
      state.award = storedAward();
      return state.award;
    },
    confirmBingoDeclaration(expected: ReturnType<typeof baseline>, count: number, at: string) {
      calls.push('confirmation');
      confirmations.push({ expected, count, at });
      state.onConfirmation?.();
      if (state.confirmation === 'throw') throw new Error('secret confirmation');
      if (state.base?.eventId !== expected.eventId) return { state: 'stale' };
      if (state.confirmation === 'declared') {
        state.award ??= storedAward();
        return { state: 'declared', award: state.award };
      }
      return { state: state.confirmation };
    },
    update() { calls.push('WRITE'); throw new Error('no writes'); },
  };
  const playback: string[] = [];
  const mutablePorts = { authorize: createOperatorGuard(sender, () => frame, url),
    retry: (id: string) => { playback.push(`retry:${id}`); },
    repeat: (id: string) => { playback.push(`repeat:${id}`); }, committed: () => playback.push('committed'),
    now: () => new Date('2026-10-01T10:00:00.000Z'), ...ports };
  const bingo = registerBingoIpc({ handle: (channel: string, handler: Handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, mutablePorts);
  const invoke = (channel: string, args: unknown[] = [], fromFrame: object | null = frame, from: object = sender) =>
    handlers.get(channel)!({ sender: from, senderFrame: fromFrame }, ...args) as Record<string, unknown>;
  return { invoke, handlers, calls, attempts, confirmations, bingo, sender, state, legacy, playback, mutablePorts, store,
    get frame() { return frame; }, reload() { frame = { url }; return frame; },
    restoreFrame(original: Frame) { frame = original; } };
}
const begin = (f: ReturnType<typeof fixture>) => {
  const result = f.invoke(BINGO_CHANNELS.begin);
  assert.equal(result.state, 'setup', JSON.stringify(result));
  return result.session as View;
};
const code = (result: Record<string, unknown>) => [result.ok, result.code];
const STALE = { ok: false, code: 'stale_session', message: 'This Bingo setup is no longer current. Reopen it.' };

test('registers only the seven Bingo channels and rejects wrong sender, frame or URL before any store access', () => {
  const f = fixture();
  assert.deepEqual(Object.values(BINGO_CHANNELS), ['bingo:begin', 'bingo:read', 'bingo:legacy-check:read', 'bingo:cancel', 'bingo:confirm',
    'bingo:retry-presentation', 'bingo:repeat-presentation']);
  assert.deepEqual([...f.handlers.keys()], Object.values(BINGO_CHANNELS));
  for (const channel of Object.values(BINGO_CHANNELS)) {
    assert.throws(() => f.invoke(channel, [], f.frame, {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], null), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], { url: 'file:///app/operator.html' }), /Unauthorized/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.playback, []);
  assert.equal(f.bingo.active(), false);
  // Same accepted sender and the same current main frame object; only its page URL changes.
  const wrongUrl = fixture();
  const view = begin(wrongUrl);
  const owner = wrongUrl.frame;
  owner.url = 'https://evil.example/operator.html';
  for (const [channel, args] of [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
    [BINGO_CHANNELS.cancel, [view.sessionId, 'a']], ['bingo:confirm', [view.sessionId, 1]],
    [BINGO_CHANNELS.retryPresentation, ['bp']], [BINGO_CHANNELS.repeatPresentation, ['bp']]] as const) {
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

const confirm = (f: ReturnType<typeof fixture>, view: View, count = 1) =>
  f.invoke('bingo:confirm', [view.sessionId, count]);

test('confirm commits once with the complete frozen baseline and clones the returned award', () => {
  const f = fixture();
  const view = begin(f);
  view.calledNumbers.push(99);
  f.state.returned!.bingoPrize.amount = 999;
  const result = confirm(f, view, 2);
  assert.equal(result.state, 'declared');
  assert.deepEqual(f.attempts, [{ expected: baseline(), count: 2, at: '2026-10-01T10:00:00.000Z' }]);
  const expected = f.attempts[0].expected as ReturnType<typeof baseline>;
  for (const value of [expected, expected.calledNumbers, expected.bingoPrize, expected.line]) {
    assert.equal(Object.isFrozen(value), true);
  }
  (result.award as ReturnType<typeof storedAward>).award.lot = 'changed';
  assert.equal((f.state.award as ReturnType<typeof storedAward>).award.lot, 'Jamón');
  assert.equal(f.bingo.active(), false);
  assert.deepEqual(code(confirm(f, view)), [false, 'stale_session']);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.playback, ['committed']);
  assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
  assert.deepEqual(f.playback, ['committed']);
});

test('confirm validates exact arity and positive safe counts without touching storage', () => {
  const f = fixture();
  const view = begin(f);
  for (const args of [[], [view.sessionId], [view.sessionId, 1, 'extra'], ['', 1], [7, 1],
    ['x'.repeat(65), 1], [new String(view.sessionId), 1], ...[0, -1, 1.5, NaN, Infinity,
      Number.MAX_SAFE_INTEGER + 1, '1', null, undefined].map(count => [view.sessionId, count])]) {
    assert.deepEqual(code(f.invoke('bingo:confirm', args)), [false, 'invalid_request']);
  }
  assert.deepEqual(f.calls, ['baseline']);
});

test('confirm rejects wrong sessions, frames, changed events and current activity before writes', () => {
  const busy = { tongo: false, presentation: false };
  const f = fixture({ tongoPlaying: () => busy.tongo, presentationBusy: () => busy.presentation });
  const view = begin(f);
  assert.deepEqual(code(f.invoke('bingo:confirm', ['wrong', 1])), [false, 'stale_session']);
  f.reload();
  assert.deepEqual(code(confirm(f, view)), [false, 'stale_session']);
  f.invoke(BINGO_CHANNELS.read);
  busy.tongo = true;
  assert.deepEqual(code(confirm(f, view)), [false, 'tongo_active']);
  busy.tongo = false; busy.presentation = true;
  assert.deepEqual(code(confirm(f, view)), [false, 'presentation_busy']);
  busy.presentation = false;
  f.state.base = baseline('other');
  assert.deepEqual(code(confirm(f, view)), [false, 'stale_session']);
  assert.equal(f.bingo.active(), false);
  assert.equal(f.attempts.length, 0);
});

test('confirm preflight distinguishes unreadable storage from stale complete baselines without writing', () => {
  const f = fixture();
  const view = begin(f);
  f.state.fail = 'baseline';
  assert.deepEqual(code(confirm(f, view)), [false, 'storage_failure']);
  assert.equal(f.bingo.active(), true);
  f.state.fail = null;
  f.state.base!.line = { ...LINE, presentationId: 'different' };
  assert.deepEqual(code(confirm(f, view)), [false, 'stale_session']);
  assert.equal(f.attempts.length, 0);
  const ineligible = fixture();
  const other = begin(ineligible);
  ineligible.state.base = null;
  assert.deepEqual(code(confirm(ineligible, other)), [false, 'stale_session']);
  assert.equal(ineligible.bingo.active(), false);
  assert.equal(ineligible.attempts.length, 0);
});

test('confirm accepts the largest safe integer count without narrowing the IPC contract', () => {
  const f = fixture();
  assert.equal(confirm(f, begin(f), Number.MAX_SAFE_INTEGER).state, 'declared');
  assert.equal(f.attempts[0].count, Number.MAX_SAFE_INTEGER);
});

for (const now of ['2026-10-01T09:00:00.000Z', '2026-09-30T00:00:00.000Z']) {
  test(`confirm advances a clock at or behind the head: ${now}`, () => {
    const f = fixture({ now: () => new Date(now) });
    assert.equal(confirm(f, begin(f)).state, 'declared');
    assert.equal(f.attempts[0].at, '2026-10-01T09:00:00.001Z');
  });
}
for (const [name, now, head] of [
  ['invalid', () => new Date(NaN), undefined],
  ['throwing', () => { throw new Error('clock'); }, undefined],
  ['overflow', () => new Date(8640000000000000), '+275760-09-13T00:00:00.000Z'],
] as const) {
  test(`confirm fails closed on ${name} clock`, () => {
    const f = fixture({ now });
    if (head) f.state.base = baseline('a', head);
    const view = begin(f);
    assert.deepEqual(code(confirm(f, view)), [false, 'storage_failure']);
    assert.equal(f.attempts.length, 0);
    assert.equal(f.bingo.active(), true);
  });
}

test('notification follows durable return, contains failures and blocks reentry into every handler', () => {
  let f: ReturnType<typeof fixture>;
  let view: View;
  const reentry: unknown[] = [];
  let notificationState: unknown;
  f = fixture({ committed: () => {
    notificationState = [f.calls.at(-1), f.state.award !== null, f.bingo.active()];
    for (const [channel, args] of [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
      [BINGO_CHANNELS.legacyRead, []],
      [BINGO_CHANNELS.cancel, [view.sessionId, view.eventId]], ['bingo:confirm', [view.sessionId, 1]],
      [BINGO_CHANNELS.retryPresentation, ['bp']], [BINGO_CHANNELS.repeatPresentation, ['bp']]] as const) {
      reentry.push(code(f.invoke(channel, [...args])));
    }
    throw new Error('notification failure');
  } });
  view = begin(f);
  assert.equal(confirm(f, view).state, 'declared');
  assert.deepEqual(notificationState, ['WRITE', true, true]);
  assert.deepEqual(reentry, Array.from({ length: 7 }, () => [false, 'setup_active']));
  assert.equal(f.attempts.length, 1);
  assert.equal(f.bingo.active(), false);
  assert.deepEqual(code(confirm(f, view)), [false, 'stale_session']);
});

test('an uncertain write retains ownership and blocks every operation before reads, clocks or writes', () => {
  let clocks = 0;
  const f = fixture({ now: () => { clocks++; return new Date('2026-10-01T10:00:00.000Z'); } });
  const view = begin(f);
  const originalFrame = f.frame;
  f.state.fail = 'declare';
  assert.deepEqual(code(confirm(f, view, 2)), [false, 'storage_failure']);
  const originalAttempt = f.attempts[0];
  f.state.award = storedAward(); // An unrelated award must not resolve this attempt.
  const calls = [...f.calls];
  f.reload();
  assert.throws(() => f.invoke('bingo:confirm', [view.sessionId, 2], originalFrame), /Unauthorized/);
  for (const [channel, args] of [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
    [BINGO_CHANNELS.cancel, [view.sessionId, view.eventId]], ['bingo:confirm', [view.sessionId, 3]]] as const) {
    assert.deepEqual(code(f.invoke(channel, [...args])), [false, 'storage_failure']);
    assert.equal(f.bingo.active(), true);
  }
  assert.deepEqual(f.calls, [...calls, 'confirmation'], 'only explicit read may perform bound recovery');
  assert.equal(f.confirmations.length, 2);
  assert.equal(clocks, 1);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0], originalAttempt);
  assert.deepEqual(f.playback, []);
});

for (const outcome of ['declared', 'unchanged', 'stale', 'throw'] as const) {
  test(`declaration throw immediately confirms the exact attempt once: ${outcome}`, () => {
    const f = fixture();
    const view = begin(f);
    f.state.fail = 'declare';
    f.state.confirmation = outcome;
    const result = confirm(f, view, 2);
    assert.equal(f.attempts.length, 1);
    assert.equal(f.confirmations.length, 1);
    assert.deepEqual(f.confirmations[0], f.attempts[0]);
    assert.equal(f.confirmations[0].expected, f.attempts[0].expected);
    assert.equal(f.bingo.active(), outcome === 'unchanged' || outcome === 'throw');
    if (outcome === 'declared') {
      assert.equal(result.state, 'declared');
      assert.deepEqual(f.playback, ['committed']);
      (result.award as ReturnType<typeof storedAward>).award.lot = 'changed';
      assert.equal((f.state.award as ReturnType<typeof storedAward>).award.lot, 'Jamón');
      assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
      assert.deepEqual(f.playback, ['committed']);
    } else {
      assert.deepEqual(code(result), [false, outcome === 'stale' ? 'stale_session' : 'storage_failure']);
      assert.deepEqual(f.playback, []);
    }
    if (outcome === 'unchanged') {
      f.state.fail = null;
      assert.equal(confirm(f, view, 3).state, 'declared', 'only a later explicit request may declare again');
      assert.equal(f.attempts.length, 2);
      assert.equal(f.attempts[1].count, 3);
    }
  });

  test(`uncertain read resolves only the original bound attempt: ${outcome}`, () => {
    let clocks = 0;
    const f = fixture({ now: () => { clocks++; return new Date('2026-10-01T10:00:00.000Z'); } });
    const view = begin(f);
    const owner = f.frame;
    f.state.fail = 'declare';
    assert.deepEqual(code(confirm(f, view, 2)), [false, 'storage_failure']);
    f.state.award = storedAward(); // A generic same-event award is NOT recovery evidence.
    f.reload();
    assert.deepEqual(code(confirm(f, view, 9)), [false, 'storage_failure']);
    assert.deepEqual(code(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'])), [false, 'storage_failure']);
    assert.deepEqual(code(f.invoke(BINGO_CHANNELS.begin)), [false, 'storage_failure']);
    assert.deepEqual(code(f.invoke(BINGO_CHANNELS.read, ['extra'])), [false, 'invalid_request']);
    assert.equal(f.confirmations.length, 1);
    f.state.confirmation = outcome;
    const before = f.calls.length;
    const result = f.invoke(BINGO_CHANNELS.read);
    assert.deepEqual(f.calls.slice(before), ['confirmation'], 'no generic award or baseline loader');
    assert.equal(clocks, 1);
    assert.equal(f.attempts.length, 1);
    for (const bound of f.confirmations) {
      assert.deepEqual(bound, f.attempts[0]);
      assert.equal(bound.expected, f.attempts[0].expected);
    }
    if (outcome === 'declared') {
      assert.equal(result.state, 'declared');
      (result.award as ReturnType<typeof storedAward>).award.lot = 'changed';
      assert.equal((f.state.award as ReturnType<typeof storedAward>).award.lot, 'Jamón');
      assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
      assert.deepEqual(f.playback, ['committed']);
      assert.equal(f.confirmations.length, 2);
    } else if (outcome === 'unchanged') {
      assert.equal(result.state, 'setup');
      assert.equal((result.session as View).sessionId, view.sessionId);
      assert.deepEqual(code(confirm(f, { ...view, sessionId: 'wrong' })), [false, 'stale_session']);
      const adopted = f.frame;
      assert.deepEqual(code(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'wrong-event'])), [false, 'stale_session']);
      f.restoreFrame(owner);
      assert.deepEqual(code(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a'])), [false, 'stale_session']);
      f.restoreFrame(adopted);
      assert.equal(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']).state, 'cancelled');
    } else if (outcome === 'stale') {
      assert.deepEqual(result, STALE);
      assert.equal(f.bingo.active(), false);
    } else {
      assert.deepEqual(code(result), [false, 'storage_failure']);
      assert.equal(f.bingo.active(), true);
      const again = f.calls.length;
      assert.deepEqual(code(f.invoke(BINGO_CHANNELS.read)), [false, 'storage_failure']);
      assert.deepEqual(f.calls.slice(again), ['confirmation']);
      assert.equal(f.confirmations[2].expected, f.attempts[0].expected);
      f.restoreFrame(owner);
      f.state.confirmation = 'unchanged';
      assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'setup');
      assert.equal(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, 'a']).state, 'cancelled');
    }
    if (outcome !== 'declared') assert.deepEqual(f.playback, []);
    assert.equal(f.attempts.length, 1);
    assert.equal(clocks, 1);
  });
}

test('uncertain recovery rejects unauthorized senders, frames and URLs before confirmation', () => {
  const f = fixture();
  const view = begin(f);
  f.state.fail = 'declare';
  confirm(f, view);
  const before = [...f.calls];
  assert.throws(() => f.invoke(BINGO_CHANNELS.read, [], f.frame, {}), /Unauthorized/);
  assert.throws(() => f.invoke(BINGO_CHANNELS.read, [], {}), /Unauthorized/);
  f.frame.url = 'https://evil.example';
  assert.throws(() => f.invoke(BINGO_CHANNELS.read), /Unauthorized/);
  assert.deepEqual(f.calls, before);
  f.frame.url = 'file:///app/operator.html';
  f.state.confirmation = 'declared';
  f.state.base = baseline('different-event');
  assert.deepEqual(f.invoke(BINGO_CHANNELS.read), STALE);
  assert.deepEqual(f.playback, []);
  assert.equal(f.attempts.length, 1);
});

test('bound read and its committed notification keep all handlers locked through callbacks', () => {
  let f: ReturnType<typeof fixture>;
  let view: View;
  const observations: unknown[] = [];
  const probe = () => {
    observations.push(f.bingo.active());
    for (const [channel, args] of [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
      [BINGO_CHANNELS.legacyRead, []],
      [BINGO_CHANNELS.cancel, [view.sessionId, 'a']], [BINGO_CHANNELS.confirm, [view.sessionId, 7]],
      [BINGO_CHANNELS.retryPresentation, ['bp']], [BINGO_CHANNELS.repeatPresentation, ['bp']]] as const) {
      observations.push(code(f.invoke(channel, [...args])));
    }
  };
  f = fixture({ committed: () => { probe(); throw new Error('callback failure'); } });
  view = begin(f);
  f.state.fail = 'declare';
  confirm(f, view, 2);
  f.state.onConfirmation = probe;
  f.state.confirmation = 'declared';
  assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
  const locked = [true, ...Array.from({ length: 7 }, () => [false, 'setup_active'])];
  assert.deepEqual(observations, [...locked, ...locked]);
  assert.equal(f.bingo.active(), false);
  assert.equal(f.confirmations.length, 2);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
  assert.deepEqual(observations, [...locked, ...locked], 'ordinary reads never notify again');
});

test('legacy read returns only a detached four-field check without any clock, write or playback', () => {
  const f = fixture({ now: () => { throw new Error('read must not use clock'); } });
  const result = f.invoke(BINGO_CHANNELS.legacyRead);
  assert.deepEqual(result, { ok: true, state: 'legacy_check', check: legacyCheck() });
  const check = result.check as ReturnType<typeof legacyCheck>;
  assert.deepEqual(Object.keys(check).sort(), ['auditSequence', 'eventId', 'lastTransitionAt', 'phase']);
  assert.notEqual(check, f.legacy.value);
  check.eventId = 'mutated';
  check.auditSequence = 99;
  assert.deepEqual(f.invoke(BINGO_CHANNELS.legacyRead), { ok: true, state: 'legacy_check', check: legacyCheck() });
  f.legacy.value.eventId = 'another';
  assert.equal(check.eventId, 'mutated', 'loader mutation cannot change an earlier view');
  assert.deepEqual(f.calls, ['legacy', 'legacy']);
  assert.deepEqual(f.playback, []);
  assert.equal(f.attempts.length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.bingo.active(), false);
});

for (const [name, error, expected] of [
  ['typed eligibility', Object.assign(new Error('secret'), { code: 'legacy_bingo_check_not_eligible' }), 'not_available'],
  ['similar message', new Error('legacy_bingo_check_not_eligible'), 'storage_failure'],
  ['ordinary eligibility code', notEligible(), 'storage_failure'],
  ['corrupt storage', new Error('secret corrupt line'), 'storage_failure'],
] as const) {
  test(`legacy read distinguishes ${name} without leaking loader details`, () => {
    const f = fixture();
    f.legacy.error = error;
    const result = f.invoke(BINGO_CHANNELS.legacyRead);
    assert.deepEqual(code(result), [false, expected]);
    assert.equal(JSON.stringify(result).includes(error.message), false);
    assert.deepEqual(f.calls, ['legacy']);
    assert.deepEqual(f.playback, []);
    assert.equal(f.bingo.active(), false);
  });
}

test('legacy read requires exactly zero arguments and current operator frame authorization before access', () => {
  const f = fixture();
  for (const args of [[undefined], [null], [{}], ['a'], [1, 2]]) {
    assert.deepEqual(code(f.invoke(BINGO_CHANNELS.legacyRead, args)), [false, 'invalid_request']);
  }
  assert.throws(() => f.invoke(BINGO_CHANNELS.legacyRead, [undefined], f.frame, {}), /Unauthorized/);
  assert.throws(() => f.invoke(BINGO_CHANNELS.legacyRead, [], {}), /Unauthorized/);
  assert.throws(() => f.invoke(BINGO_CHANNELS.legacyRead, [], null), /Unauthorized/);
  const former = f.frame;
  f.reload();
  assert.throws(() => f.invoke(BINGO_CHANNELS.legacyRead, [], former), /Unauthorized/);
  f.frame.url = 'https://evil.example';
  assert.throws(() => f.invoke(BINGO_CHANNELS.legacyRead), /Unauthorized/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.bingo.active(), false);
  f.frame.url = 'file:///app/operator.html';
  assert.equal(f.invoke(BINGO_CHANNELS.legacyRead).state, 'legacy_check');
  assert.deepEqual(f.calls, ['legacy']);
});

test('legacy read does not adopt, discard or otherwise change an existing setup owner', () => {
  const f = fixture();
  const view = begin(f);
  const owner = f.frame;
  f.reload();
  assert.equal(f.invoke(BINGO_CHANNELS.legacyRead).state, 'legacy_check');
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, view.eventId])), [false, 'stale_session']);
  assert.equal(f.bingo.active(), true);
  f.restoreFrame(owner);
  assert.equal(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, view.eventId]).state, 'cancelled');
  assert.deepEqual(f.calls, ['baseline', 'legacy']);
  assert.deepEqual(f.playback, []);
});

test('legacy read remains read-only during shared activity and never invokes action ports', () => {
  const forbidden = () => { throw new Error('read must not dispatch or consult activity'); };
  const f = fixture({ now: forbidden, committed: forbidden, retry: forbidden, repeat: forbidden,
    tongoPlaying: forbidden, presentationBusy: forbidden, otherSetupActive: forbidden });
  assert.equal(f.invoke(BINGO_CHANNELS.legacyRead).state, 'legacy_check');
  assert.deepEqual(f.calls, ['legacy']);
  assert.equal(f.bingo.active(), false);
});

test('legacy loader holds the processing guard across reentry into all seven handlers', () => {
  const f = fixture();
  let loads = 0;
  f.legacy.onLoad = () => {
    loads++;
    assert.equal(f.bingo.active(), true);
    for (const [channel, args] of allRequests()) {
      assert.deepEqual(code(f.invoke(channel, args)), [false, 'setup_active']);
    }
  };
  assert.equal(f.invoke(BINGO_CHANNELS.legacyRead).state, 'legacy_check');
  assert.equal(loads, 1);
  assert.deepEqual(f.calls, ['legacy']);
  assert.deepEqual(f.playback, []);
  assert.equal(f.bingo.active(), false);
  f.legacy.error = new Error('loader failed');
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.legacyRead)), [false, 'storage_failure']);
  assert.equal(loads, 2);
  assert.equal(f.bingo.active(), false, 'finally releases processing after failure');
});

test('legacy read cannot resolve or discard a retained declaration attempt', () => {
  let clocks = 0;
  const f = fixture({ now: () => { clocks++; return new Date('2026-10-01T10:00:00.000Z'); } });
  const view = begin(f);
  f.state.fail = 'declare';
  assert.deepEqual(code(confirm(f, view, 2)), [false, 'storage_failure']);
  const calls = [...f.calls];
  const original = f.attempts[0];
  f.reload();
  assert.deepEqual(code(f.invoke(BINGO_CHANNELS.legacyRead)), [false, 'storage_failure']);
  assert.deepEqual(f.calls, calls);
  assert.equal(clocks, 1);
  assert.equal(f.bingo.active(), true);
  f.state.confirmation = 'declared';
  assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
  assert.equal(f.confirmations[1].expected, original.expected);
  assert.deepEqual(f.confirmations[1], original);
  assert.equal(f.attempts.length, 1);
  assert.equal(clocks, 1);
  assert.deepEqual(f.playback, ['committed']);
  assert.equal(f.bingo.active(), false);
});

const manualChannels = [BINGO_CHANNELS.retryPresentation, BINGO_CHANNELS.repeatPresentation] as const;
const allRequests = () => [[BINGO_CHANNELS.begin, []], [BINGO_CHANNELS.read, []],
  [BINGO_CHANNELS.legacyRead, []],
  [BINGO_CHANNELS.cancel, ['s', 'a']], [BINGO_CHANNELS.confirm, ['s', 1]],
  ...manualChannels.map(channel => [channel, ['bp']])] as Array<[string, unknown[]]>;

for (const [index, channel] of manualChannels.entries()) {
  const kind = index === 0 ? 'retry' : 'repeat';
  test(`${kind} validates one bounded primitive ID before ports or storage`, () => {
    const f = fixture();
    for (const args of [[], ['bp', {}], [undefined], [null], [1], [''], ['x'.repeat(65)],
      [new String('bp')], [{ presentationId: 'bp' }]]) {
      assert.deepEqual(code(f.invoke(channel, args)), [false, 'invalid_request']);
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.playback, []);
  });

  test(`${kind} refuses missing ports or false coordinator without fallback or reads`, () => {
    for (const port of [undefined, () => false]) {
      const f = fixture({ [kind]: port });
      const result = f.invoke(channel, ['bp']);
      assert.deepEqual(code(result), [false, 'presentation_refused']);
      assert.equal(JSON.stringify(result).includes('secret'), false);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.playback, []);
    }
    // IPC delegates status, wrong-ID and absent-award decisions; these spies do not prove store semantics.
    for (const reason of ['wrong ID', 'wrong status', 'no award']) {
      const ids: string[] = [];
      const f = fixture({ [kind]: (id: string) => { ids.push(id); return false; } });
      assert.deepEqual(code(f.invoke(channel, [reason])), [false, 'presentation_refused']);
      assert.deepEqual(ids, [reason]);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.playback, []);
    }
  });

  test(`${kind} reports a throwing coordinator as storage failure without retry or consuming setup`, () => {
    let dispatches = 0;
    const f = fixture({ [kind]: () => { dispatches++; throw new Error('secret storage failure'); } });
    const view = begin(f);
    const before = [...f.calls];
    const result = f.invoke(channel, ['bp']);
    assert.deepEqual(code(result), [false, 'storage_failure']);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(dispatches, 1);
    assert.deepEqual(f.calls, before, 'no readback after dispatch throws');
    assert.deepEqual(f.playback, [], 'no opposite action or committed notification');
    assert.equal(f.attempts.length, 0);
    assert.equal(f.bingo.active(), true, 'the existing setup remains owned');
    assert.deepEqual(f.invoke(BINGO_CHANNELS.cancel, [view.sessionId, view.eventId]),
      { ok: true, state: 'cancelled' }, 'finally releases processing and retains the setup owner');
    assert.equal(f.bingo.active(), false);
    assert.equal(dispatches, 1);
  });

  test(`${kind} checks Tongo and shared busy before accessing mutable action ports`, () => {
    for (const guard of ['tongoPlaying', 'presentationBusy']) {
      const f = fixture({ [guard]: () => true });
      Object.defineProperty(f.mutablePorts, kind, { get() { throw new Error('port accessed'); } });
      assert.deepEqual(code(f.invoke(channel, ['bp'])),
        [false, guard === 'tongoPlaying' ? 'tongo_active' : 'presentation_busy']);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.playback, []);
    }
  });

  test(`${kind} dispatches once through the current port and clones authoritative readback`, () => {
    const f = fixture();
    const ids: string[] = [];
    f.mutablePorts[kind] = (id: string) => {
      ids.push(id);
      const award = storedAward();
      award.eventId = 'current-event';
      award.presentation.id = 'rotated';
      f.state.award = award;
    };
    const result = f.invoke(channel, ['x'.repeat(64)]);
    assert.deepEqual(ids, ['x'.repeat(64)]);
    assert.deepEqual(result, { ok: true, state: 'declared', award: f.state.award });
    (result.award as ReturnType<typeof storedAward>).presentation.id = 'renderer mutation';
    assert.equal((f.state.award as ReturnType<typeof storedAward>).presentation.id, 'rotated');
    assert.deepEqual(f.calls, ['award']);
    assert.equal(f.invoke(BINGO_CHANNELS.read).state, 'declared');
    assert.deepEqual(ids, ['x'.repeat(64)], 'ordinary reads do not replay');
    assert.deepEqual(f.playback, [], 'no initial captured port, opposite action or committed notification');
    assert.equal(f.attempts.length, 0);
  });

  test(`${kind} readback failure never authorizes an internal second action`, () => {
    for (const missing of [false, true]) {
      const f = fixture();
      if (!missing) f.state.fail = 'award';
      assert.deepEqual(code(f.invoke(channel, ['bp'])), [false, 'storage_failure']);
      assert.deepEqual(f.playback, [`${kind}:bp`]);
      assert.deepEqual(f.calls, ['award']);
      assert.equal(f.attempts.length, 0);
    }
  });

  test(`${kind} locks all seven handlers through action notification and readback callbacks`, () => {
    let f: ReturnType<typeof fixture>;
    let probes = 0;
    const probe = () => {
      probes++;
      assert.equal(f.bingo.active(), true);
      for (const [route, args] of allRequests()) {
        assert.deepEqual(code(f.invoke(route, args)), [false, 'setup_active']);
      }
    };
    f = fixture({ [kind]: () => { probe(); f.state.award = storedAward(); } });
    const load = f.store.loadBingoAward;
    f.store.loadBingoAward = () => { probe(); return load(); };
    assert.equal(f.invoke(channel, ['bp']).state, 'declared');
    assert.equal(probes, 2);
    assert.deepEqual(f.calls, ['award']);
    assert.deepEqual(f.playback, []);
    assert.equal(f.bingo.active(), false);
  });
}

test('both manual routes preserve an uncertain declaration without accessing ports or reading', () => {
  const f = fixture();
  const view = begin(f);
  f.state.fail = 'declare';
  assert.deepEqual(code(confirm(f, view)), [false, 'storage_failure']);
  const calls = [...f.calls];
  for (const [kind, channel] of [['retry', BINGO_CHANNELS.retryPresentation],
    ['repeat', BINGO_CHANNELS.repeatPresentation]] as const) {
    Object.defineProperty(f.mutablePorts, kind, { get() { throw new Error('port accessed'); } });
    assert.deepEqual(code(f.invoke(channel, ['bp'])), [false, 'storage_failure']);
  }
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.playback, []);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.bingo.active(), true);
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
  const declaration = invoke(BINGO_CHANNELS.begin).session as View;
  const result = invoke('bingo:confirm', declaration.sessionId, 2);
  assert.equal(result.state, 'declared');
  assert.equal((result.award as ReturnType<typeof storedAward>).award.winnerCount, 2);
  store.close();
  const reopened = createEventStore(path);
  stores.push(reopened);
  assert.deepEqual(reopened.loadBingoAward(), result.award, 'atomic declaration survives reopening');
});
