import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { LINE_CHANNELS, registerLineIpc } from '../src/line-ipc.ts';

type Frame = { url: string };
type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;
type Baseline = { eventId: string; calledNumbers: number[]; phase: 'drawing'; lastTransitionAt: string | null;
  auditSequence: number; linePrize: { amount: number; lot: string } };

const baseline = (head: string | null = null): Baseline => ({ eventId: 'a', calledNumbers: [7, 42], phase: 'drawing',
  lastTransitionAt: head, auditSequence: 0, linePrize: { amount: 10, lot: 'Lote' } });
const storedAward = (eventId = 'a') => ({ eventId, presentation: { id: 'p1', status: 'pending', startedAt: null,
  deadlineAt: null }, award: { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: 'Lote',
  lotResolution: 'not_required' } });

function fixture(options: { head?: string | null; now?: () => Date } = {}) {
  const sender = {};
  const url = 'file:///app/operator.html';
  let frame: Frame = { url };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let award: ReturnType<typeof storedAward> | null = null;
  let failure: string | null = null;
  const store = {
    loadLineDeclarationBaseline() {
      calls.push('baseline');
      if (failure === 'baseline' || award !== null) throw new Error('secret ineligible');
      return Object.freeze({ ...baseline(options.head ?? null), calledNumbers: Object.freeze([7, 42]) });
    },
    declareLineDirectly(expected: unknown, count: unknown, at: unknown) {
      calls.push(`declare:${JSON.stringify(expected)}:${String(count)}:${String(at)}`);
      if (failure === 'declare-uncommitted') throw new Error('secret write');
      if (failure === 'declare-uncertain' || failure === 'declare-unreadable') {
        award = storedAward();
        throw new Error('lost acknowledgement');
      }
      award = storedAward();
      return award;
    },
    loadLineAward() {
      calls.push('award');
      if (failure === 'award' || failure === 'declare-unreadable') throw new Error('secret read');
      return award;
    },
    load() {
      calls.push('load');
      return { calledNumbers: [7, 42], phase: 'line_declared' as const, lastTransitionAt: 'x' };
    },
  };
  const line = registerLineIpc({ handle: (channel: string, handler: Handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, {
    authorize: createOperatorGuard(sender, () => frame, url),
    now: options.now ?? (() => new Date('2026-10-01T10:00:00.000Z')),
    publish: (snapshot: unknown) => {
      calls.push(`publish:${JSON.stringify(snapshot)}`);
      if (failure === 'publish') throw new Error('display gone');
    },
  });
  const invoke = (channel: string, args: unknown[] = [], from: object = sender, fromFrame: object | null = frame) =>
    handlers.get(channel)!({ sender: from, senderFrame: fromFrame }, ...args);
  return { invoke, handlers, calls, line, sender, get frame() { return frame; },
    reload() { frame = { url }; return frame; },
    setFailure: (value: string) => { failure = value; } };
}
type Session = { sessionId: string; eventId: string; calledNumbers: number[]; linePrize: { amount: number; lot: string } };
const begin = (f: ReturnType<typeof fixture>) => (f.invoke(LINE_CHANNELS.begin) as { ok: true; session: Session }).session;

test('registers exactly four operator-only channels and rejects bad senders before any store access', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], Object.values(LINE_CHANNELS));
  for (const channel of Object.values(LINE_CHANNELS)) {
    assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], f.sender, {}), /Unauthorized/);
    assert.throws(() => f.invoke(channel, [], f.sender, null), /Unauthorized/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.line.active(), false);
});

test('begin reads the authoritative baseline into a private main session and returns a defensive view', () => {
  const f = fixture();
  const session = begin(f);
  assert.equal(f.line.active(), true);
  assert.deepEqual({ ...session, sessionId: '' }, { sessionId: '', eventId: 'a', calledNumbers: [7, 42],
    linePrize: { amount: 10, lot: 'Lote' } });
  assert.ok(session.sessionId.length > 0);
  session.calledNumbers.push(99);
  const second = f.invoke(LINE_CHANNELS.begin);
  assert.deepEqual(second, { ok: false, code: 'setup_active', message: 'A first-line setup is already open. Reopen it to continue.' });
  assert.deepEqual(f.calls, ['baseline']);
  assert.deepEqual((f.invoke(LINE_CHANNELS.read) as { session: Session }).session.calledNumbers, [7, 42]);
});

test('begin with arguments is invalid, and an ineligible or unreadable baseline opens no session', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(LINE_CHANNELS.begin, [1]), { ok: false, code: 'invalid_request', message: 'Invalid line request.' });
  assert.deepEqual(f.calls, []);
  f.setFailure('baseline');
  assert.deepEqual(f.invoke(LINE_CHANNELS.begin),
    { ok: false, code: 'not_available', message: 'The first line cannot be declared now.' });
  assert.equal(f.line.active(), false);
});

test('cancel is explicit, requires the exact session, and performs no store writes', () => {
  const f = fixture();
  const session = begin(f);
  f.calls.length = 0;
  const invalid = { ok: false, code: 'invalid_request', message: 'Invalid line request.' };
  for (const args of [[], [session.sessionId], [1, 'a'], [session.sessionId, 'a', 'x']]) {
    assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, args), invalid);
  }
  const stale = { ok: false, code: 'stale_session', message: 'This setup is no longer current. Reopen it.' };
  assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, ['other', 'a']), stale);
  assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, [session.sessionId, 'b']), stale);
  assert.equal(f.line.active(), true);
  assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, [session.sessionId, 'a']), { ok: true });
  assert.equal(f.line.active(), false);
  assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, [session.sessionId, 'a']), stale);
  assert.deepEqual(f.calls, []);
});

test('confirm declares with the private baseline, a canonical timestamp, then acknowledges the committed award', () => {
  const f = fixture();
  const session = begin(f);
  const result = f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 3]) as { ok: true; award: unknown };
  assert.equal(result.ok, true);
  assert.deepEqual(result.award, storedAward());
  assert.equal(f.line.active(), false);
  assert.deepEqual(f.calls.slice(1), [`declare:${JSON.stringify(baseline())}:3:2026-10-01T10:00:00.000Z`, 'load',
    `publish:${JSON.stringify({ calledNumbers: [7, 42], phase: 'line_declared', lastTransitionAt: 'x' })}`]);
  assert.deepEqual(f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 3]),
    { ok: false, code: 'stale_session', message: 'This setup is no longer current. Reopen it.' });
  assert.equal(f.calls.filter((call) => call.startsWith('declare')).length, 1);
});

test('confirm validates the count and moves a skewed clock strictly after the baseline head', () => {
  const f = fixture({ head: '2026-10-01T10:00:00.000Z' });
  const session = begin(f);
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, new Number(1)]) {
    assert.deepEqual(f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', count]),
      { ok: false, code: 'invalid_request', message: 'Invalid line request.' });
  }
  assert.deepEqual(f.calls, ['baseline']);
  const ok = f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', Number.MAX_SAFE_INTEGER]) as { ok: boolean };
  assert.equal(ok.ok, true);
  assert.match(f.calls[1], new RegExp(`:${Number.MAX_SAFE_INTEGER}:2026-10-01T10:00:00\\.001Z$`));
});

test('an unusable clock fails before the store and keeps the session', () => {
  const f = fixture({ now: () => new Date(NaN) });
  const session = begin(f);
  assert.deepEqual(f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 1]),
    { ok: false, code: 'storage_failure', message: 'Could not read the clock. Try again.' });
  assert.deepEqual(f.calls, ['baseline']);
  assert.equal(f.line.active(), true);
});

test('an uncommitted write failure keeps the session and is never acknowledged; no state is invented', () => {
  const f = fixture();
  const session = begin(f);
  f.setFailure('declare-uncommitted');
  const result = f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 2]);
  assert.deepEqual(result, { ok: false, code: 'storage_failure',
    message: 'Could not declare the line. Reopen the setup and check the state before trying again.' });
  assert.equal(f.line.active(), true);
  assert.equal(f.calls.some((call) => call.startsWith('publish')), false);
});

test('an uncertain acknowledgement rereads committed state instead of redeclaring', () => {
  const f = fixture();
  const session = begin(f);
  f.setFailure('declare-uncertain');
  const result = f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 3]) as { ok: true; award: unknown };
  assert.deepEqual(result.award, storedAward());
  assert.equal(f.line.active(), false);
  assert.equal(f.calls.filter((call) => call.startsWith('declare')).length, 1);
  const again = f.invoke(LINE_CHANNELS.read);
  assert.deepEqual(again, { ok: true, state: 'declared', award: storedAward() });
});

test('when both the write and the readback fail the session stays and read recovers the committed award', () => {
  const f = fixture();
  const session = begin(f);
  f.setFailure('declare-unreadable');
  assert.deepEqual(f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 3]), { ok: false, code: 'storage_failure',
    message: 'Could not declare the line. Reopen the setup and check the state before trying again.' });
  assert.equal(f.line.active(), true);
  assert.equal(f.calls.some((call) => call.startsWith('publish')), false);
  f.setFailure('none');
  assert.deepEqual(f.invoke(LINE_CHANNELS.read), { ok: true, state: 'declared', award: storedAward() });
  assert.equal(f.line.active(), false);
  assert.equal(f.calls.filter((call) => call.startsWith('declare')).length, 1);
});

test('display publication failure cannot undo the committed declaration', () => {
  const f = fixture();
  const session = begin(f);
  f.setFailure('publish');
  const result = f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 1]) as { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(f.line.active(), false);
});

test('read returns none when nothing is open and surfaces read failures without leaking details', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(LINE_CHANNELS.read, [1]), { ok: false, code: 'invalid_request', message: 'Invalid line request.' });
  assert.deepEqual(f.invoke(LINE_CHANNELS.read), { ok: true, state: 'none' });
  f.setFailure('award');
  assert.deepEqual(f.invoke(LINE_CHANNELS.read),
    { ok: false, code: 'storage_failure', message: 'Could not read the first-line state. Try again.' });
});

test('a reloaded renderer keeps the main session; only the adopting current frame may cancel or confirm', () => {
  const f = fixture();
  const oldFrame = f.frame;
  const session = begin(f);
  const replacement = f.reload();
  assert.equal(f.line.active(), true);
  assert.throws(() => f.invoke(LINE_CHANNELS.cancel, [session.sessionId, 'a'], f.sender, oldFrame), /Unauthorized/);
  // The replacement has not adopted yet, so it cannot cancel or confirm.
  const stale = { ok: false, code: 'stale_session', message: 'This setup is no longer current. Reopen it.' };
  assert.deepEqual(f.invoke(LINE_CHANNELS.cancel, [session.sessionId, 'a'], f.sender, replacement), stale);
  assert.deepEqual(f.invoke(LINE_CHANNELS.confirm, [session.sessionId, 'a', 1], f.sender, replacement), stale);
  const adopted = f.invoke(LINE_CHANNELS.read, [], f.sender, replacement) as { state: string; session: Session };
  assert.equal(adopted.state, 'setup');
  assert.equal(adopted.session.sessionId, session.sessionId);
  // The old frame object can never act on the replacement's session, even if it were still authorized.
  const permissive = fixture();
  const first = begin(permissive);
  const frame2 = permissive.reload();
  permissive.invoke(LINE_CHANNELS.read, [], permissive.sender, frame2);
  assert.deepEqual(permissive.invoke(LINE_CHANNELS.cancel, [first.sessionId, 'a'], permissive.sender, frame2), { ok: true });
  assert.equal(permissive.line.active(), false);
});
