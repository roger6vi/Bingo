import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { drawManual } from '../src/event-core.ts';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { createEventStore, EVENT_SCHEMA_VERSION } from '../src/event-store.ts';
import { lineShare, planLineAward } from '../src/line-award.ts';
import { LINE_AWARD_CHANNELS, registerLineAwardIpc } from '../src/line-award-ipc.ts';

const directories: string[] = [];
after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });

const at = (second: number) => `2025-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const prizes = (amount: number, lot: string) => ({ line: { amount, lot }, bingo: { amount: 0, lot: '' } });

function open(lot = '', amount = 30) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-line-award-'));
  directories.push(directory);
  const path = join(directory, 'event.sqlite');
  const store = createEventStore(path);
  const { id } = store.createEvent({ name: 'A', date: '2025-01-01', place: 'X' });
  store.updateEventPrizes(id, prizes(amount, lot));
  store.update((event) => drawManual(event, 7));
  return { path, store, id };
}

test('the plan needs a lot draw only when several winners share one lot; money splits in cents', () => {
  assert.deepEqual(planLineAward({ amount: 30, lot: '' }, 3), { winners: 3, lotDraw: 'none' });
  assert.deepEqual(planLineAward({ amount: 0, lot: 'Jamón' }, 1), { winners: 1, lotDraw: 'none' });
  assert.deepEqual(planLineAward({ amount: 0, lot: 'Jamón' }, 2), { winners: 2, lotDraw: 'pending' });
  assert.deepEqual(lineShare({ amount: 10, lot: '' }, 3), { cents: 333, remainderCents: 1 });
  assert.deepEqual(lineShare({ amount: 0, lot: 'Jamón' }, 2), { cents: 0, remainderCents: 0 });
  for (const winners of [0, 100, 1.5, NaN]) {
    assert.throws(() => planLineAward({ amount: 1, lot: '' }, winners), /winner count/);
    assert.throws(() => lineShare({ amount: 1, lot: '' }, winners), /winner count/);
  }
});

test('awardLine commits drawing → line_declared with the award and restores it after restart', () => {
  const { path, store, id } = open('Jamón');
  try {
    assert.deepEqual(store.loadLineAward(),
      { eventId: id, snapshot: { calledNumbers: [7], phase: 'drawing', lastTransitionAt: null }, award: null });
    const committed = store.awardLine(id, 2, at(1));
    assert.deepEqual(committed, { snapshot: { calledNumbers: [7], phase: 'line_declared', lastTransitionAt: at(1) },
      award: { winners: 2, lotDraw: 'pending' } });
    assert.equal(store.readAudit().at(-1)?.kind, 'award_line');
    assert.throws(() => store.awardLine(id, 1, at(2)), /invalid phase transition/i);
  } finally { store.close(); }
  const reopened = createEventStore(path);
  try {
    assert.deepEqual(reopened.loadLineAward(), { eventId: id,
      snapshot: { calledNumbers: [7], phase: 'line_declared', lastTransitionAt: at(1) },
      award: { winners: 2, lotDraw: 'pending' } });
    // Drawing toward bingo waits for the shared lot draw (#61).
    assert.throws(() => reopened.update((event) => drawManual(event, 8)), /lot draw is pending/);
    assert.deepEqual(reopened.load()?.calledNumbers, [7]);
  } finally { reopened.close(); }
});

test('without a shared lot the line resolves at once and drawing continues', () => {
  const { store, id } = open('Jamón');
  try {
    assert.deepEqual(store.awardLine(id, 1, at(1)).award, { winners: 1, lotDraw: 'none' });
    assert.deepEqual(store.update((event) => drawManual(event, 8)).calledNumbers, [7, 8]);
  } finally { store.close(); }
});

test('malformed, stale, or contended awards leave the exact prior state', () => {
  const { path, store, id } = open();
  try {
    const before = store.loadLineAward();
    assert.throws(() => store.awardLine(id, 0, at(1)), /winner count/);
    assert.throws(() => store.awardLine(id, '2', at(1)), /winner count/);
    assert.throws(() => store.awardLine(7, 1, at(1)), /event id/);
    assert.throws(() => store.awardLine(id, 1, 'now'), /timestamp/);
    assert.throws(() => store.transitionPhase('award_line', at(1)), /requires awardLine/);
    const other = store.createEvent({ name: 'B', date: '2025-01-02', place: 'Y' });
    assert.throws(() => store.awardLine(other.id, 1, at(1)), /not the active event/);
    const writer = new DatabaseSync(path);
    writer.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => store.awardLine(id, 1, at(1)), /locked|busy/i); }
    finally { writer.exec('ROLLBACK'); writer.close(); }
    assert.deepEqual(store.loadLineAward(), before);
    assert.deepEqual(store.readAudit(), []);
  } finally { store.close(); }
});

test('legacy checking_line stays readable and recoverable through the direct award', () => {
  const { path, store, id } = open();
  try { store.transitionPhase('begin_line_check', at(1)); } finally { store.close(); }
  const reopened = createEventStore(path);
  try {
    assert.equal(reopened.loadLineAward()?.snapshot.phase, 'checking_line');
    assert.deepEqual(reopened.awardLine(id, 1, at(2)).award, { winners: 1, lotDraw: 'none' });
    assert.deepEqual(reopened.readAudit().map((entry) => entry.kind), ['begin_line_check', 'award_line']);
  } finally { reopened.close(); }
});

test('a legacy line_declared has no award; an award the audit never granted fails closed', () => {
  const { path, store, id } = open();
  try {
    store.transitionPhase('begin_line_check', at(1));
    store.transitionPhase('declare_line', at(2));
    assert.equal(store.loadLineAward()?.award, null);
  } finally { store.close(); }
  const tampered = (sql: string) => {
    const db = new DatabaseSync(path);
    try { db.exec(sql); } finally { db.close(); }
  };
  tampered(`INSERT INTO line_awards VALUES ('${id}', 1, 'none')`);
  assert.throws(() => createEventStore(path), /line award: phase history/);
  tampered('PRAGMA ignore_check_constraints = 1; UPDATE line_awards SET winners = 1.5');
  assert.throws(() => createEventStore(path), /invalid stored line award/i);
});

test('a v6 database gains an empty line_awards table and keeps its events', () => {
  const { path, store } = open();
  store.close();
  const db = new DatabaseSync(path);
  let before: unknown;
  try {
    db.exec('DROP TABLE line_awards; PRAGMA user_version = 6');
    before = db.prepare('SELECT * FROM events').all();
  } finally { db.close(); }
  createEventStore(path).close();
  const check = new DatabaseSync(path);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, EVENT_SCHEMA_VERSION);
    assert.deepEqual(check.prepare('SELECT * FROM events').all(), before);
    assert.equal(check.prepare('SELECT count(*) AS count FROM line_awards').get()?.count, 0);
  } finally { check.close(); }
});

type Handler = (event: { sender: object; senderFrame: object }, ...args: unknown[]) => unknown;

function ipc() {
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let state = { eventId: 'a', snapshot: { calledNumbers: [7], phase: 'drawing' as const, lastTransitionAt: null },
    award: null as null | { winners: number; lotDraw: 'none' | 'pending' } };
  const f = { presenting: false, failure: null as null | 'load' | 'award' | 'notify', calls, handlers,
    invoke: (channel: string, args: unknown[] = [], from: object = sender) =>
      handlers.get(channel)!({ sender: from, senderFrame: frame }, ...args),
    get state() { return state; } };
  registerLineAwardIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } }, {
    loadLineAward() {
      calls.push('load');
      if (f.failure === 'load') throw new Error('secret');
      return state;
    },
    awardLine(id: string, winners: number, transitionAt: string) {
      calls.push(`award:${id}:${winners}:${transitionAt}`);
      if (f.failure === 'award') throw new Error('secret');
      const snapshot = { ...state.snapshot, phase: 'line_declared' as never, lastTransitionAt: transitionAt as never };
      state = { eventId: id, snapshot, award: { winners, lotDraw: 'none' } };
      return { snapshot, award: state.award! };
    },
  }, {
    authorize: createOperatorGuard(sender, () => frame, frame.url), now: () => at(1),
    presenting: () => f.presenting,
    notifyCommitted: (snapshot) => {
      calls.push(`notify:${snapshot.phase}`);
      if (f.failure === 'notify') throw new Error('display gone');
    },
  });
  return f;
}

test('line IPC is operator-only and acknowledges only the committed award', () => {
  const f = ipc();
  assert.deepEqual([...f.handlers.keys()], Object.values(LINE_AWARD_CHANNELS));
  for (const channel of Object.values(LINE_AWARD_CHANNELS)) assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
  assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.get), { ok: true, ...f.state });
  f.failure = 'notify';
  assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.award, ['a', 3]), { ok: true, eventId: 'a',
    snapshot: { calledNumbers: [7], phase: 'line_declared', lastTransitionAt: at(1) }, award: { winners: 3, lotDraw: 'none' } });
  assert.deepEqual(f.calls, ['load', 'load', `award:a:3:${at(1)}`, 'notify:line_declared']);
});

test('line IPC refuses malformed, stale, busy, and failed awards without writing', () => {
  const f = ipc();
  const invalid = { ok: false, code: 'invalid_request', message: 'Invalid line request.' };
  for (const args of [[], ['a'], ['a', 0], ['a', 100], ['a', '1'], ['', 1], ['a', 1, 2]]) {
    assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.award, args), invalid);
  }
  assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.get, [1]), invalid);
  assert.equal((f.invoke(LINE_AWARD_CHANNELS.award, ['b', 1]) as { code: string }).code, 'not_awardable');
  f.presenting = true;
  assert.equal((f.invoke(LINE_AWARD_CHANNELS.award, ['a', 1]) as { code: string }).code, 'presentation_active');
  f.presenting = false;
  f.failure = 'load';
  assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.award, ['a', 1]),
    { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' });
  f.failure = 'award';
  assert.deepEqual(f.invoke(LINE_AWARD_CHANNELS.award, ['a', 1]),
    { ok: false, code: 'storage_failure', message: 'Could not save the line. Reload and try again.' });
  assert.equal(f.state.snapshot.phase, 'drawing');
  assert.ok(!f.calls.some((call) => call.startsWith('notify')));
});
