import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublicEventDelivery, PUBLIC_EVENT_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_THEME_CHANNEL, type PublicEventMeta,
} from '../src/public-event-delivery.ts';
import type { EventSnapshot } from '../src/event-core.ts';

type Message = { channel: string; result: unknown };
const snapshot = (calledNumbers: number[], phase: 'drawing' | 'line_declared' = 'drawing',
  lastTransitionAt: string | null = null) => ({ calledNumbers, phase, lastTransitionAt });
function fixture(initial: readonly number[] | null = [90, 1]) {
  let current: ReturnType<typeof snapshot> | null = initial === null ? null : snapshot([...initial]);
  let fail = false;
  let loads = 0;
  const delivery = createPublicEventDelivery({ load: () => {
    loads++;
    if (fail) throw new Error('private storage detail');
    return current;
  } });
  function target() {
    const messages: Message[] = [];
    let destroyed = false;
    let sendFails = false;
    return {
      messages,
      isDestroyed: () => destroyed,
      send: (channel: string, result: unknown) => {
        if (sendFails) throw new Error('send failed');
        messages.push({ channel, result });
      },
      destroy: () => { destroyed = true; },
      failSend: () => { sendFails = true; },
    };
  }
  return { delivery, target, loads: () => loads,
    setCurrent: (numbers: readonly number[] | null, phase: 'drawing' | 'line_declared' = 'drawing',
      lastTransitionAt: string | null = null) => {
      current = numbers === null ? null : snapshot([...numbers], phase, lastTransitionAt);
    },
    failRead: () => { fail = true; } };
}

test('attach loads current history at document finish and sends a cloned serializable result', () => {
  const f = fixture();
  const target = f.target();
  f.setCurrent([90, 1, 42], 'line_declared', '2026-01-01T00:00:00.000Z');
  assert.equal(f.loads(), 0);
  f.delivery.attachAfterLoad(target);
  assert.equal(f.loads(), 1);
  assert.deepEqual(target.messages, [{ channel: PUBLIC_EVENT_CHANNEL,
    result: { ok: true, snapshot: snapshot([90, 1, 42], 'line_declared', '2026-01-01T00:00:00.000Z') } }]);
  assert.equal(JSON.stringify(target.messages[0]),
    JSON.stringify({ channel: PUBLIC_EVENT_CHANNEL, result: { ok: true, snapshot: snapshot([90, 1, 42], 'line_declared', '2026-01-01T00:00:00.000Z') } }));
});

test('missing event and read error send stable failures without inventing history or leaking details', () => {
  const absent = fixture(null), target = absent.target();
  absent.delivery.attachAfterLoad(target);
  assert.deepEqual(target.messages, [{ channel: PUBLIC_EVENT_CHANNEL,
    result: { ok: false, code: 'event_unavailable', message: 'No current event is available.' } }]);
  const broken = fixture(), other = broken.target();
  broken.failRead();
  broken.delivery.attachAfterLoad(other);
  assert.deepEqual(other.messages, [{ channel: PUBLIC_EVENT_CHANNEL,
    result: { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' } }]);
  assert.equal(JSON.stringify(other.messages).includes('private storage detail'), false);
});

test('publish sends independent committed clones in order only to the current target', () => {
  const f = fixture([1]), old = f.target(), current = f.target();
  f.delivery.attachAfterLoad(old);
  f.delivery.attachAfterLoad(current);
  const first = snapshot([1, 2], 'line_declared', '2026-01-01T00:00:00.000Z');
  const second = snapshot([1, 2, 3], 'drawing', '2026-01-02T00:00:00.000Z');
  f.delivery.publishCommitted(first);
  f.delivery.publishCommitted(second);
  first.calledNumbers.push(99);
  assert.notEqual((current.messages[1].result as { snapshot: EventSnapshot }).snapshot.calledNumbers, first.calledNumbers);
  assert.equal(old.messages.length, 1);
  assert.deepEqual(current.messages.map(({ result }) => result), [
    { ok: true, snapshot: snapshot([1]) },
    { ok: true, snapshot: snapshot([1, 2], 'line_declared', '2026-01-01T00:00:00.000Z') },
    { ok: true, snapshot: snapshot([1, 2, 3], 'drawing', '2026-01-02T00:00:00.000Z') },
  ]);
});

test('detach only clears matching target; close and reopen reload from live store', () => {
  const f = fixture([1]), old = f.target(), next = f.target();
  f.delivery.attachAfterLoad(old);
  f.setCurrent([1, 2]);
  f.delivery.attachAfterLoad(next);
  f.delivery.detachIfCurrent(old);
  f.delivery.publishCommitted(snapshot([1, 2, 3]));
  assert.equal(old.messages.length, 1);
  assert.equal(next.messages.length, 2);
  f.delivery.detachIfCurrent(next);
  f.setCurrent([1, 2, 3, 4], 'line_declared', '2026-01-03T00:00:00.000Z');
  const reopened = f.target();
  f.delivery.attachAfterLoad(reopened);
  assert.deepEqual(reopened.messages[0].result, { ok: true, snapshot: snapshot([1, 2, 3, 4], 'line_declared', '2026-01-03T00:00:00.000Z') });
  assert.equal(f.loads(), 3);
});

test('destroyed late attach cannot replace newer target; failed sends are isolated and cleared', () => {
  const f = fixture([1]), old = f.target(), current = f.target();
  f.delivery.attachAfterLoad(current);
  old.destroy();
  f.delivery.attachAfterLoad(old);
  f.delivery.publishCommitted({ calledNumbers: [1, 2] });
  assert.equal(f.loads(), 1);
  assert.equal(old.messages.length, 0);
  assert.equal(current.messages.length, 2);
  current.failSend();
  assert.doesNotThrow(() => f.delivery.publishCommitted({ calledNumbers: [1, 2, 3] }));
  f.delivery.publishCommitted({ calledNumbers: [1, 2, 3, 4] });
  assert.equal(current.messages.length, 2);
  const broken = f.target();
  broken.failSend();
  assert.doesNotThrow(() => f.delivery.attachAfterLoad(broken));
  broken.destroy();
  f.delivery.attachAfterLoad(current);
  current.destroy();
  assert.doesNotThrow(() => f.delivery.publishCommitted({ calledNumbers: [1, 2, 3, 4] }));
});

test('theme is sent before event state on attach, published to the current window, and recovered on reopen', () => {
  let theme: 'pixel-classic' | 'high-contrast' = 'high-contrast';
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => theme);
  const target = () => {
    const messages: Message[] = [];
    return { messages, isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  };
  const first = target();
  delivery.attachAfterLoad(first);
  assert.deepEqual(first.messages.map(({ channel }) => channel), [PUBLIC_THEME_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.equal(first.messages[0].result, 'high-contrast');
  theme = 'pixel-classic';
  delivery.publishTheme('pixel-classic');
  assert.deepEqual(first.messages[2], { channel: PUBLIC_THEME_CHANNEL, result: 'pixel-classic' });
  delivery.detachIfCurrent(first);
  delivery.publishTheme('pixel-classic');
  assert.equal(first.messages.length, 3);
  const reopened = target();
  delivery.attachAfterLoad(reopened);
  assert.deepEqual(reopened.messages[0], { channel: PUBLIC_THEME_CHANNEL, result: 'pixel-classic' });
});

test('publishActive resends theme then the newly active event marked eventChanged', () => {
  const f = fixture();
  const window = f.target();
  f.delivery.publishActive('high-contrast');
  f.delivery.attachAfterLoad(window);
  f.setCurrent([7]);
  f.delivery.publishActive('high-contrast');
  assert.deepEqual(window.messages.slice(-2), [
    { channel: PUBLIC_THEME_CHANNEL, result: 'high-contrast' },
    { channel: PUBLIC_EVENT_CHANNEL, result: { ok: true, snapshot: snapshot([7]), eventChanged: true } },
  ]);
  f.failRead();
  f.delivery.publishActive('pixel-classic');
  assert.deepEqual(window.messages.at(-1)?.result, { ok: false, code: 'storage_failure',
    message: 'Could not read the current event. Try again.' });
});

test('committed event metadata is sent between theme and state, republished on edits, and never leaks read errors', () => {
  let meta: PublicEventMeta = { name: 'Verbena', date: '2026-08-15', place: 'Plaza' };
  let failMeta = false;
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => 'high-contrast', () => {
    if (failMeta) throw new Error('private storage detail');
    return meta;
  });
  const messages: Message[] = [];
  const window = { isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  delivery.publishMeta();
  assert.equal(messages.length, 0, 'nothing is sent before a window attaches');
  delivery.attachAfterLoad(window);
  assert.deepEqual(messages.map(({ channel }) => channel), [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.deepEqual(messages[1].result, { name: 'Verbena', date: '2026-08-15', place: 'Plaza' });
  assert.notEqual(messages[1].result, meta, 'a copy is sent');
  meta = { name: 'Gran Bingo', date: '2026-08-16', place: 'Club' };
  delivery.publishMeta();
  assert.deepEqual(messages.at(-1), { channel: PUBLIC_META_CHANNEL, result: meta });
  delivery.publishActive('pixel-classic');
  assert.deepEqual(messages.slice(-3).map(({ channel }) => channel),
    [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  failMeta = true;
  delivery.publishMeta();
  assert.deepEqual(messages.at(-1), { channel: PUBLIC_META_CHANNEL, result: null });
  meta = null;
  failMeta = false;
  delivery.publishMeta();
  assert.deepEqual(messages.at(-1), { channel: PUBLIC_META_CHANNEL, result: null });
  assert.equal(JSON.stringify(messages).includes('private storage detail'), false);
});

test('a metadata send that closes the window stops the attach before event state', () => {
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => 'pixel-classic',
    () => ({ name: 'N', date: '2026-08-15', place: 'P' }));
  const messages: string[] = [];
  const window = { isDestroyed: () => false, send: (channel: string) => {
    messages.push(channel);
    if (channel === PUBLIC_META_CHANNEL) throw new Error('send failed');
  } };
  delivery.attachAfterLoad(window);
  assert.deepEqual(messages, [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL]);
});
