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
    update: async () => listed({ ...summary('a', true), name: 'Verbena' }, summary('b')),
  };
  const controller = createEventsController({
    listEvents: () => { calls.push('list'); return responses.list(); },
    createEvent: (meta: unknown) => { calls.push(`create:${JSON.stringify(meta)}`); return responses.create(); },
    selectEvent: (id: string) => { calls.push(`select:${id}`); return responses.select(); },
    updateEvent: (id: string, meta: unknown) => { calls.push(`update:${id}:${JSON.stringify(meta)}`); return responses.update(); },
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
  assert.equal(f.calls.at(-1), 'dependents', 'an unanswered select may have committed');
  await f.controller.start();
  assert.deepEqual([f.last().stale, f.last().error], [false, null]);
});

test('a committed selection whose list could not be read still refreshes dependent panels', async () => {
  const f = fixture();
  await f.controller.start();
  const message = 'The event was selected, but the list could not be read. Reload the events.';
  f.responses.select = async () => ({ ok: false, code: 'storage_failure', message, selected: true });
  assert.equal(await f.controller.select('b'), false);
  assert.deepEqual(f.calls, ['list', 'select:b', 'dependents']);
  assert.deepEqual([f.last().pending, f.last().stale, f.last().error], [null, true, message]);
  f.responses.select = async () => { throw new Error('ipc'); };
  await f.controller.select('b');
  assert.deepEqual(f.calls.slice(-2), ['select:b', 'dependents'], 'an unanswered select may have committed');
  f.responses.select = async () => ({ ok: false, code: 'invalid_request', message: 'Invalid event request.' });
  await f.controller.select('b');
  assert.deepEqual(f.calls.slice(-2), ['dependents', 'select:b'], 'a rejected select does not refresh');
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

test('an ok select reply with an invalid list still counts as committed and refreshes dependents', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.select = async () => ({ ok: true, events: [{ id: 'b' }] });
  assert.equal(await f.controller.select('b'), false);
  assert.deepEqual(f.calls.slice(-2), ['select:b', 'dependents']);
  assert.equal(f.last().stale, true);
});

test('a create that committed without a readable list reports success so the form is not resubmitted', async () => {
  const f = fixture();
  await f.controller.start();
  f.responses.create = async () => ({ ok: false, code: 'storage_failure', message: 'unreadable', created: true });
  assert.equal(await f.controller.create({ name: 'N', place: 'P', date: '2026-09-28' }), true);
  assert.equal(f.last().stale, true);
  assert.equal(f.last().error, 'unreadable');
});

test('an update resolves true only for an acknowledged commit and refreshes the active event', async () => {
  const f = fixture();
  await f.controller.start();
  const meta = { name: 'Verbena', date: '2026-09-28', place: 'Sala' };
  const pending = f.controller.update('a', meta);
  assert.equal(f.last().pending, 'update');
  assert.equal(await pending, true);
  assert.deepEqual([f.last().active?.name, f.last().stale, f.last().error], ['Verbena', false, null]);
  assert.equal(f.calls.includes('dependents'), false, 'metadata edits do not change the active event');
  f.responses.update = async () => ({ ok: false, code: 'storage_failure', message: 'Could not save.' });
  assert.equal(await f.controller.update('a', meta), false);
  assert.deepEqual([f.last().stale, f.last().error, f.last().active?.name], [true, 'Could not save.', 'Verbena']);
  f.responses.update = async () => { throw new Error('ipc'); };
  assert.equal(await f.controller.update('a', meta), false, 'an unanswered update is not reported as saved');
  f.responses.update = async () => ({ ok: false, code: 'storage_failure', message: 'unreadable', updated: true });
  assert.equal(await f.controller.update('a', meta), true);
  f.responses.update = async () => ({ ok: true, events: [{ id: 'a' }] });
  assert.equal(await f.controller.update('a', meta), true, 'ok:true means committed even with an unusable list');
  assert.equal(f.last().stale, true);
});
