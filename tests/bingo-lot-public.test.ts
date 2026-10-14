import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { BINGO_LOT_CHANNELS } from '../src/bingo-lot-ipc.ts';
import { BINGO_LOT_PRESENT_CHANNEL, registerBingoLotPresentation } from '../src/bingo-lot-presentation.ts';
import { createPublicEventDelivery, PUBLIC_BINGO_AWARD_CHANNEL } from '../src/public-event-delivery.ts';

// The wire literal is the contract either way; the delivery export is pinned in the boundary suite.
const PUBLIC_BINGO_LOT_CHANNEL = 'public:bingo-lot';
const PUBLIC_EVENT_CHANNEL = 'public:event-state';
type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => any;
const url = 'file:///app/operator.html';
const lot = (fact: object = { origin: 'none', resolution: 'pending' }): any => ({ eventId: 'e1', auditSequence: 4,
  winnerCount: 5, lot: 'Hamper', presentation: { id: 'p1', status: 'completed' }, fact });
const won = (participantNumber = 2, colorId = 'blue'): any => lot({ origin: 'numbered_v1', resolution: 'resolved',
  paletteVersion: 1, participantNumber, colorId });

// Minimal real fixture: the real operator guard, real bingo lot IPC and presentation wrapper over a strict store.
function fixture() {
  const sender = {};
  const frame = { url };
  const handlers = new Map<string, Handler>();
  const f: any = { state: lot(), published: [] as any[], deliver: undefined as undefined | ((s: any) => unknown) };
  const store = {
    loadBingoLotResult() { return f.state; },
    resolveBingoLot(_e: unknown, r: any) { f.state = won(r.participantNumber, r.colorId); return f.state; },
  };
  f.present = registerBingoLotPresentation({ handle: (c: string, h: Handler) => handlers.set(c, h) }, store, {
    authorize: createOperatorGuard(sender, () => frame, url),
    select: () => ({ participantNumber: 2, colorId: 'blue' }),
    refresh: () => {},
    publish: (signal: unknown) => { f.published.push(signal); return f.deliver ? f.deliver(signal) : true; },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender, senderFrame: frame }, ...args);
  return Object.assign(f, { draw: () => call(BINGO_LOT_CHANNELS.draw, { eventId: 'e1', auditSequence: 4, presentationId: 'p1' }),
    send: (...a: unknown[]) => call(BINGO_LOT_PRESENT_CHANNEL, ...a) });
}

const publicUrl = 'file:///app/public.html';
const lineAward = { eventId: 'e1', presentation: { id: 'p1' },
  award: { winnerCount: 5, totalCents: 500, shareCents: 100, remainderCents: 0, lot: 'Hamper', lotResolution: 'resolved' } };
const bingoAward = { eventId: 'e1', presentation: { id: 'p1' },
  award: { winnerCount: 2, totalCents: 5000, shareCents: 2500, remainderCents: 0, lot: 'Cesta', lotResolution: 'resolved' } };
const publicBingo = { eventId: 'e1', winnerCount: 2, totalCents: 5000, shareCents: 2500, remainderCents: 0,
  lot: 'Cesta', lotResolution: 'resolved' };

function lotTarget() {
  const messages: { channel: string; result: any }[] = [];
  const t: any = { messages, mainFrame: { url: publicUrl }, destroyed: false, failSend: false, isDestroyed: () => t.destroyed,
    send: (channel: string, result: unknown) => { if (t.failSend) throw new Error('x'); messages.push({ channel, result }); } };
  return t;
}
const lotMessages = (t: any) => t.messages.filter((m: any) => m.channel === PUBLIC_BINGO_LOT_CHANNEL);
const signal = { id: 'c1', participantNumber: 2, colorId: 'blue' };

function bingoDelivery(hooks: { bingo?: () => void; load?: () => void } = {}, lot?: () => unknown) {
  return createPublicEventDelivery(
    { load: () => { hooks.load?.(); return { calledNumbers: [1], phase: 'drawing' as const, lastTransitionAt: null }; } },
    undefined, undefined, undefined, () => lineAward as any, undefined,
    () => { hooks.bingo?.(); return bingoAward as any; }, lot);
}

test('delivery sends the bingo award, then history, then the whitelisted signal, and never replays it', () => {
  const delivery = bingoDelivery();
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  assert.equal(delivery.publishBingoLot(signal, publicUrl), true);
  assert.deepEqual(lotMessages(t)[0].result, { id: 'c1', participantNumber: 2, colorId: 'blue' });
  assert.deepEqual(Object.keys(lotMessages(t)[0].result).sort(), ['colorId', 'id', 'participantNumber']);
  const at = (channel: string) => t.messages.findIndex((m: any) => m.channel === channel);
  assert.ok(at(PUBLIC_BINGO_AWARD_CHANNEL) < at(PUBLIC_EVENT_CHANNEL) && at(PUBLIC_EVENT_CHANNEL) < at(PUBLIC_BINGO_LOT_CHANNEL));
  const next = lotTarget();
  delivery.navigationStarted(t);
  delivery.attachAfterLoad(next);
  delivery.navigationStarted(next);
  delivery.attachAfterLoad(t);
  delivery.publishActive('dark' as any);
  assert.equal(lotMessages(t).length + lotMessages(next).length, 1, 'attach, reattach and publishActive never replay the signal');
});

test('delivery refuses missing, destroyed, wrong-URL, frameless and failing targets without live state', () => {
  const delivery = bingoDelivery();
  assert.equal(delivery.publishBingoLot(signal, publicUrl), false);
  const cases: ((t: any) => void)[] = [(t) => { t.destroyed = true; }, (t) => { t.mainFrame.url = 'file:///x.html'; },
    (t) => { t.mainFrame = null; }, (t) => { t.failSend = true; }];
  for (const arm of cases) {
    const t = lotTarget();
    delivery.attachAfterLoad(t);
    arm(t);
    assert.equal(delivery.publishBingoLot(signal, publicUrl), false);
    assert.equal(lotMessages(t).length, 0);
  }
});

test('navigation, active-event switch, reattach, frame or URL change drop the signal before it is sent', () => {
  const acts: ((t: any, d: any) => void)[] = [(t, d) => d.navigationStarted(t), (t, d) => d.publishActive('dark' as any),
    (t) => { t.mainFrame = { url: publicUrl }; }, (t) => { t.mainFrame.url = 'file:///moved.html'; },
    (t, d) => d.attachAfterLoad(lotTarget()), (t, d) => d.detachIfCurrent(t)];
  for (const act of acts) {
    let armed = false;
    let run = () => {};
    const delivery = bingoDelivery({ bingo: () => { if (armed) { armed = false; run(); } } });
    const t = lotTarget();
    delivery.attachAfterLoad(t);
    run = () => act(t, delivery);
    armed = true;
    assert.equal(delivery.publishBingoLot(signal, publicUrl), false);
    assert.equal(lotMessages(t).length, 0);
  }
});

test('real bingo presentation delivers a directly drawn lot to the same public target once', () => {
  const f = fixture();
  const delivery = bingoDelivery();
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  f.deliver = (s: any) => delivery.publishBingoLot(s, publicUrl);
  const r = f.draw();
  assert.equal(r.kind, 'committed');
  assert.deepEqual(f.send(r.snapshot), { ok: true });
  assert.deepEqual([lotMessages(t).length, Object.keys(lotMessages(t)[0].result).sort()], [1, ['colorId', 'id', 'participantNumber']]);
  assert.equal(f.send(r.snapshot).code, 'ineligible');
  assert.equal(lotMessages(t).length, 1);
});

test('publishBingoLot sends the hydrated bingo award before history and the signal, and refresh carries the fact', () => {
  // BG-06C1b: the award payload is now hydrated with the strict lot fact; the C1a fence order is unchanged.
  const snap = { eventId: 'e1', winnerCount: 2, lot: 'Cesta', presentation: { id: 'p1' }, fact: won().fact };
  const delivery = bingoDelivery({}, () => snap);
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  assert.equal(delivery.publishBingoLot(signal, publicUrl), true);
  const at = (channel: string) => t.messages.findIndex((m: any) => m.channel === channel);
  assert.ok(at(PUBLIC_BINGO_AWARD_CHANNEL) < at(PUBLIC_EVENT_CHANNEL) && at(PUBLIC_EVENT_CHANNEL) < at(PUBLIC_BINGO_LOT_CHANNEL));
  assert.deepEqual(t.messages[at(PUBLIC_BINGO_AWARD_CHANNEL)].result, { ...publicBingo, lotResult: won().fact });
  t.messages.length = 0;
  assert.equal(delivery.refreshBingoAward('e1'), true);
  assert.deepEqual(t.messages[0].result, { ...publicBingo, lotResult: won().fact });
  assert.doesNotMatch(JSON.stringify(t.messages), /auditSequence/);
});

test('refreshBingoAward resends only the static bingo award for the bound event and never a lot channel', () => {
  const delivery = bingoDelivery();
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  assert.equal(delivery.refreshBingoAward('e1'), true);
  assert.deepEqual(t.messages.map((m: any) => m.channel), [PUBLIC_BINGO_AWARD_CHANNEL]);
  assert.deepEqual(t.messages[0].result, publicBingo);
  t.messages.length = 0;
  assert.equal(delivery.refreshBingoAward('e2'), false);
  assert.equal(t.messages.length, 0);
});
