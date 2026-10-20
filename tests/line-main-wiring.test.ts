import assert from 'node:assert/strict';
import test from 'node:test';
import { LINE_CHANNELS } from '../src/line-ipc.ts';
import { createOperatorGuard } from '../src/event-ipc.ts';
// Dynamic import lets RED assert the missing production composition, rather than fail module bootstrap.
const production = await import('../src/line-main-wiring.ts').catch(() => null);

const lineAward = () => ({ eventId: 'a', award: { winnerCount: 2, totalCents: 1000, shareCents: 500,
  remainderCents: 0, lot: 'Jamón', lotResolution: 'pending' },
  presentation: { id: 'p1', status: 'pending', startedAt: null, deadlineAt: null } });

// Spy store: composition/callback evidence only, not transactional persistence proof.
function harness() {
  assert.ok(production, 'the real production line composition must exist');
  const calls: string[] = [];
  const published: Array<{ phase: string }> = [];
  const begun: unknown[] = [];
  const handlers = new Map();
  const sender = {};
  const frame = { url: 'file:///operator.html' };
  const state = { declared: false, corrected: false, award: null as ReturnType<typeof lineAward> | null };
  const store = {
    load: () => { calls.push('phase'); return { calledNumbers: [7, 42],
      phase: state.corrected ? 'drawing' : state.declared ? 'line_declared' : 'drawing',
      lastTransitionAt: '2026-10-01T09:00:00.000Z' }; },
    loadLineAward: () => { calls.push('award'); return state.award; },
    loadLineDeclarationBaseline: () => { calls.push('baseline'); return { eventId: 'a', calledNumbers: [7, 42],
      phase: 'drawing', lastTransitionAt: null, auditSequence: 0, linePrize: { amount: 10, lot: 'Jamón' } }; },
    declareLineDirectly: () => { calls.push('write'); state.declared = true; return state.award = lineAward(); },
    loadLineCorrectionBaseline: () => { calls.push('correctionBase'); return { eventId: 'a', calledNumbers: [7, 42],
      phase: 'drawing', lastTransitionAt: '2026-10-01T09:00:00.000Z', auditSequence: 1,
      linePrize: { amount: 10, lot: 'Jamón' } }; },
    correctLineDeclaration: (_expected: unknown, reason: string, at: string) => {
      calls.push('write');
      state.award = null;
      state.corrected = true;
      return { eventId: 'a', auditSequence: 2, transitionAt: at, reason, award: lineAward().award };
    },
  };
  production.registerLineMainWiring({ handle: (channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  } }, store, {
    authorize: createOperatorGuard(sender, () => frame, 'file:///operator.html'),
    now: () => new Date('2026-10-01T10:00:00.000Z'),
    publishCommitted: (snapshot: { phase: string }) => { calls.push('public'); published.push(snapshot); },
    begin: (value: unknown) => { calls.push('begin'); begun.push(value); },
    retry: () => false,
    repeat: () => false,
  });
  const invoke = (channel: string, args: unknown[] = []) =>
    handlers.get(channel)!({ sender, senderFrame: frame }, ...args);
  return { invoke, calls, published, begun };
}

// #29 slice 3b: the audited correction refreshes the public window from the committed drawing snapshot and
// never begins playback; the declaration keeps its celebration.
test('the declared award still begins playback and publishes the committed line snapshot', () => {
  const h = harness();
  const begin = h.invoke(LINE_CHANNELS.begin) as { ok: true; session: { sessionId: string; eventId: string } };
  assert.equal(begin.ok, true);
  const confirmed = h.invoke(LINE_CHANNELS.confirm, [begin.session.sessionId, begin.session.eventId, 2]) as
    { ok: true; award: { eventId: string } };
  assert.equal(confirmed.ok, true);
  assert.deepEqual(h.begun.length, 1, 'the declaration begins its celebration');
  assert.equal(h.published.at(-1)?.phase, 'line_declared', 'the public window shows the committed line');
});

test('committed line correction refreshes the public window with the drawing snapshot and never begins playback', () => {
  const h = harness();
  const begin = h.invoke(LINE_CHANNELS.begin) as { ok: true; session: { sessionId: string; eventId: string } };
  const confirmed = h.invoke(LINE_CHANNELS.confirm, [begin.session.sessionId, begin.session.eventId, 2]) as
    { ok: true; award: { eventId: string } };
  assert.equal(confirmed.ok, true);
  h.calls.length = 0;
  h.published.length = 0;
  h.begun.length = 0;
  const result = h.invoke(LINE_CHANNELS.correct, ['a', 'The line was declared in error']);
  assert.deepEqual(result, { ok: true, state: 'corrected' });
  assert.deepEqual(h.begun, [], 'no playback begins after a correction');
  assert.equal(h.published.at(-1)?.phase, 'drawing', 'the public window reverts to the drawing state');
});
