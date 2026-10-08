import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { LINE_LOT_CHANNELS } from '../src/line-lot-ipc.ts';
import { LINE_LOT_PRESENT_CHANNEL, registerLineLotPresentation } from '../src/line-lot-presentation.ts';
import { createPublicEventDelivery, PUBLIC_EVENT_CHANNEL, PUBLIC_LINE_AWARD_CHANNEL } from '../src/public-event-delivery.ts';

// The planned constant is not exported yet; the public wire literal is the contract either way.
const PUBLIC_LINE_LOT_CHANNEL = 'public:line-lot';
type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => any;
const url = 'file:///app/operator.html';
const lot = (fact: object = { origin: 'none', resolution: 'pending' }): any => ({ eventId: 'e1', auditSequence: 4,
  winnerCount: 5, lot: 'Hamper', presentation: { id: 'p1', status: 'completed' }, fact });
const won = (participantNumber = 2, colorId = 'blue'): any => lot({ origin: 'numbered_v1', resolution: 'resolved',
  paletteVersion: 1, participantNumber, colorId });

// Minimal real fixture: the real operator guard, real lot IPC and real presentation wrapper over a mutable strict store.
function fixture() {
  const sender = {};
  const frame = { url };
  const handlers = new Map<string, Handler>();
  const f: any = { state: lot(), published: [] as any[], deliver: undefined as undefined | ((s: any) => unknown) };
  const store = {
    loadLineLotResult() { return f.state; },
    resolveLineLot(_e: unknown, r: any) { f.state = won(r.participantNumber, r.colorId); return f.state; },
  };
  f.present = registerLineLotPresentation({ handle: (c: string, h: Handler) => handlers.set(c, h) }, store, {
    authorize: createOperatorGuard(sender, () => frame, url),
    select: () => ({ participantNumber: 2, colorId: 'blue' }),
    publish: (signal: unknown) => { f.published.push(signal); return f.deliver ? f.deliver(signal) : true; },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender, senderFrame: frame }, ...args);
  return Object.assign(f, { draw: () => call(LINE_LOT_CHANNELS.draw, { eventId: 'e1', auditSequence: 4, presentationId: 'p1' }),
    send: (...a: unknown[]) => call(LINE_LOT_PRESENT_CHANNEL, ...a) });
}

const publicUrl = 'file:///app/public.html';
function lotTarget() {
  const messages: { channel: string; result: any }[] = [];
  const t: any = { messages, mainFrame: { url: publicUrl }, destroyed: false, failSend: false, isDestroyed: () => t.destroyed,
    send: (channel: string, result: unknown) => { if (t.failSend) throw new Error('x'); messages.push({ channel, result }); t.onSend?.(channel); } };
  return t;
}
const lotMessages = (t: any) => t.messages.filter((m: any) => m.channel === PUBLIC_LINE_LOT_CHANNEL);
function lotDelivery(onAward: () => void = () => {}, extra: { load?: () => void; lot?: () => any } = {}) {
  return createPublicEventDelivery({ load: () => { extra.load?.(); return { calledNumbers: [1], phase: 'drawing' as const, lastTransitionAt: null }; } },
    undefined, undefined, undefined, () => { onAward(); return { eventId: 'e1', presentation: { id: 'p1' },
      award: { winnerCount: 5, totalCents: 500, shareCents: 100, remainderCents: 0, lot: 'Hamper', lotResolution: 'resolved' } } as any; },
    extra.lot);
}
const signal = { id: 'c1', participantNumber: 2, colorId: 'blue', name: 'Ann', presentationId: 'p1', auditSequence: 4 } as any;

test('delivery sends only the whitelisted signal after static state, and never replays it', () => {
  const delivery = lotDelivery();
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  assert.equal(delivery.publishLineLot(signal, publicUrl), true);
  assert.deepEqual(lotMessages(t)[0].result, { id: 'c1', participantNumber: 2, colorId: 'blue' });
  assert.ok(t.messages.findIndex((m: any) => m.channel === PUBLIC_LINE_AWARD_CHANNEL) < t.messages.findIndex((m: any) => m.channel === PUBLIC_LINE_LOT_CHANNEL));
  const next = lotTarget();
  delivery.attachAfterLoad(next);
  delivery.attachAfterLoad(t);
  assert.equal(lotMessages(next).length + lotMessages(t).length, 1);
});

test('delivery refuses missing, destroyed, wrong-URL, frameless and failing targets without live state', () => {
  const delivery = lotDelivery();
  assert.equal(delivery.publishLineLot(signal, publicUrl), false);
  const cases: ((t: any) => void)[] = [(t) => { t.destroyed = true; }, (t) => { t.mainFrame.url = 'file:///x.html'; },
    (t) => { t.mainFrame = null; }, (t) => { t.failSend = true; }];
  for (const arm of cases) {
    const t = lotTarget();
    delivery.attachAfterLoad(t);
    arm(t);
    assert.equal(delivery.publishLineLot(signal, publicUrl), false);
    assert.equal(lotMessages(t).length, 0);
  }
});

test('navigation, reattach, frame or URL change and rebinding during static publication drop the signal', () => {
  const acts: ((t: any, d: any) => void)[] = [(t, d) => d.navigationStarted(t), (t, d) => { d.navigationStarted(t); d.attachAfterLoad(t); },
    (t) => { t.mainFrame = { url: publicUrl }; }, (t) => { t.mainFrame.url = 'file:///moved.html'; },
    (t, d) => d.attachAfterLoad(lotTarget()), (t, d) => d.detachIfCurrent(t)];
  for (const act of acts) {
    let armed = false;
    let run = () => {};
    const delivery = lotDelivery(() => { if (armed) { armed = false; run(); } });
    const t = lotTarget();
    delivery.attachAfterLoad(t);
    run = () => act(t, delivery);
    armed = true;
    assert.equal(delivery.publishLineLot(signal, publicUrl), false);
    assert.equal(lotMessages(t).length, 0);
  }
});

test('real presentation delivers a directly drawn lot to the same public target once', () => {
  const f = fixture();
  const delivery = lotDelivery(() => {}, { lot: () => f.state });
  const t = lotTarget();
  delivery.attachAfterLoad(t);
  t.messages.length = 0;
  f.deliver = (s: any) => delivery.publishLineLot(s, publicUrl);
  const r = f.draw();
  assert.equal(r.kind, 'committed');
  assert.deepEqual(f.send(r.snapshot), { ok: true });
  assert.deepEqual([lotMessages(t).length, Object.keys(lotMessages(t)[0].result).sort()], [1, ['colorId', 'id', 'participantNumber']]);
  assert.equal(f.send(r.snapshot).code, 'ineligible');
  assert.equal(lotMessages(t).length, 1);
});

// Event away (one change) or away and back (two) inside the static refresh that precedes the lot, at each of its four steps.
for (const point of ['award read', 'award send', 'history read', 'history send']) {
  for (const [name, changes] of [['event away', 1], ['event away and back', 2]] as const) {
    test(`${name} during ${point} drops the consumed lot handoff and never retries`, () => {
      const f = fixture();
      let armed = false;
      const fire = (step: string) => {
        if (!armed || step !== point) return;
        armed = false; // One-shot: nested publishActive calls cannot recurse.
        for (let i = 0; i < changes; i++) { // Each change flips the strict lot's event identity: e2 away, e1 back.
          f.state = { ...f.state, eventId: i % 2 === 0 ? 'e2' : 'e1' };
          f.present.invalidate();
          delivery.publishActive('dark' as any);
        }
      };
      const t = lotTarget();
      t.onSend = (c: string) => fire(c === PUBLIC_LINE_AWARD_CHANNEL ? 'award send' : c === PUBLIC_EVENT_CHANNEL ? 'history send' : '');
      const delivery = lotDelivery(() => fire('award read'), { load: () => fire('history read'), lot: () => f.state });
      delivery.attachAfterLoad(t);
      t.messages.length = 0;
      f.deliver = (s: any) => delivery.publishLineLot(s, publicUrl);
      const r = f.draw();
      assert.equal(r.kind, 'committed');
      armed = true;
      assert.deepEqual(f.send(r.snapshot), { ok: true });
      assert.equal(armed, false);
      assert.equal(lotMessages(t).length, 0);
      assert.equal(f.send(r.snapshot).code, 'ineligible');
      assert.equal(f.published.length, 1);
      assert.ok(t.messages.some((m: any) => m.channel === PUBLIC_EVENT_CHANNEL && m.result.eventChanged === true));
      const awards = t.messages.filter((m: any) => m.channel === PUBLIC_LINE_AWARD_CHANNEL);
      assert.equal(awards.some((m: any) => m.result === null), true); // The away event exposes no award for the old lot.
      assert.equal((awards[awards.length - 1].result === null), changes === 1); // Back restores the same current facts.
      const before = t.messages.length;
      delivery.publishActive('dark' as any);
      assert.ok(t.messages.length > before);
      assert.equal(lotMessages(t).length, 0);
    });
  }
}

test('main wires the presentation registrar, lifecycle invalidation and delivery in a safe order', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /registerLineLotIpc\(/);
  assert.match(main, /const lotPresentation = registerLineLotPresentation\(ipcMain, store, \{ authorize: operatorOnly,/);
  assert.match(main, /publish: \(signal\) => publicDelivery\.publishLineLot\(signal, publicUrl\)/);
  assert.match(main, /operator\.webContents\.on\('did-start-navigation', \(details\) => \{\s+if \(details\.isMainFrame && !details\.isSameDocument\) lotPresentation\.invalidate\(\);/);
  assert.match(main, /operator\.on\('close', \(\) => lotPresentation\.invalidate\(\)\)/);
  assert.match(main, /operator\.webContents\.once\('destroyed', \(\) => lotPresentation\.invalidate\(\)\)/);
  assert.match(main, /\(\) => \{ lotPresentation\.invalidate\(\); publicDelivery\.publishActive\(theme\.reload\(\)\); \}/);
  const at = (text: string) => main.indexOf(text);
  assert.ok(at('const publicUrl') < at('const lotPresentation') && at('const lotPresentation') < at('lotPresentation.invalidate'));
});
