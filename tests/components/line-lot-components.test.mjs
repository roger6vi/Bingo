import { fixture, html, expect } from '@open-wc/testing';
import { sendKeys } from '@web/test-runner-commands';
import '../../src/components/bingo-line-lot.mjs';

// Frozen controller-shaped fixtures; the component only reads them and never recomputes the outcome.
const fact = {
  pending: { origin: 'none', resolution: 'pending' },
  not_required: { origin: 'none', resolution: 'not_required' },
  numbered: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 5, colorId: 'purple' },
  legacy: { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' },
};
const snap = (f, extra = {}) => Object.freeze({
  eventId: 'e1', auditSequence: 3, winnerCount: 4, lot: 'Cesta', presentation: { id: 'p1', status: 'completed' }, fact: f, ...extra,
});
const winner = Object.freeze({ kind: 'number', participantNumber: 5, colorId: 'purple' });
const st = (o) => Object.freeze({ status: 'unknown', source: null, winner: null, busy: false, canDraw: false, snapshot: null, message: null, ...o });
const actionable = st({ status: 'actionable', canDraw: true, snapshot: snap(fact.pending) });
const resolved = (source) => st({ status: 'resolved', source, winner, snapshot: snap(fact.numbered, { winnerCount: 6 }) });

async function mount(state) {
  const el = await fixture(html`<bingo-line-lot .state=${state}></bingo-line-lot>`);
  const events = [];
  for (const n of ['line-lot-draw', 'line-lot-resync']) el.addEventListener(n, (e) => events.push(e));
  const q = (s) => el.shadowRoot.querySelector(s);
  return { el, events, draw: () => q('button[data-intent="draw"]'), resync: () => q('button[data-intent="resync"]'),
    text: () => el.shadowRoot.textContent.replace(/\s+/g, ' ').trim() };
}
const set = async (m, state) => { m.el.state = state; await m.el.updateComplete; };

describe('bingo-line-lot', () => {
  it('defaults fail closed with no winner, no intents and no unsolicited boundary calls', async () => {
    const calls = [];
    window.desktop = { readLineLot: () => calls.push('read'), drawLineLot: () => calls.push('draw') };
    const doc = [];
    document.addEventListener('line-lot-draw', (e) => doc.push(e));
    document.addEventListener('line-lot-resync', (e) => doc.push(e));
    const m = await mount(undefined);
    await set(m, st({ status: 'loading' }));
    expect(m.draw().disabled).to.equal(true);
    expect(m.resync().disabled).to.equal(true);
    expect(m.text()).to.not.include('Morado');
    m.draw().click(); m.resync().click(); m.el.requestDraw(); m.el.requestResync();
    expect(m.events).to.have.length(0);
    expect(doc).to.have.length(0);
    expect(calls).to.deep.equal([]);
    delete window.desktop;
  });

  it('emits one payloadless bubbling composed draw intent without touching the frozen state', async () => {
    const m = await mount(actionable);
    const docEvents = [];
    document.addEventListener('line-lot-draw', (e) => docEvents.push(e), { once: true });
    expect(m.draw().disabled).to.equal(false);
    m.draw().click();
    expect(m.events).to.have.length(1);
    const [e] = m.events;
    expect([e.type, e.bubbles, e.composed, e.detail]).to.deep.equal(['line-lot-draw', true, true, null]);
    expect(docEvents).to.have.length(1);
    m.el.requestDraw();
    expect(m.events).to.have.length(2);
    expect(m.el.state === actionable).to.equal(true);
    expect(Object.isFrozen(m.el.state)).to.equal(true);
    m.resync().click();
    expect(m.events[2].type).to.equal('line-lot-resync');
  });

  const blocked = {
    pending: st({ status: 'pending', snapshot: snap(fact.pending) }),
    loading: st({ status: 'loading' }),
    busy: st({ status: 'actionable', canDraw: true, busy: true, snapshot: snap(fact.pending) }),
    contradictory: st({ status: 'pending', canDraw: true, snapshot: snap(fact.pending) }),
    canDrawNotTrue: st({ status: 'actionable', canDraw: 'yes', snapshot: snap(fact.pending) }),
    unknown: st({}),
    resolved: st({ ...resolved('current'), canDraw: true }),
    recovery: st({ status: 'recovery', canDraw: true, message: 'x' }),
    error: st({ status: 'error', canDraw: true }),
  };
  for (const [name, state] of Object.entries(blocked)) {
    it(`guards draw natively and by method when ${name}`, async () => {
      const m = await mount(state);
      expect(m.draw().disabled).to.equal(true);
      m.draw().click(); m.el.requestDraw();
      expect(m.events).to.have.length(0);
    });
  }

  it('offers only manual resync for recovery and error, and guards disabled resync', async () => {
    for (const status of ['recovery', 'error']) {
      const m = await mount(st({ status, message: 'Estado incierto' }));
      expect(m.draw().disabled).to.equal(true);
      expect(m.resync().disabled).to.equal(false);
      m.resync().click(); m.el.requestResync();
      expect(m.events.map((e) => e.type)).to.deep.equal(['line-lot-resync', 'line-lot-resync']);
      expect(m.events.every((e) => e.detail === null && e.bubbles && e.composed)).to.equal(true);
    }
    for (const state of [st({}), st({ status: 'loading' }), blocked.busy]) {
      const m = await mount(state);
      expect(m.resync().disabled).to.equal(true);
      m.resync().click(); m.el.requestResync();
      expect(m.events).to.have.length(0);
    }
  });

  it('shows the same number and color for current, committed and recovered, with no animation', async () => {
    const texts = [];
    for (const source of ['current', 'committed', 'recovered']) {
      const m = await mount(resolved(source));
      texts.push(m.text());
      expect(m.text()).to.include('5').and.include('Morado').and.include('Cesta');
      expect(m.el.shadowRoot.querySelector('[class*="anim"]') === null).to.equal(true);
    }
    expect(new Set(texts).size).to.equal(1);
    const labels = { red: 'Rojo', blue: 'Azul', green: 'Verde', yellow: 'Amarillo', purple: 'Morado', orange: 'Naranja' };
    for (const [i, [colorId, label]] of Object.entries(labels).entries()) {
      const participantNumber = i + 1; // 1..6 within winnerCount 6, with the snapshot fact matching the winner.
      const numbered = { ...fact.numbered, participantNumber, colorId };
      const m = await mount(st({ ...resolved('current'), winner: { kind: 'number', participantNumber, colorId }, snapshot: snap(numbered, { winnerCount: 6 }) }));
      expect(m.text()).to.include(label).and.include(`participante ${participantNumber}`);
    }
  });

  it('shows legacy unknown and not_required as distinct explicit outcomes', async () => {
    const legacy = await mount(st({ status: 'resolved', source: 'recovered', winner: { kind: 'unknown' }, snapshot: snap(fact.legacy, { winnerCount: 4 }) }));
    const none = await mount(st({ status: 'resolved', source: 'current', snapshot: snap(fact.not_required, { winnerCount: 1, lot: '' }) }));
    expect(legacy.text()).to.include('desconocido').and.not.include('Morado');
    expect(legacy.text()).to.not.match(/participante \d/);
    expect(none.text()).to.include('sin sorteo').and.not.include('desconocido');
    expect(none.text()).to.not.equal(legacy.text());
  });

  it('clears the previous winner and error on replacement or absence', async () => {
    const m = await mount(resolved('current'));
    expect(m.text()).to.include('Morado');
    await set(m, st({ status: 'loading' }));
    expect(m.text()).to.not.include('Morado').and.not.include('Cesta');
    await set(m, st({ status: 'error', message: 'Fallo anterior' }));
    expect(m.text()).to.include('Fallo anterior');
    await set(m, actionable);
    expect(m.text()).to.not.include('Fallo anterior');
    await set(m, resolved('committed'));
    await set(m, null);
    expect(m.text()).to.not.include('Morado');
    expect(m.draw().disabled && m.resync().disabled).to.equal(true);
  });

  it('renders hostile lot and message text literally', async () => {
    const lot = '<img src=x onerror=alert(1)><b>lote</b>';
    const m = await mount(st({ status: 'recovery', message: '<script>bad()</script>', snapshot: snap(fact.pending, { lot }) }));
    expect(m.el.shadowRoot.querySelector('img, b, script') === null).to.equal(true);
    expect(m.text()).to.include(lot).and.include('<script>bad()</script>');
  });

  it('keeps the DOM bounded for a MAX_SAFE_INTEGER winner count', async () => {
    const count = Number.MAX_SAFE_INTEGER;
    const m = await mount(st({ status: 'actionable', canDraw: true, snapshot: snap(fact.pending, { winnerCount: count }) }));
    expect(m.text()).to.include(String(count));
    expect(m.el.shadowRoot.querySelectorAll('*').length).to.be.below(40);
  });

  it('keeps one persistent polite atomic live region, busy semantics and accessible native buttons', async () => {
    const m = await mount(actionable);
    const live = m.el.shadowRoot.querySelector('[aria-live]');
    expect([live.getAttribute('aria-live'), live.getAttribute('aria-atomic')]).to.deep.equal(['polite', 'true']);
    expect(m.el.shadowRoot.querySelectorAll('[aria-live]')).to.have.length(1);
    for (const b of [m.draw(), m.resync()]) {
      expect(b.tagName).to.equal('BUTTON');
      expect(b.type).to.equal('button');
      expect(b.textContent.trim()).to.not.equal('');
    }
    await expect(m.el).to.be.accessible();
    await set(m, st({ status: 'pending', busy: true, snapshot: snap(fact.pending) }));
    expect(m.el.shadowRoot.querySelector('[aria-live]') === live).to.equal(true);
    expect(m.el.shadowRoot.querySelector('[aria-busy="true"]') !== null).to.equal(true);
    expect(m.el.shadowRoot.querySelector('progress').hasAttribute('value')).to.equal(false);
    expect(m.draw().disabled && m.resync().disabled).to.equal(true);
    await expect(m.el).to.be.accessible();
    await set(m, resolved('current'));
    expect(m.el.shadowRoot.querySelector('[aria-live]') === live).to.equal(true);
    expect(m.el.shadowRoot.querySelector('[aria-busy="true"]') === null).to.equal(true);
    expect(live.textContent).to.include('Morado');
  });

  it('activates draw from a real keyboard Enter on the focused native button', async () => {
    const m = await mount(actionable);
    await sendKeys({ press: 'Tab' });
    expect(m.el.shadowRoot.activeElement === m.draw()).to.equal(true);
    await sendKeys({ press: 'Enter' });
    expect(m.events.map((e) => e.type)).to.deep.equal(['line-lot-draw']);
  });
});
