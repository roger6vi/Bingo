import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { CATALOG_CHANNELS, registerEventCatalogIpc } from '../src/event-catalog-ipc.ts';
import type { EventSummary } from '../src/event-store.ts';

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;
const summary = (id: string, active: boolean): EventSummary => ({ id, name: `Evento ${id}`, date: '2026-09-28',
  place: 'Sala', phase: 'drawing', createdAt: '2026-09-28T10:00:00.000Z', active });

function fixture() {
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let events = [summary('a', true)];
  let failure: string | null = null;
  const store = {
    listEvents() { calls.push('list'); if (failure === 'list') throw new Error('secret'); return events; },
    createEvent(meta: { name: string; date: string; place: string }) {
      calls.push(`create:${JSON.stringify(meta)}`);
      if (failure === 'create') throw new Error('secret');
      events = [...events, { ...summary('b', false), ...meta }];
      return events.at(-1)!;
    },
    selectEvent(id: string) {
      calls.push(`select:${id}`);
      if (failure === 'select' || !events.some((event) => event.id === id)) throw new Error('Unknown event id');
      events = events.map((event) => ({ ...event, active: event.id === id }));
      return events.find((event) => event.active)!;
    },
  };
  registerEventCatalogIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
    store, createOperatorGuard(sender, () => frame, frame.url), () => {
      calls.push('notify');
      if (failure === 'notify') throw new Error('display gone');
    });
  const invoke = (channel: string, args: unknown[] = [], from: object = sender) =>
    handlers.get(channel)!({ sender: from, senderFrame: frame }, ...args);
  return { handlers, invoke, calls, setFailure: (value: string) => { failure = value; } };
}

const meta = { name: ' Verbena ', date: '2026-09-28', place: 'Plaza' };

test('registers exactly list, create, and select, all operator-only', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], Object.values(CATALOG_CHANNELS));
  for (const channel of Object.values(CATALOG_CHANNELS)) {
    assert.throws(() => f.invoke(channel, [], {}), /Unauthorized/);
  }
  assert.deepEqual(f.calls, []);
});

test('list returns committed summaries; create returns the refreshed list without changing the active event', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(CATALOG_CHANNELS.list), { ok: true, events: [summary('a', true)] });
  const created = f.invoke(CATALOG_CHANNELS.create, [meta]) as { ok: true; events: EventSummary[] };
  assert.equal(created.ok, true);
  assert.deepEqual(created.events.map((event) => [event.id, event.active]), [['a', true], ['b', false]]);
  assert.equal(f.calls.includes('notify'), false);
});

test('malformed requests never reach the store', () => {
  const f = fixture();
  const invalid = { ok: false, code: 'invalid_request', message: 'Invalid event request.' };
  assert.deepEqual(f.invoke(CATALOG_CHANNELS.list, [1]), invalid);
  for (const bad of [null, [], 'x', { ...meta, extra: 1 }, { ...meta, name: '  ' }, { ...meta, place: 'p'.repeat(121) },
    { ...meta, date: '2026-02-30' }, { ...meta, date: '2026-99-99' }, { ...meta, date: '28/09/2026' }, Object.assign(Object.create(null), meta)]) {
    assert.deepEqual(f.invoke(CATALOG_CHANNELS.create, [bad]), invalid);
  }
  for (const bad of [[], [1], [''], ['x'.repeat(65)], ['a', 'b']]) {
    assert.deepEqual(f.invoke(CATALOG_CHANNELS.select, bad), invalid);
  }
  assert.deepEqual(f.calls, []);
});

test('select commits before notifying both windows; failures neither notify nor leak details', () => {
  const f = fixture();
  f.invoke(CATALOG_CHANNELS.create, [meta]);
  f.calls.length = 0;
  const selected = f.invoke(CATALOG_CHANNELS.select, ['b']) as { ok: true; events: EventSummary[] };
  assert.deepEqual(selected.events.map((event) => event.active), [false, true]);
  assert.deepEqual(f.calls, ['select:b', 'notify', 'list']);
  f.calls.length = 0;
  assert.deepEqual(f.invoke(CATALOG_CHANNELS.select, ['missing']), { ok: false, code: 'storage_failure',
    message: 'Could not select the event. Reload the events and try again.' });
  assert.deepEqual(f.calls, ['select:missing']);
  f.setFailure('notify');
  assert.equal((f.invoke(CATALOG_CHANNELS.select, ['a']) as { ok: boolean }).ok, true);
  f.setFailure('list');
  f.calls.length = 0;
  assert.deepEqual(f.invoke(CATALOG_CHANNELS.select, ['b']), { ok: false, code: 'storage_failure',
    message: 'The event was selected, but the list could not be read. Reload the events.', selected: true });
  assert.deepEqual(f.calls, ['select:b', 'notify', 'list']);
  assert.deepEqual(f.invoke(CATALOG_CHANNELS.list), { ok: false, code: 'storage_failure',
    message: 'Could not read the events. Try again.' });
  f.setFailure('create');
  assert.equal(JSON.stringify(f.invoke(CATALOG_CHANNELS.create, [meta])).includes('secret'), false);
});
