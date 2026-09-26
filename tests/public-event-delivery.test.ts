import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicEventDelivery, PUBLIC_EVENT_CHANNEL } from '../src/public-event-delivery.ts';
import type { EventSnapshot } from '../src/event-core.ts';

type Message = { channel: string; result: unknown };
function fixture(initial: readonly number[] | null = [90, 1]) {
  let current: EventSnapshot | null = initial === null ? null : { calledNumbers: [...initial] };
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
    setCurrent: (numbers: readonly number[] | null) => { current = numbers === null ? null : { calledNumbers: [...numbers] }; },
    failRead: () => { fail = true; } };
}

test('attach loads current history at document finish and sends a cloned serializable result', () => {
  const f = fixture();
  const target = f.target();
  f.setCurrent([90, 1, 42]);
  assert.equal(f.loads(), 0);
  f.delivery.attachAfterLoad(target);
  assert.equal(f.loads(), 1);
  assert.deepEqual(target.messages, [{ channel: PUBLIC_EVENT_CHANNEL,
    result: { ok: true, snapshot: { calledNumbers: [90, 1, 42] } } }]);
  assert.equal(JSON.stringify(target.messages[0]),
    JSON.stringify({ channel: PUBLIC_EVENT_CHANNEL, result: { ok: true, snapshot: { calledNumbers: [90, 1, 42] } } }));
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
});

test('publish sends independent committed clones in order only to the current target', () => {
  const f = fixture([1]), old = f.target(), current = f.target();
  f.delivery.attachAfterLoad(old);
  f.delivery.attachAfterLoad(current);
  const first = { calledNumbers: [1, 2] }, second = { calledNumbers: [1, 2, 3] };
  f.delivery.publishCommitted(first);
  f.delivery.publishCommitted(second);
  first.calledNumbers.push(99);
  assert.equal(old.messages.length, 1);
  assert.deepEqual(current.messages.map(({ result }) => result), [
    { ok: true, snapshot: { calledNumbers: [1] } },
    { ok: true, snapshot: { calledNumbers: [1, 2] } },
    { ok: true, snapshot: { calledNumbers: [1, 2, 3] } },
  ]);
});

test('detach only clears matching target; close and reopen reload from live store', () => {
  const f = fixture([1]), old = f.target(), next = f.target();
  f.delivery.attachAfterLoad(old);
  f.setCurrent([1, 2]);
  f.delivery.attachAfterLoad(next);
  f.delivery.detachIfCurrent(old);
  f.delivery.publishCommitted({ calledNumbers: [1, 2, 3] });
  assert.equal(old.messages.length, 1);
  assert.equal(next.messages.length, 2);
  f.delivery.detachIfCurrent(next);
  f.setCurrent([1, 2, 3, 4]);
  const reopened = f.target();
  f.delivery.attachAfterLoad(reopened);
  assert.deepEqual(reopened.messages[0].result, { ok: true, snapshot: { calledNumbers: [1, 2, 3, 4] } });
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
