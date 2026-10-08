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

function fixture(options: { head?: string | null; now?: () => Date; ports?: Record<string, unknown>;
  storeExtra?: Record<string, unknown> } = {}) {
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
    ...options.storeExtra,
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
    ...options.ports,
  });
  const invoke = (channel: string, args: unknown[] = [], from: object = sender, fromFrame: object | null = frame) =>
    handlers.get(channel)!({ sender: from, senderFrame: fromFrame }, ...args);
  return { invoke, handlers, calls, line, sender, get frame() { return frame; },
    reload() { frame = { url }; return frame; },
    setFailure: (value: string) => { failure = value; } };
}
type Session = { sessionId: string; eventId: string; calledNumbers: number[]; linePrize: { amount: number; lot: string } };
const begin = (f: ReturnType<typeof fixture>) => (f.invoke(LINE_CHANNELS.begin) as { ok: true; session: Session }).session;

test('registers exactly six operator-only channels and rejects bad senders before any store access', () => {
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

const confirm = (f: ReturnType<typeof fixture>, count = 3) => {
  const session = begin(f);
  return f.invoke(LINE_CHANNELS.confirm, [session.sessionId, session.eventId, count]) as { ok: boolean };
};

test('a committed award starts its presentation once, after the committed state is published', () => {
  const started: unknown[] = [];
  const f = fixture({ ports: { committed: (award: unknown) => { f.calls.push('committed'); started.push(award); } } });
  assert.equal(confirm(f).ok, true);
  assert.deepEqual(started, [storedAward()]);
  assert.deepEqual(f.calls.slice(-2).map((call) => call.split(':')[0]), ['publish', 'committed']);
  // Reading recovers state but can never start a presentation.
  f.invoke(LINE_CHANNELS.read);
  assert.equal(started.length, 1);
});

test('the uncertain-acknowledgement reread also starts the presentation, and a failing hook never fails the confirmation', () => {
  const started: unknown[] = [];
  const f = fixture({ ports: { committed: (award: unknown) => { started.push(award); throw new Error('hook failed'); } } });
  f.setFailure('declare-uncertain');
  const result = confirm(f) as { ok: boolean; award?: unknown };
  assert.equal(result.ok, true);
  assert.deepEqual(started, [storedAward()]);
});

test('an uncommitted confirmation never starts a presentation', () => {
  const started: unknown[] = [];
  const f = fixture({ ports: { committed: (award: unknown) => started.push(award) } });
  f.setFailure('declare-uncommitted');
  assert.equal(confirm(f).ok, false);
  assert.deepEqual(started, []);
});

test('manual retry and repeat are operator-only, validate the id, and return the read-back award', () => {
  const actions: string[] = [];
  const f = fixture({ ports: { retry: (id: string) => actions.push(`retry:${id}`), repeat: (id: string) => actions.push(`repeat:${id}`),
    busy: () => false } });
  confirm(f);
  for (const [channel, name] of [[LINE_CHANNELS.retryPresentation, 'retry'], [LINE_CHANNELS.repeatPresentation, 'repeat']]) {
    assert.deepEqual(f.invoke(channel, ['p1']), { ok: true, award: storedAward() });
    assert.equal(actions.at(-1), `${name}:p1`);
    for (const args of [[], [1], [''], ['x'.repeat(65)], ['p1', 'p2']]) {
      assert.deepEqual(f.invoke(channel, args), { ok: false, code: 'invalid_request', message: 'Invalid line request.' });
    }
  }
  assert.equal(actions.length, 2);
});

test('manual presentation actions report a typed busy or refused outcome without leaking detail', () => {
  let busy = true, refuse = false;
  const f = fixture({ ports: { busy: () => busy, retry: () => { if (refuse) throw new Error('secret row'); },
    repeat: () => { throw new Error('secret row'); } } });
  confirm(f);
  const busyResult = f.invoke(LINE_CHANNELS.retryPresentation, ['p1']) as { ok: false; code: string; message: string };
  assert.deepEqual([busyResult.ok, busyResult.code], [false, 'presentation_busy']);
  busy = false;
  refuse = true;
  for (const channel of [LINE_CHANNELS.retryPresentation, LINE_CHANNELS.repeatPresentation]) {
    const result = f.invoke(channel, ['p1']) as { ok: false; code: string; message: string };
    assert.deepEqual([result.ok, result.code], [false, 'presentation_refused']);
    assert.doesNotMatch(result.message, /secret/);
  }
});

test('line begin and confirm are refused while Tongo is playing, and read is unaffected', () => {
  let playing = true;
  const f = fixture({ ports: { tongoPlaying: () => playing } });
  assert.equal((f.invoke(LINE_CHANNELS.begin) as { code: string }).code, 'tongo_active');
  assert.equal((f.invoke(LINE_CHANNELS.read) as { ok: boolean }).ok, true);
  playing = false;
  const session = begin(f);
  playing = true;
  assert.equal((f.invoke(LINE_CHANNELS.confirm, [session.sessionId, session.eventId, 3]) as { code: string }).code, 'tongo_active');
  playing = false;
  assert.equal((f.invoke(LINE_CHANNELS.confirm, [session.sessionId, session.eventId, 3]) as { ok: boolean }).ok, true);
});

test('manual retry and repeat are refused while Tongo plays, before any coordinator or store access', () => {
  let playing = false;
  const actions: string[] = [];
  const f = fixture({ ports: { tongoPlaying: () => playing, busy: () => { actions.push('busy'); return false; },
    retry: (id: string) => actions.push(`retry:${id}`), repeat: (id: string) => actions.push(`repeat:${id}`) } });
  confirm(f);
  playing = true;
  const before = f.calls.length;
  for (const channel of [LINE_CHANNELS.retryPresentation, LINE_CHANNELS.repeatPresentation]) {
    const result = f.invoke(channel, ['p1']) as { ok: boolean; code: string };
    assert.deepEqual([result.ok, result.code], [false, 'tongo_active']);
    assert.throws(() => f.invoke(channel, ['p1'], {}), /Unauthorized/, 'operator auth still comes first');
  }
  assert.deepEqual(actions, []);
  assert.equal(f.calls.length, before, 'no store access');
  playing = false;
  assert.equal((f.invoke(LINE_CHANNELS.retryPresentation, ['p1']) as { ok: boolean }).ok, true);
  assert.deepEqual(actions, ['busy', 'retry:p1']);
});

// ---- legacy checking_line recovery (REC-01) ----
const CHECK = { eventId: 'a', phase: 'checking_line' as const, lastTransitionAt: '2026-10-01T09:00:00.000Z', auditSequence: 3 };

function legacy(options: { head?: string; ports?: Record<string, unknown>; mode?: string } = {}) {
  const check = { ...CHECK, lastTransitionAt: options.head ?? CHECK.lastTransitionAt };
  let mode = options.mode ?? 'ok';
  let recovered: string | null = null;
  const calls: string[] = [];
  const extra = {
    loadLegacyLineCheck() {
      calls.push('check');
      if (mode === 'corrupt') throw new Error('secret corrupt row');
      if (mode === 'ineligible' || mode === 'stale' || recovered !== null) {
        throw Object.assign(new Error('secret not eligible'), { code: 'legacy_check_not_eligible' });
      }
      return Object.freeze({ ...check });
    },
    cancelLegacyLineCheck(expected: unknown, at: unknown) {
      calls.push(`cancel:${JSON.stringify(expected)}:${String(at)}`);
      if (mode === 'rejected' || mode === 'stale') throw new Error('secret write');
      recovered = String(at);
      if (mode === 'uncertain' || mode === 'unreadable' || mode === 'otherEvent') throw new Error('lost acknowledgement');
      return { calledNumbers: [7, 42], phase: 'drawing' as const, lastTransitionAt: recovered };
    },
    // Bound readback: one snapshot that names the event, so another event's matching row is never ours.
    confirmLegacyLineCancel(expected: unknown, at: unknown) {
      calls.push(`confirm:${JSON.stringify(expected)}:${String(at)}`);
      if (mode === 'unreadable') throw new Error('secret read');
      if (mode === 'otherEvent' || mode === 'stale') return 'stale';
      return recovered === at ? 'recovered' : 'unchanged';
    },
    readAudit() {
      calls.push('audit');
      if (mode === 'unreadable') throw new Error('secret read');
      if (mode === 'otherEvent') {
        // Event B is now active and its row at the same position and timestamp matches.
        return [...Array.from({ length: check.auditSequence }, (_, i) => ({ sequence: i + 1, transitionAt: 't',
          kind: 'begin_line_check', from_phase: 'drawing', to_phase: 'checking_line' })),
          { sequence: check.auditSequence + 1, transitionAt: recovered!, kind: 'reject_line_claim',
            from_phase: 'checking_line', to_phase: 'drawing' }];
      }
      const rows = Array.from({ length: check.auditSequence }, (_, i) => ({ sequence: i + 1, transitionAt: 't',
        kind: 'begin_line_check', from_phase: 'drawing', to_phase: 'checking_line' }));
      if (recovered !== null) rows.push({ sequence: check.auditSequence + 1, transitionAt: recovered,
        kind: 'reject_line_claim', from_phase: 'checking_line', to_phase: 'drawing' });
      return rows;
    },
  };
  const f = fixture({ ports: options.ports, storeExtra: extra });
  const read = () => f.invoke(LINE_CHANNELS.readLegacyCheck) as Record<string, unknown>;
  const cancel = (args: unknown[] = [check.eventId, check.auditSequence, check.lastTransitionAt]) =>
    f.invoke(LINE_CHANNELS.cancelLegacyCheck, args) as Record<string, unknown>;
  return { f, read, cancel, calls, set: (value: string) => { mode = value; } };
}
const writes = (calls: string[]) => calls.filter((call) => call.startsWith('cancel:'));

test('legacy check read returns only the plain identity and refuses extra arguments and other senders', () => {
  const { f, read } = legacy();
  assert.deepEqual(read(), { ok: true, state: 'legacy_check', check: CHECK });
  assert.equal((f.invoke(LINE_CHANNELS.readLegacyCheck, [1]) as { code: string }).code, 'invalid_request');
  assert.throws(() => f.invoke(LINE_CHANNELS.readLegacyCheck, [], {}), /Unauthorized/);
  assert.throws(() => f.invoke(LINE_CHANNELS.cancelLegacyCheck, [CHECK.eventId, 3, CHECK.lastTransitionAt], {}), /Unauthorized/);
  const ineligible = legacy({ mode: 'ineligible' });
  assert.deepEqual(ineligible.read(), { ok: false, code: 'not_available', message: 'There is no line check to cancel.' });
});

test('legacy cancel commits with a main-generated newer timestamp, publishes the normal snapshot and never celebrates', () => {
  const events: string[] = [];
  const { f, cancel, calls } = legacy({ ports: { committed: () => events.push('committed'),
    publish: (snapshot: unknown) => events.push(`publish:${JSON.stringify(snapshot)}`) } });
  assert.deepEqual(cancel(), { ok: true, state: 'recovered' });
  assert.deepEqual(writes(calls), [`cancel:${JSON.stringify({ ...CHECK })}:2026-10-01T10:00:00.000Z`]);
  assert.deepEqual(events, ['publish:{"calledNumbers":[7,42],"phase":"line_declared","lastTransitionAt":"x"}']);
  assert.equal(f.line.active(), false);
});

test('legacy cancel timestamp is strictly after a clock-skewed head', () => {
  const head = '2026-10-01T12:00:00.000Z';
  const { cancel, calls } = legacy({ head });
  assert.equal(cancel([CHECK.eventId, CHECK.auditSequence, head]).ok, true);
  assert.ok(writes(calls)[0].endsWith(':2026-10-01T12:00:00.001Z'));
});

test('legacy cancel rejects malformed arguments before any store access', () => {
  const { cancel, calls } = legacy();
  for (const args of [[], ['a'], ['a', 3], ['a', 3, CHECK.lastTransitionAt, 'x'], ['', 3, 'h'], [1, 3, 'h'],
    ['a', '3', 'h'], ['a', 0, 'h'], ['a', 1.5, 'h'], ['a', NaN, 'h'], ['a', Number.MAX_SAFE_INTEGER + 1, 'h'],
    ['a', 3, ''], ['a', 3, null], ['a'.repeat(65), 3, 'h'], [{ eventId: 'a' }], [{}, 3, 'h']]) {
    assert.equal(cancel(args).code, 'invalid_request', JSON.stringify(args));
  }
  assert.deepEqual(calls, []);
});

test('legacy cancel refuses an open setup, Tongo, a presentation and a clock failure without writing', () => {
  const state = { tongo: false, busy: false, clock: false };
  const { f, cancel, calls } = legacy({ ports: { tongoPlaying: () => state.tongo, busy: () => state.busy } });
  const open = begin(f);
  assert.equal(cancel().code, 'setup_active');
  f.invoke(LINE_CHANNELS.cancel, [open.sessionId, open.eventId]);
  state.tongo = true;
  assert.equal(cancel().code, 'tongo_active');
  state.tongo = false; state.busy = true;
  assert.equal(cancel().code, 'presentation_busy');
  assert.deepEqual(writes(calls), []);
  state.busy = false;
  assert.equal(cancel().ok, true);
  const bad = legacy({ ports: { now: () => { throw new Error('clock'); } } });
  assert.equal(bad.cancel().code, 'storage_failure');
  assert.deepEqual(writes(bad.calls), []);
});

test('legacy cancel with a stale or ineligible store reports stale without publishing or celebrating', () => {
  const events: string[] = [];
  const ports = { publish: () => events.push('publish'), committed: () => events.push('committed') };
  const stale = legacy({ ports, mode: 'stale' });
  const r = stale.cancel();
  assert.deepEqual([r.ok, r.code], [false, 'stale_session']);
  const rejected = legacy({ ports, mode: 'rejected' });
  const unchanged = rejected.cancel();
  assert.deepEqual([unchanged.ok, unchanged.code], [false, 'storage_failure']);
  assert.equal(JSON.stringify(unchanged).includes('secret'), false);
  assert.deepEqual(events, []);
});

test('legacy cancel with a lost acknowledgement rereads the bound state instead of retrying and then succeeds', () => {
  const events: string[] = [];
  const { cancel, calls } = legacy({ mode: 'uncertain', ports: { publish: () => events.push('publish'),
    committed: () => events.push('committed') } });
  assert.deepEqual(cancel(), { ok: true, state: 'recovered' });
  assert.equal(writes(calls).length, 1, 'never a second write');
  assert.ok(calls.some((call) => call.startsWith('confirm:')));
  assert.deepEqual(events, ['publish']);
});

test('legacy cancel with an unreadable state after a failed write reports an unknown state and does not retry', () => {
  const { cancel, calls, set } = legacy({ mode: 'unreadable' });
  const r = cancel();
  assert.deepEqual([r.ok, r.code], [false, 'storage_failure']);
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(writes(calls).length, 1);
  set('ok');
  assert.equal(cancel().ok, true, 'an explicit new request after a readback is allowed');
});

test('legacy cancel publication failure stays acknowledged and does not undo the commit', () => {
  const { f, cancel } = legacy();
  f.setFailure('publish');
  assert.deepEqual(cancel(), { ok: true, state: 'recovered' });
});

test('legacy cancel never treats another active event matching audit row as its own recovery', () => {
  const events: string[] = [];
  const { cancel, calls } = legacy({ mode: 'otherEvent', ports: { publish: () => events.push('publish'),
    committed: () => events.push('committed') } });
  const r = cancel();
  assert.deepEqual([r.ok, r.code], [false, 'stale_session']);
  assert.equal(writes(calls).length, 1, 'never a second write');
  assert.ok(calls.some((call) => call.startsWith(`confirm:${JSON.stringify({ ...CHECK })}:`)), 'bound readback');
  assert.deepEqual(events, [], 'no publish for an event we did not recover');
});

test('legacy cancel readback uses the bound store read for a lost acknowledgement and for an unchanged write', () => {
  const lost = legacy({ mode: 'uncertain' });
  assert.deepEqual(lost.cancel(), { ok: true, state: 'recovered' });
  assert.ok(lost.calls.some((call) => call.startsWith('confirm:')));
  assert.equal(lost.calls.includes('audit'), false, 'no unbound audit read');
  const unchanged = legacy({ mode: 'rejected' });
  const r = unchanged.cancel();
  assert.deepEqual([r.ok, r.code], [false, 'storage_failure']);
  assert.equal(unchanged.calls.includes('audit'), false);
});

test('legacy read reports corrupt or unreadable storage as an operator storage failure, not as not available', () => {
  const corrupt = legacy({ mode: 'corrupt' });
  const r = corrupt.read();
  assert.deepEqual([r.ok, r.code], [false, 'storage_failure']);
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.match(String(r.message), /storage|read|retry|try again/i);
  const eligible = legacy({ mode: 'ineligible' }).read();
  assert.deepEqual([eligible.ok, eligible.code], [false, 'not_available']);
  assert.notEqual(r.message, eligible.message);
});
