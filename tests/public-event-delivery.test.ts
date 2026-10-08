import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublicEventDelivery, PUBLIC_EVENT_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRESENTATION_CHANNEL,
  PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_LINE_RECEIPT_CHANNEL, PUBLIC_PRIZES_CHANNEL, PUBLIC_THEME_CHANNEL, type PublicEventMeta, type PublicEventPrizes,
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
  let theme: 'jules' | 'high-contrast' = 'high-contrast';
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => theme);
  const target = () => {
    const messages: Message[] = [];
    return { messages, isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  };
  const first = target();
  delivery.attachAfterLoad(first);
  assert.deepEqual(first.messages.map(({ channel }) => channel), [PUBLIC_THEME_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.equal(first.messages[0].result, 'high-contrast');
  theme = 'jules';
  delivery.publishTheme('jules');
  assert.deepEqual(first.messages[2], { channel: PUBLIC_THEME_CHANNEL, result: 'jules' });
  delivery.detachIfCurrent(first);
  delivery.publishTheme('jules');
  assert.equal(first.messages.length, 3);
  const reopened = target();
  delivery.attachAfterLoad(reopened);
  assert.deepEqual(reopened.messages[0], { channel: PUBLIC_THEME_CHANNEL, result: 'jules' });
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
  f.delivery.publishActive('jules');
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
  delivery.publishActive('jules');
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
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => 'jules',
    () => ({ name: 'N', date: '2026-08-15', place: 'P' }));
  const messages: string[] = [];
  const window = { isDestroyed: () => false, send: (channel: string) => {
    messages.push(channel);
    if (channel === PUBLIC_META_CHANNEL) throw new Error('send failed');
  } };
  delivery.attachAfterLoad(window);
  assert.deepEqual(messages, [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL]);
});

test('committed prizes are sent after metadata and before state, republished on saves and selection, never leaking errors', () => {
  let prizes: PublicEventPrizes = { line: { amount: 150, lot: 'Jamón' }, bingo: { amount: 0, lot: '' } };
  let fail = false;
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => 'jules',
    () => ({ name: 'N', date: '2026-08-15', place: 'P' }), () => {
      if (fail) throw new Error('private storage detail');
      return prizes;
    });
  const messages: Message[] = [];
  const window = { isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  delivery.publishPrizes();
  assert.equal(messages.length, 0, 'nothing is sent before a window attaches');
  delivery.attachAfterLoad(window);
  assert.deepEqual(messages.map(({ channel }) => channel),
    [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.deepEqual(messages[2].result, prizes);
  assert.notEqual(messages[2].result, prizes, 'a copy is sent');
  prizes = { line: { amount: 0, lot: '' }, bingo: { amount: 500, lot: 'Viaje' } };
  delivery.publishPrizes();
  assert.deepEqual(messages.at(-1), { channel: PUBLIC_PRIZES_CHANNEL, result: prizes });
  delivery.publishMeta();
  assert.equal(messages.at(-1)?.channel, PUBLIC_META_CHANNEL, 'a metadata edit does not resend prizes');
  delivery.publishActive('high-contrast');
  assert.deepEqual(messages.slice(-4).map(({ channel }) => channel),
    [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  fail = true;
  delivery.publishPrizes();
  assert.deepEqual(messages.at(-1), { channel: PUBLIC_PRIZES_CHANNEL, result: null });
  assert.equal(JSON.stringify(messages).includes('private storage detail'), false);
});

test('a prize send that closes the window stops the attach before event state', () => {
  const delivery = createPublicEventDelivery({ load: () => snapshot([7]) }, () => 'jules', undefined,
    () => ({ line: { amount: 1, lot: '' }, bingo: { amount: 2, lot: '' } }));
  const messages: string[] = [];
  const window = { isDestroyed: () => false, send: (channel: string) => {
    messages.push(channel);
    if (channel === PUBLIC_PRIZES_CHANNEL) throw new Error('send failed');
  } };
  delivery.attachAfterLoad(window);
  assert.deepEqual(messages, [PUBLIC_THEME_CHANNEL, PUBLIC_PRIZES_CHANNEL]);
});

test('a presentation reaches only the live current window, reports delivery, and is never replayed on attach', () => {
  const f = fixture();
  const tongo = { kind: 'tongo', id: 1, durationMs: 3000 } as const;
  assert.equal(f.delivery.publishPresentation(tongo), false);
  const first = f.target();
  f.delivery.attachAfterLoad(first);
  assert.equal(f.delivery.publishPresentation(tongo), true);
  assert.deepEqual(first.messages.at(-1), { channel: PUBLIC_PRESENTATION_CHANNEL, result: tongo });
  const reloaded = f.target();
  f.delivery.attachAfterLoad(reloaded);
  assert.deepEqual(reloaded.messages.map(({ channel }) => channel), [PUBLIC_EVENT_CHANNEL]);
  reloaded.failSend();
  assert.equal(f.delivery.publishPresentation({ ...tongo, id: 2 }), false);
  const closed = f.target();
  f.delivery.attachAfterLoad(closed);
  closed.destroy();
  assert.equal(f.delivery.publishPresentation({ ...tongo, id: 3 }), false);
  assert.equal(first.messages.filter(({ channel }) => channel === PUBLIC_PRESENTATION_CHANNEL).length, 1);
});

// First-line award transport: static committed state only, never a live celebration signal.
const storedAward = (eventId = 'event-a', lot = '', winnerCount = 3) => ({
  eventId,
  award: { winnerCount, totalCents: 1000, shareCents: 333, remainderCents: 1, lot,
    lotResolution: lot !== '' && winnerCount >= 2 ? 'pending' as const : 'not_required' as const },
  presentation: { id: 'secret-presentation-id', status: 'started' as const, startedAt: 10, deadlineAt: 4010 },
});
function awardFixture(initial: ReturnType<typeof storedAward> | null) {
  let award = initial;
  let fail = false;
  const delivery = createPublicEventDelivery({ load: () => snapshot([5]) }, () => 'light',
    () => ({ name: 'N', date: '2026-01-01', place: 'P' }),
    () => ({ line: { amount: 10, lot: '' }, bingo: { amount: 0, lot: '' } }),
    () => { if (fail) throw new Error('private detail'); return award; });
  const target = () => {
    const messages: Message[] = [];
    return { messages, isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  };
  return { delivery, target, set: (next: typeof award) => { award = next; }, failRead: () => { fail = true; } };
}
const channelsOf = (messages: Message[]) => messages.map((message) => message.channel);
const publicAward = { eventId: 'event-a', winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1,
  lot: '', lotResolution: 'not_required' };

test('attach sends the committed award between prizes and history as static data without presentation identity', () => {
  const f = awardFixture(storedAward());
  const target = f.target();
  f.delivery.attachAfterLoad(target);
  assert.deepEqual(channelsOf(target.messages), [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL,
    PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.deepEqual(target.messages[3].result, publicAward);
  assert.doesNotMatch(JSON.stringify(target.messages), /secret-presentation-id|startedAt|deadlineAt/);
  assert.equal(channelsOf(target.messages).includes(PUBLIC_PRESENTATION_CHANNEL), false);
});

test('a missing, unreadable or unwired award reads as null and never blocks history', () => {
  const absent = awardFixture(null), first = absent.target();
  absent.delivery.attachAfterLoad(first);
  assert.deepEqual(first.messages[3], { channel: PUBLIC_LINE_AWARD_CHANNEL, result: null });
  assert.equal(channelsOf(first.messages).at(-1), PUBLIC_EVENT_CHANNEL);
  const broken = awardFixture(storedAward()), second = broken.target();
  broken.failRead();
  broken.delivery.attachAfterLoad(second);
  assert.deepEqual(second.messages[3], { channel: PUBLIC_LINE_AWARD_CHANNEL, result: null });
  assert.doesNotMatch(JSON.stringify(second.messages), /private detail/);
  const unwired = fixture(), third = unwired.target();
  unwired.delivery.attachAfterLoad(third);
  assert.equal(channelsOf(third.messages).includes(PUBLIC_LINE_AWARD_CHANNEL), false);
});

test('committed publication transports the award, then the snapshot, and each send is a defensive copy', () => {
  const f = awardFixture(null), target = f.target();
  f.delivery.attachAfterLoad(target);
  target.messages.length = 0;
  f.set(storedAward('event-a', 'Jamón', 2));
  f.delivery.publishCommitted(snapshot([5, 6], 'line_declared', '2026-01-01T00:00:00.000Z'));
  assert.deepEqual(channelsOf(target.messages), [PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.deepEqual(target.messages[0].result, { ...publicAward, winnerCount: 2, lot: 'Jamón', lotResolution: 'pending' });
  (target.messages[0].result as { lot: string }).lot = 'mutated';
  f.delivery.publishCommitted(snapshot([5, 6, 7], 'line_declared', '2026-01-01T00:00:01.000Z'));
  assert.equal((target.messages[2].result as { lot: string }).lot, 'Jamón');
});

test('an event switch replaces the award with the new event\'s or clears the previous one, in reveal order', () => {
  const f = awardFixture(storedAward('event-a')), target = f.target();
  f.delivery.attachAfterLoad(target);
  target.messages.length = 0;
  f.set(storedAward('event-b'));
  f.delivery.publishActive('jules');
  assert.deepEqual(channelsOf(target.messages), [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL,
    PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.equal((target.messages[3].result as { eventId: string }).eventId, 'event-b');
  target.messages.length = 0;
  f.set(null);
  f.delivery.publishActive('jules');
  assert.deepEqual(target.messages[3], { channel: PUBLIC_LINE_AWARD_CHANNEL, result: null });
});

test('award state is never a presentation signal: reattach and publication send nothing on the Tongo channel', () => {
  const f = awardFixture(storedAward()), first = f.target(), second = f.target();
  f.delivery.attachAfterLoad(first);
  f.delivery.publishCommitted(snapshot([5, 6]));
  f.delivery.attachAfterLoad(second);
  f.delivery.publishActive('light');
  for (const target of [first, second]) {
    assert.equal(channelsOf(target.messages).includes(PUBLIC_PRESENTATION_CHANNEL), false);
  }
});

const signal = { kind: 'line', id: 'p1', durationMs: 4000 } as const;
const PAGE = 'file:///app/dist/renderer/public.html';

test('a line signal reaches only the current window, is reported delivered, and is never resent on attach or switch', () => {
  const f = fixture(), first = f.target(), next = f.target();
  assert.equal(f.delivery.publishPresentation(signal), false);
  f.delivery.attachAfterLoad(first);
  first.messages.length = 0;
  assert.equal(f.delivery.publishPresentation(signal), true);
  assert.deepEqual(first.messages, [{ channel: PUBLIC_PRESENTATION_CHANNEL, result: signal }]);
  first.failSend();
  assert.equal(f.delivery.publishPresentation(signal), false);
  f.delivery.attachAfterLoad(next);
  f.delivery.publishActive('light');
  assert.equal(channelsOf(next.messages).includes(PUBLIC_PRESENTATION_CHANNEL), false);
});

test('a line receipt is bound to the exact frame the signal was sent to, and is one-shot', () => {
  const f = fixture();
  const frameA = { url: PAGE }, frameB = { url: PAGE };
  const target = Object.assign(f.target(), { mainFrame: frameA as { url: string } }), other = f.target();
  const event = (sender: unknown, senderFrame: unknown) => ({ sender, senderFrame });
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), false, 'nothing sent yet');
  f.delivery.attachAfterLoad(target);
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), false, 'attach binds nothing');
  assert.equal(f.delivery.publishPresentation(signal), true);
  // Rejections never consume the binding.
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'other', PAGE), false, 'wrong id');
  assert.equal(f.delivery.acceptLineReceipt(event(other, frameA), 'p1', PAGE), false, 'wrong sender');
  assert.equal(f.delivery.acceptLineReceipt(event(target, { url: PAGE }), 'p1', PAGE), false, 'unrelated frame');
  assert.equal(f.delivery.acceptLineReceipt(event(target, null), 'p1', PAGE), false);
  assert.equal(f.delivery.acceptLineReceipt(event(target, undefined), 'p1', PAGE), false);
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', 'file:///other.html'), false, 'wrong url');
  // The same webContents replaces its main frame: the new frame was never sent the signal, the old one is stale.
  target.mainFrame = frameB;
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameB), 'p1', PAGE), false, 'replacement frame');
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), false, 'old frame no longer current');
  target.mainFrame = frameA;
  frameA.url = 'file:///elsewhere.html';
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), false, 'navigated away');
  frameA.url = PAGE;
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), true, 'original frame while current');
  assert.equal(f.delivery.acceptLineReceipt(event(target, frameA), 'p1', PAGE), false, 'one-shot: no replay');
});

test('a receipt binding dies with its window and is replaced by the next signal; Tongo and failed sends bind nothing', () => {
  const f = fixture();
  const frame = { url: PAGE };
  const event = (sender: unknown) => ({ sender, senderFrame: frame });
  const target = Object.assign(f.target(), { mainFrame: frame });
  f.delivery.attachAfterLoad(target);
  f.delivery.publishPresentation({ kind: 'tongo', id: 1, durationMs: 3000 });
  assert.equal(f.delivery.acceptLineReceipt(event(target), '1', PAGE), false, 'Tongo is never receipted');
  f.delivery.publishPresentation(signal);
  f.delivery.publishPresentation({ ...signal, id: 'p2' });
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p1', PAGE), false, 'superseded by a newer signal');
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p2', PAGE), true);
  f.delivery.publishPresentation(signal);
  f.delivery.detachIfCurrent(target);
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p1', PAGE), false, 'detached');
  const next = Object.assign(f.target(), { mainFrame: frame });
  f.delivery.attachAfterLoad(next);
  assert.equal(f.delivery.acceptLineReceipt(event(next), 'p1', PAGE), false, 'attach never inherits a binding');
  next.failSend();
  assert.equal(f.delivery.publishPresentation({ ...signal, id: 'p3' }), false);
  assert.equal(f.delivery.acceptLineReceipt(event(next), 'p3', PAGE), false, 'failed send binds nothing');
});

test('a throwing frame access never delivers a line signal or authorizes a receipt', () => {
  const f = fixture();
  const throwing = { ...f.target(), get mainFrame(): never { throw new Error('gone'); } };
  f.delivery.attachAfterLoad(throwing);
  throwing.messages.length = 0;
  assert.equal(f.delivery.publishPresentation(signal), false);
  assert.deepEqual(throwing.messages, []);
  assert.equal(f.delivery.acceptLineReceipt({ sender: throwing, senderFrame: {} }, 'p1', PAGE), false);
});

test('a main-frame navigation detaches the window and voids its receipt even when the same target, frame and URL survive', () => {
  const f = fixture();
  const frame = { url: PAGE };
  const event = (sender: unknown) => ({ sender, senderFrame: frame });
  const target = Object.assign(f.target(), { mainFrame: frame });
  f.delivery.attachAfterLoad(target);
  f.delivery.publishPresentation(signal);
  f.delivery.navigationStarted(target);
  // While the new document loads, nothing is delivered to it, live signals included.
  target.messages.length = 0;
  assert.equal(f.delivery.publishPresentation({ ...signal, id: 'during' }), false);
  f.delivery.publishCommitted(snapshot([1]));
  assert.deepEqual(target.messages, []);
  // The finished load re-attaches the very same target, frame and URL: static state only, and the old id stays void.
  f.delivery.attachAfterLoad(target);
  assert.equal(channelsOf(target.messages).includes(PUBLIC_PRESENTATION_CHANNEL), false, 'no replay on attach');
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p1', PAGE), false, 'old awaited signal is void');
  assert.equal(f.delivery.publishPresentation({ ...signal, id: 'p2' }), true);
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p1', PAGE), false);
  assert.equal(f.delivery.acceptLineReceipt(event(target), 'p2', PAGE), true, 'a fresh signal binds fresh');
});

test('navigation of an unrelated window leaves the rightful receipt binding and delivery intact', () => {
  const f = fixture();
  const frame = { url: PAGE };
  const target = Object.assign(f.target(), { mainFrame: frame }), foreign = f.target();
  f.delivery.attachAfterLoad(target);
  f.delivery.publishPresentation(signal);
  f.delivery.navigationStarted(foreign);
  assert.equal(f.delivery.publishPresentation({ ...signal, id: 'p1' }), true, 'still the current target');
  assert.equal(f.delivery.acceptLineReceipt({ sender: target, senderFrame: frame }, 'p1', PAGE), true);
});

test('the receipt channel is a fixed literal', () => {
  assert.equal(PUBLIC_LINE_RECEIPT_CHANNEL, 'public:line-presentation-started');
});

// Strict lot facts (LOT05A): the winner comes only from the strict store snapshot, never from arithmetic or inference.
type LotFact = { origin: string; resolution: string; [key: string]: unknown };
const lotSnap = (fact: LotFact, over: Record<string, unknown> = {}) => ({ eventId: 'event-a', auditSequence: 7, winnerCount: 3,
  lot: 'Jamón', presentation: { id: 'secret-presentation-id', status: 'completed' }, fact, ...over });
const numbered = (participantNumber: number, colorId: string): LotFact => ({ origin: 'numbered_v1', resolution: 'resolved',
  paletteVersion: 1, participantNumber, colorId });
function lotFixture(award: ReturnType<typeof storedAward> | null, lot: unknown) {
  let currentLot = lot, fail = false;
  const delivery = createPublicEventDelivery({ load: () => snapshot([5]) }, () => 'light',
    () => ({ name: 'N', date: '2026-01-01', place: 'P' }),
    () => ({ line: { amount: 10, lot: '' }, bingo: { amount: 0, lot: '' } }), () => award,
    () => { if (fail) throw new Error('private detail'); return currentLot as never; });
  const messages: Message[] = [];
  const target = { isDestroyed: () => false, send: (channel: string, result: unknown) => { messages.push({ channel, result }); } };
  delivery.attachAfterLoad(target);
  return { delivery, messages, target, set: (next: unknown) => { currentLot = next; }, fail: () => { fail = true; },
    award: () => messages.find((m) => m.channel === PUBLIC_LINE_AWARD_CHANNEL)!.result as Record<string, unknown> | null };
}
const resolvedAward = (winnerCount = 3) => ({ ...storedAward('event-a', 'Jamón', winnerCount),
  award: { ...storedAward('event-a', 'Jamón', winnerCount).award, lotResolution: 'resolved' as const } });

test('a strict numbered fact is projected as a copied winner fact without presentation or audit identity', () => {
  const snap = lotSnap(numbered(2, 'blue'));
  const f = lotFixture(resolvedAward(), snap);
  const award = f.award()!;
  assert.deepEqual(award, { eventId: 'event-a', winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1,
    lot: 'Jamón', lotResolution: 'resolved', lotResult: numbered(2, 'blue') });
  assert.notEqual(award.lotResult, snap.fact);
  (award.lotResult as { colorId: string }).colorId = 'mutated';
  assert.equal(snap.fact.colorId, 'blue');
  assert.doesNotMatch(JSON.stringify(f.messages), /secret-presentation-id|auditSequence|startedAt/);
});

test('a legacy resolved fact stays an explicit unknown winner and invents no participant', () => {
  const f = lotFixture(resolvedAward(), lotSnap({ origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' }));
  assert.deepEqual(f.award()!.lotResult, { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' });
  assert.doesNotMatch(JSON.stringify(f.award()), /participantNumber|colorId/);
});

test('pending and not-required facts keep their distinction with no winner', () => {
  const pending = lotFixture(storedAward('event-a', 'Jamón', 3), lotSnap({ origin: 'none', resolution: 'pending' }));
  assert.deepEqual(pending.award()!.lotResult, { origin: 'none', resolution: 'pending' });
  const none = lotFixture(storedAward('event-a', '', 3), lotSnap({ origin: 'none', resolution: 'not_required' }, { lot: '' }));
  assert.deepEqual(none.award()!.lotResult, { origin: 'none', resolution: 'not_required' });
});

test('an unwired strict loader adds no fact field and never fabricates one', () => {
  const f = awardFixture(storedAward()), target = f.target();
  f.delivery.attachAfterLoad(target);
  assert.equal(Object.hasOwn(target.messages[3].result as object, 'lotResult'), false);
});

test('an unavailable, throwing, foreign or inconsistent strict fact clears the award', () => {
  const ok = numbered(2, 'blue');
  const cases: [string, unknown][] = [['null', null], ['foreign event', lotSnap(ok, { eventId: 'event-b' })],
    ['winner count', lotSnap(ok, { winnerCount: 4 })], ['lot', lotSnap(ok, { lot: 'Other' })],
    ['presentation', lotSnap(ok, { presentation: { id: 'other', status: 'completed' } })],
    ['wrong color', lotSnap(numbered(2, 'red'))], ['over count', lotSnap(numbered(4, 'red'), { winnerCount: 3 })],
    ['pending vs resolved', lotSnap({ origin: 'none', resolution: 'pending' })],
    ['unknown origin', lotSnap({ origin: 'mystery', resolution: 'resolved' })],
    ['malformed', 'not an object']];
  for (const [name, bad] of cases) assert.equal(lotFixture(resolvedAward(), bad).award(), null, name);
  const thrown = lotFixture(resolvedAward(), lotSnap(ok));
  thrown.fail();
  thrown.messages.length = 0;
  thrown.delivery.publishCommitted(snapshot([5, 6]));
  assert.deepEqual(thrown.messages[0], { channel: PUBLIC_LINE_AWARD_CHANNEL, result: null });
  assert.doesNotMatch(JSON.stringify(thrown.messages), /private detail/);
});

test('strict facts keep reveal order, hydrate no presentation, and replacement clears the old fact', () => {
  const f = lotFixture(resolvedAward(), lotSnap(numbered(2, 'blue')));
  assert.deepEqual(channelsOf(f.messages), [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL,
    PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  f.messages.length = 0;
  f.delivery.publishCommitted(snapshot([5, 6]));
  assert.deepEqual(channelsOf(f.messages), [PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  f.messages.length = 0;
  f.set(null);
  f.delivery.publishActive('jules');
  assert.deepEqual(channelsOf(f.messages), [PUBLIC_THEME_CHANNEL, PUBLIC_META_CHANNEL, PUBLIC_PRIZES_CHANNEL,
    PUBLIC_LINE_AWARD_CHANNEL, PUBLIC_EVENT_CHANNEL]);
  assert.deepEqual(f.messages[3], { channel: PUBLIC_LINE_AWARD_CHANNEL, result: null });
  assert.equal(channelsOf(f.messages).includes(PUBLIC_PRESENTATION_CHANNEL), false);
});

test('the palette repeats cyclically in constant time up to MAX_SAFE_INTEGER', () => {
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
  for (const [n, color] of [[1, 'red'], [6, 'orange'], [7, 'red'], [Number.MAX_SAFE_INTEGER, 'red']] as const) {
    const f = lotFixture(resolvedAward(Number.MAX_SAFE_INTEGER), lotSnap(numbered(n, color), { winnerCount: Number.MAX_SAFE_INTEGER }));
    assert.deepEqual(f.award()!.lotResult, numbered(n, color));
  }
  assert.equal(colors[(Number.MAX_SAFE_INTEGER - 1) % 6], 'red');
});

test('a matching resolution label cannot launder a wrong-origin strict fact', () => {
  const pendingAward = storedAward('event-a', 'Jamón', 3), noneAward = storedAward('event-a', '', 1);
  const legacy = (resolution: string): LotFact => ({ origin: 'legacy_v8', resolution, winner: 'unknown' });
  const wrong: [string, ReturnType<typeof storedAward>, unknown][] = [
    ['legacy pending', pendingAward, lotSnap(legacy('pending'))],
    ['numbered pending', pendingAward, lotSnap({ ...numbered(2, 'blue'), resolution: 'pending' })],
    ['legacy not_required', noneAward, lotSnap(legacy('not_required'), { lot: '', winnerCount: 1 })],
    ['numbered not_required', noneAward, lotSnap({ ...numbered(1, 'red'), resolution: 'not_required' }, { lot: '', winnerCount: 1 })],
  ];
  for (const [name, award, snap] of wrong) assert.equal(lotFixture(award, snap).award(), null, name);
});

test('refreshLineAward resends only the strict static award for the bound event, with no presentation or history', () => {
  const f = lotFixture(resolvedAward(), lotSnap(numbered(2, 'blue')));
  const before = f.messages.length;
  assert.equal(f.delivery.refreshLineAward('event-a'), true);
  assert.deepEqual(f.messages.slice(before).map((m) => m.channel), [PUBLIC_LINE_AWARD_CHANNEL]);
  const sent = f.messages[before].result as Record<string, any>;
  assert.deepEqual(sent.lotResult, { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 2, colorId: 'blue' });
  assert.doesNotMatch(JSON.stringify(sent), /secret-presentation-id/);
});

test('refreshLineAward sends nothing for a foreign event, a missing or inconsistent fact, a throw, or no window', () => {
  const f = lotFixture(resolvedAward(), lotSnap(numbered(2, 'blue')));
  const before = f.messages.length;
  assert.equal(f.delivery.refreshLineAward('event-b'), false);
  f.set(lotSnap(numbered(2, 'blue'), { lot: 'Other' }));
  assert.equal(f.delivery.refreshLineAward('event-a'), false);
  f.set(null);
  assert.equal(f.delivery.refreshLineAward('event-a'), false);
  f.fail();
  assert.equal(f.delivery.refreshLineAward('event-a'), false);
  assert.equal(f.messages.length, before);
  f.delivery.detachIfCurrent(f.target);
  f.set(lotSnap(numbered(2, 'blue')));
  assert.equal(f.delivery.refreshLineAward('event-a'), false);
  assert.equal(f.messages.length, before);
});

test('refreshLineAward neither disturbs a pending line receipt binding nor sends on the presentation channel', () => {
  const f = lotFixture(resolvedAward(), lotSnap(numbered(2, 'blue')));
  const frame = { url: PAGE };
  const bound = { ...f.target, mainFrame: frame };
  f.delivery.attachAfterLoad(bound);
  assert.equal(f.delivery.publishPresentation(signal), true);
  const before = f.messages.length;
  f.delivery.refreshLineAward('event-a');
  assert.ok(f.messages.slice(before).every((m) => m.channel === PUBLIC_LINE_AWARD_CHANNEL));
  assert.equal(f.delivery.acceptLineReceipt({ sender: bound, senderFrame: frame }, 'p1', PAGE), true);
});
