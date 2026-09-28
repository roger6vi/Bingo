import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventsController, today, validEvents } from '../src/events-controller.mjs';

type Summary = { id: string; name: string; date: string; place: string; phase: string; createdAt: string; active: boolean };
type State = { events: Summary[]; loaded: boolean; pending: string | null; stale: boolean; error: string | null;
  active: Summary | null };
const summary = (id: string, active = false): Summary => ({ id, name: `Evento ${id}`, date: '2026-09-28',
  place: 'Sala', phase: 'drawing', createdAt: '2026-09-28T10:00:00.000Z', active });
const listed = (...events: Summary[]) => ({ ok: true, events });

function fixture() {
  const renders: State[] = [];
  const calls: string[] = [];
  const responses: Record<string, () => Promise<unknown>> = {
    list: async () => listed(summary('a', true), summary('b')),
    create: async () => listed(summary('a', true), summary('b'), summary('c')),
    select: async () => listed(summary('a'), summary('b', true)),
  };
  const controller = createEventsController({
    listEvents: () => { calls.push('list'); return responses.list(); },
    createEvent: (meta: unknown) => { calls.push(`create:${JSON.stringify(meta)}`); return responses.create(); },
    selectEvent: (id: string) => { calls.push(`select:${id}`); return responses.select(); },
  }, { render: (state: State) => { renders.push(structuredClone(state)); } },
  async () => { calls.push('dependents'); });
  return { controller, renders, calls, responses, last: () => renders.at(-1)! };
}

test('loading, then committed list with the active event distinguished; empty list is a loaded state', async () => {
  const f = fixture();
  const start = f.controller.start();
  assert.equal(f.last().pending, 'list');
  assert.equal(f.last().loaded, false);
  await start;
  assert.deepEqual(f.last().active?.id, 'a');
  assert.equal(f.last().events.length, 2);
  f.responses.list = async () => listed();
  await f.controller.start();
  assert.deepEqual([f.last().loaded, f.last().events, f.last().active, f.last().error], [true, [], null, null]);
});

test('selection refreshes dependent panels only after the committed acknowledgement', async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal(await f.controller.select('b'), true);
  assert.deepEqual(f.calls, ['list', 'select:b', 'dependents']);
  assert.equal(f.last().active?.id, 'b');
  assert.equal(await f.controller.select('b'), false, 'the active event is not re-selected');
  assert.deepEqual(f.calls.at(-1), 'dependents');
});

test('failed selection keeps the committed list stale with an error, then recovers on reload', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.select = async () => ({ ok: false, code: 'storage_failure', message: 'Could not select the event.' });
  assert.equal(await f.controller.select('b'), false);
  assert.deepEqual([f.last().stale, f.last().error, f.last().active?.id], [true, 'Could not select the event.', 'a']);
  assert.equal(f.calls.includes('dependents'), false);
  f.responses.select = async () => { throw new Error('ipc'); };
  await f.controller.select('b');
  assert.match(f.last().error!, /Could not connect/);
  await f.controller.start();
  assert.deepEqual([f.last().stale, f.last().error], [false, null]);
});

test('invalid acknowledgements are rejected and concurrent requests are ignored', async () => {
  const f = fixture();
  f.responses.list = async () => listed(summary('a', true), summary('b', true));
  await f.controller.start();
  assert.deepEqual([f.last().loaded, f.last().stale, f.last().error],
    [false, false, 'Invalid events update. Reload and try again.']);
  let release!: (value: unknown) => void;
  f.responses.create = () => new Promise((resolve) => { release = resolve; });
  const pending = f.controller.create({ name: 'N', place: 'P', date: '2026-09-28' });
  assert.equal(await f.controller.start(), false);
  release(listed(summary('c', true)));
  assert.equal(await pending, true);
  assert.deepEqual(f.calls, ['list', 'create:{"name":"N","place":"P","date":"2026-09-28"}']);
});

test('validEvents and today', () => {
  assert.equal(validEvents([summary('a', true)]), true);
  for (const bad of [null, [summary('a'), summary('a')], [{ ...summary('a'), date: '28-09-2026' }],
    [{ ...summary('a'), phase: 'x' }], [{ ...summary('a'), name: ' ' }]]) assert.equal(validEvents(bad), false);
  assert.equal(today(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
});
