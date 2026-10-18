// Inventory-wide text-fit audit (UI-B, S2): every registered component's visible text is measured as
// painted glyph boxes (Range.getClientRects — width AND vertical extent) against explicitly allocated
// containers in real page contexts from screen.css, under all three themes at the 1280×720 target.
// Every check demands painted, non-empty glyphs; aria-only hidden content is never measured; native
// closed-shadow controls use public geometry and label association; intentional scroll/ellipsis
// surfaces are asserted as such, not treated as clipped text.
import { fixture, html, expect } from '@open-wc/testing';
import { setViewport } from '@web/test-runner-commands';
import { EVENTS, LONG_EVENT } from '../../.storybook/lib/fixtures.mjs';
import '../../src/components/bingo-app-shell.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-date-field.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-event-list.mjs';
import '../../src/components/bingo-field.mjs';
import '../../src/components/bingo-form-actions.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-line-celebration.mjs';
import '../../src/components/bingo-line-lot.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-operator-board.mjs';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-prize-display.mjs';
import '../../src/components/bingo-select-field.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-tabs.mjs';
import '../../src/components/bingo-text-field.mjs';
import '../../src/components/bingo-tongo.mjs';
import '../../src/components/bingo-tongo-control.mjs';

const TOLERANCE = 0.75;
const THEMES = ['jules', 'light', 'high-contrast'];
const CALLED = [7, 23, 41, 42, 55, 63, 78, 90];
// Documented stories only cover a long *active* name (a marker, no button): a story gap this audit closes.
const LONG_INACTIVE = { ...LONG_EVENT, id: 'evt-long-inactive', active: false };
const LOT_RECOVERY = { status: 'recovery', source: null, winner: null, busy: false, canDraw: false, snapshot: null, message: 'Estado incierto.' };

const stylesheet = (href) => new Promise((resolve, reject) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onload = () => resolve(link);
  link.onerror = reject;
  document.head.append(link);
});

// One theme's generated stylesheet plus screen.css (bundler imports stripped): the real paint path.
async function loadTheme(theme) {
  await setViewport({ width: 1280, height: 720 });
  document.documentElement.dataset.theme = theme;
  const link = await stylesheet(new URL(`../../src/generated/${theme}.css`, import.meta.url).href);
  const screen = document.createElement('style');
  screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text())
    .replace(/@import [^;]+;/g, '');
  document.head.append(screen);
  await document.fonts.ready;
  return async () => {
    screen.remove();
    link.remove();
    delete document.documentElement.dataset.theme;
    await setViewport({ width: 800, height: 600 });
  };
}

// Glyph boxes exactly as the browser paints them: a box crossing the allocated container is a real
// overlap; hidden or empty text can never pass silently. Accepts elements or bare text nodes.
function glyphs(text) {
  const range = document.createRange();
  range.selectNodeContents(text);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  return { painted: rects.length > 0, width: range.getBoundingClientRect().width, rects };
}

const inside = (rect, box, vertical) =>
  rect.left >= box.left - TOLERANCE && rect.right <= box.right + TOLERANCE &&
  (!vertical || (rect.top >= box.top - TOLERANCE && rect.bottom <= box.bottom + TOLERANCE));

const boxInside = (element, container, vertical = true) => {
  const box = container.getBoundingClientRect();
  return inside(element.getBoundingClientRect(), box, vertical);
};

// One audited surface: the painted glyphs of every given text stay inside one explicitly allocated
// container — never an auto-sized box that grows with the text it would be measured against.
function fits(name, texts, container, { vertical = true } = {}) {
  const box = container.getBoundingClientRect();
  expect(box.width, `${name}: allocated container is actually visible`).to.be.greaterThan(0);
  expect(box.height, `${name}: allocated container has a real vertical extent`).to.be.greaterThan(0);
  for (const text of texts) {
    const g = glyphs(text);
    expect(g.painted, `${name}: paints visible text (nothing hidden or clipped-only passes)`).to.equal(true);
    expect(g.width, `${name}: paints a non-empty label`).to.be.greaterThan(0);
    expect(g.rects.every((rect) => inside(rect, box, vertical)),
      `${name}: glyphs stay inside the allocated container (${vertical ? 'width and height' : 'width; it scrolls vertically by design'})`).to.equal(true);
  }
}

// Native closed-shadow controls: public visible geometry plus label association and a real public
// value — never an invented text Range over internals the page cannot see.
function expectUsableControl(control, name) {
  const box = control.getBoundingClientRect();
  expect(box.width, `${name}: public visible width`).to.be.greaterThan(0);
  expect(box.height, `${name}: public visible height`).to.be.greaterThan(0);
  expect(control.labels.length, `${name}: native control is labelled`).to.be.greaterThan(0);
}

// Documented single-line ellipsis surface (the active-event banner): the truncation treatment must
// be present, so a long banner can never overflow silently.
function expectEllipsis(element, name) {
  const style = getComputedStyle(element);
  expect(style.textOverflow, `${name}: truncates with an ellipsis affordance`).to.equal('ellipsis');
  expect(style.whiteSpace, `${name}: truncation is single-line by design`).to.equal('nowrap');
  expect(style.overflow, `${name}: truncation actually clips`).to.equal('hidden');
}

// Aria-only content keeps a 1×1 clipped box; assert that shape instead of measuring it as text.
function expectAriaOnly(element, name) {
  const box = element.getBoundingClientRect();
  expect(box.width, `${name}: aria-only content is visually hidden`).to.be.at.most(1.5);
  expect(box.height, `${name}: aria-only content is visually hidden`).to.be.at.most(1.5);
}

const settle = async (root) => {
  for (const element of root.querySelectorAll('*')) if (element.updateComplete) await element.updateComplete;
  await new Promise((resolve) => requestAnimationFrame(resolve));
};

// Shared patterns: label in own box plus allocation, and the 90 fixed board cells (number text node
// plus latest badge when shown).
const fitsButton = (name, button, container) => {
  fits(`${name} label`, [button], button);
  fits(`${name} allocation`, [button], container);
};
const fitCells = (cells, label) => {
  expect(cells.length, `the fixed 1–90 grid (${label})`).to.equal(90);
  for (const cell of cells) {
    const number = [...cell.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    fits(`${label} cell ${cell.dataset?.number ?? cell.textContent.trim()}`, number, cell);
    const badge = cell.querySelector('.badge');
    if (badge) fits(`${label} badge ${cell.dataset.number}`, [badge], cell);
  }
};

// Operator Bingo tab: the fixed board zone and the 320px side rail with draw, claim, recovery and
// lot controls, exactly as operator.html paints them at 1280×720.
const railFixture = () => html`
  <div class="bingo-workspace">
    <bingo-panel class="board-zone" heading="Tablero 1–90" compact fill>
      <bingo-operator-board id="board" loaded .calledNumbers=${CALLED}></bingo-operator-board>
    </bingo-panel>
    <bingo-side-rail class="bingo-rail" label="Controles de la partida">
      <section class="rail-section" aria-labelledby="rail-latest-heading">
        <h2 id="rail-latest-heading" class="rail-heading">Última bola</h2>
        <bingo-operator-summary id="summary" .latest=${13} .count=${4} .remaining=${86}></bingo-operator-summary>
        <bingo-call-history id="called" class="last-calls" limit="8" .calledNumbers=${CALLED}></bingo-call-history>
      </section>
      <section class="rail-section" aria-labelledby="rail-draw-heading">
        <h2 id="rail-draw-heading" class="rail-heading">Sorteo</h2>
        <bingo-draw-controls id="draw-manual" .manualDisabled=${false}></bingo-draw-controls>
        <bingo-draw-controls id="draw-digital" mode="digital" .digitalDisabled=${false}></bingo-draw-controls>
      </section>
      <section class="rail-section" aria-labelledby="rail-claims-heading">
        <h2 id="rail-claims-heading" class="rail-heading">Reclamaciones</h2>
        <div class="claim-buttons">
          <bingo-button id="claim-line" variant="success" disabled>Línea</bingo-button>
          <bingo-button id="claim-bingo">Bingo</bingo-button>
          <bingo-tongo-control id="tongo"></bingo-tongo-control>
          <bingo-button id="claim-tiebreak" class="claim-wide" disabled>Sorteo de empate</bingo-button>
        </div>
        <div id="line-actions">
          <bingo-button id="line-retry">Reintentar celebración</bingo-button>
          <bingo-button id="line-repeat">Repetir celebración completa</bingo-button>
          <bingo-button id="line-recover">Cancelar comprobación de línea</bingo-button>
          <bingo-button id="bingo-retry">Reintentar celebración</bingo-button>
          <bingo-button id="bingo-repeat">Repetir celebración completa</bingo-button>
          <bingo-button id="bingo-recover">Cancelar comprobación de bingo</bingo-button>
          <bingo-button id="bingo-refresh">Reintentar lectura del evento</bingo-button>
        </div>
        <bingo-line-lot id="line-lot" label="Lote de la línea" .state=${LOT_RECOVERY}></bingo-line-lot>
      </section>
    </bingo-side-rail>
  </div>`;
// Operator header row and the events workspace: tabs, banner, event list with a long inactive name,
// and the whole event form (text/date/select fields, status, action row).
const mainFixture = () => html`
  <bingo-app-shell class="operator-app">
    <header slot="header" class="app-header">
      <div class="app-brand"><span class="app-mark" aria-hidden="true">90</span><h1>Consola del operador</h1></div>
      <bingo-tabs class="app-tabs" label="Espacio de trabajo">
        <button type="button" role="tab" aria-controls="p1" aria-selected="true">Eventos</button>
        <button type="button" role="tab" aria-controls="p1" aria-selected="false">Configuración</button>
        <button type="button" role="tab" aria-controls="p1" aria-selected="false">Bingo</button>
      </bingo-tabs>
      <bingo-status id="banner" class="active-event-banner" message="Bingo solidario de primavera — Casal del barrio"></bingo-status>
    </header>
    <main class="app-main">
      <div class="events-workspace">
        <bingo-panel heading="Eventos" compact fill>
          <bingo-button slot="actions">Recargar eventos</bingo-button>
          <div class="panel-status">
            <bingo-status message="El estado de la línea pertenece a otro evento. Pulsa «Recargar eventos» para leerlo de nuevo."></bingo-status>
          </div>
          <bingo-event-list id="events" loaded .events=${[LONG_INACTIVE, ...EVENTS.slice(1)]}></bingo-event-list>
        </bingo-panel>
        <bingo-panel heading="Nuevo evento" compact fill>
          <div class="event-form">
            <bingo-text-field label="Nombre" required hint="Hasta 120 caracteres." value="Bingo solidario de primavera"></bingo-text-field>
            <bingo-text-field label="Lugar" required .error=${'No se pudo guardar el evento. Revisa los datos e inténtalo de nuevo.'}></bingo-text-field>
            <bingo-date-field label="Fecha" required hint="Día de la partida."></bingo-date-field>
            <bingo-select-field label="Tema para ambas pantallas"><option selected>Jules</option><option>Light</option></bingo-select-field>
            <bingo-form-actions>
              <bingo-status slot="status" message="Guardando cambios del evento…"></bingo-status>
              <bingo-button>Cancelar</bingo-button>
              <bingo-button slot="primary" variant="primary">Guardar evento</bingo-button>
            </bingo-form-actions>
          </div>
        </bingo-panel>
      </div>
    </main>
  </bingo-app-shell>`;
// Public display: prizes and latest ball beside the fixed 1–90 board, the overlays, a full history
// list and a confirmation dialog with long Spanish text.
const publicFixture = () => html`
  <div id="public-stage">
  <div class="public-layout">
    <div class="public-event">
      <bingo-panel heading="Premios">
        <bingo-prize-display .prizes=${{ line: { amount: 1500, lot: 'Cesta de Navidad del mercado municipal' }, bingo: { amount: 0, lot: '' } }}></bingo-prize-display>
      </bingo-panel>
      <bingo-number .value=${13} latest></bingo-number>
    </div>
    <div class="public-board-zone"><bingo-number-board id="public-board" loaded .calledNumbers=${CALLED}></bingo-number-board></div>
    <div class="public-side">
      <bingo-call-history id="public-history" .calledNumbers=${CALLED}></bingo-call-history>
      <bingo-latest-draw .latest=${13} .loaded=${true}></bingo-latest-draw>
    </div>
  </div>
  <bingo-line-celebration active facts="Línea ganada por el cartón 4 con la bola 42. Premio: 1.500 euros y la cesta de Navidad del mercado municipal."></bingo-line-celebration>
  <bingo-tongo active></bingo-tongo>
  <bingo-dialog id="dialog" label="Confirmar reinicio" .actions=${[{ action: 'cancel', label: 'Cancelar' }, { action: 'confirm', label: 'Confirmar reinicio completo' }]}>
    <p>Se restablecerá la partida a la última bola confirmada. Esta acción no se puede deshacer.</p>
  </bingo-dialog>
  </div>`;

describe('component text-fit inventory', () => {
  let cleanup; // one theme stylesheet + screen.css per test
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = undefined; });
  for (const theme of THEMES) {
    it(`operator board and side rail fit under ${theme} at 1280×720`, async () => {
      cleanup = await loadTheme(theme);
      const root = await fixture(railFixture()); await settle(root);
      const section = (id) => root.querySelector(`[aria-labelledby="${id}"]`);
      expect(Math.round(root.querySelector('bingo-side-rail').getBoundingClientRect().width)).to.equal(320, 'real rail width');
      // Operator board: legend and status fit; each of the 90 fixed cells holds its number (bare
      // text node) and its latest badge; the board never scrolls.
      const board = root.querySelector('#board');
      const boardPanel = root.querySelector('.board-zone');
      const boardBody = boardPanel.shadowRoot.querySelector('.body');
      fits('board legend', [...board.shadowRoot.querySelectorAll('.legend li, .state')], boardBody);
      fitCells([...board.shadowRoot.querySelectorAll('.cell')], 'operator board');
      // Latest-call section: summary outputs and chip; the strip hides overflow by design, so its
      // chips are measured against their own boxes, horizontally only.
      const latest = section('rail-latest-heading');
      const summary = root.querySelector('#summary');
      fits('summary outputs', [...summary.shadowRoot.querySelectorAll('output')], latest);
      const chip = summary.shadowRoot.querySelector('bingo-number');
      fits('summary latest ball', [chip.shadowRoot.querySelector('span')], chip);
      expect(boxInside(chip, latest, false), 'summary latest ball stays inside the rail section').to.equal(true);
      const strip = root.querySelector('#called');
      expect(getComputedStyle(strip.shadowRoot.querySelector('ol')).overflowX, 'history strip hides overflow by design').to.equal('hidden');
      fits('history strip chips', [...strip.shadowRoot.querySelectorAll('.chip')], strip, { vertical: false });
      for (const chipEl of strip.shadowRoot.querySelectorAll('.chip')) fits('strip chip digits', [chipEl], chipEl);
      // Draw controls, both modes, inside the real rail width.
      const drawSection = section('rail-draw-heading');
      const manual = root.querySelector('#draw-manual');
      fits('draw mode labels', [...manual.shadowRoot.querySelectorAll('.modes label')], manual);
      fits('draw field label', [manual.shadowRoot.querySelector('label[for="manual-number"]')], drawSection);
      fitsButton('«Cantar número»', manual.shadowRoot.querySelector('#draw-manual'), drawSection);
      expectUsableControl(manual.manualInput, 'manual number input');
      const digital = root.querySelector('#draw-digital');
      fits('digital draw and reload buttons', [...digital.shadowRoot.querySelectorAll('#draw-digital, #reload-event')], drawSection);
      // Claims row (short committed labels, success/default/disabled forms) and the Tongo trigger.
      const claims = section('rail-claims-heading');
      const claimGrid = root.querySelector('.claim-buttons');
      for (const id of ['claim-line', 'claim-bingo', 'claim-tiebreak']) fitsButton(id, root.querySelector(`#${id}`), claimGrid);
      const tongo = root.querySelector('#tongo');
      fitsButton('tongo trigger', tongo.shadowRoot.querySelector('bingo-button'), claimGrid);
      expectAriaOnly(tongo.shadowRoot.querySelector('p'), 'tongo help text');
      // The long operator recovery actions in their real unstyled rail row.
      for (const id of ['line-retry', 'line-repeat', 'line-recover', 'bingo-retry', 'bingo-repeat', 'bingo-recover', 'bingo-refresh'])
        fitsButton(id, root.querySelector(`#${id}`), claims);
      // Line lot panel with its recovery message and actions, inside the rail.
      const lot = root.querySelector('#line-lot');
      fits('line-lot heading and status', [...lot.shadowRoot.querySelectorAll('.lot-heading, [role="status"] p')], claims);
      fits('line-lot actions', [...lot.shadowRoot.querySelectorAll('button')], claims);
    });

    it(`operator header and events workspace fit under ${theme} at 1280×720`, async () => {
      cleanup = await loadTheme(theme);
      const root = await fixture(mainFixture()); await settle(root);
      const shell = root; // fixture() returns the single top element, the app shell itself.
      const header = root.querySelector('header.app-header');
      expect(boxInside(header, shell), 'header row stays inside the app shell').to.equal(true);
      // Brand, tabs and banner: each tab label inside its own (nowrap by design) tab and every tab
      // inside the header; the banner truncates with the documented ellipsis treatment.
      fits('brand heading', [header.querySelector('.app-brand h1')], header);
      const tabs = root.querySelector('bingo-tabs');
      for (const tab of tabs.querySelectorAll('[role="tab"]')) {
        fits(`tab «${tab.textContent.trim()}» label`, [tab], tab);
        expect(boxInside(tab, header), `tab «${tab.textContent.trim()}» stays inside the header`).to.equal(true);
      }
      const banner = root.querySelector('#banner');
      expectEllipsis(banner.shadowRoot.querySelector('p'), 'active event banner');
      expect(boxInside(banner, header, false), 'banner stays inside the header row').to.equal(true);
      // Events panel: heading, actions button, wrapped status message and the list inside the
      // scrolling fill body (vertical scrolling is the panel's design; width must fit).
      const panels = root.querySelectorAll('.events-workspace > bingo-panel');
      const eventsPanel = panels[0];
      const eventsBody = eventsPanel.shadowRoot.querySelector('.body');
      fits('events panel heading', [eventsPanel.shadowRoot.querySelector('h2')], eventsPanel.shadowRoot.querySelector('header'));
      const reload = eventsPanel.querySelector('[slot="actions"]');
      fits('panel actions button', [reload], eventsPanel.shadowRoot.querySelector('header'));
      const status = eventsPanel.querySelector('.panel-status bingo-status');
      fits('events status message', [status.shadowRoot.querySelector('p')], eventsBody);
      const list = root.querySelector('#events');
      expect(boxInside(list, eventsBody, false), 'event list stays inside the scrolling panel body').to.equal(true);
      const longItem = list.shadowRoot.querySelectorAll('li')[0];
      fits('long event name and meta', [longItem.querySelector('.name'), longItem.querySelector('.meta')], longItem);
      fitsButton('long event activation', longItem.querySelector('bingo-button'), longItem);
      const shortItem = list.shadowRoot.querySelectorAll('li')[1];
      fits('regular event rows', [shortItem.querySelector('.name'), shortItem.querySelector('.meta')], shortItem);
      // Form fields (the abstract bingo-field base is covered through its three subclasses):
      // label/hint/error inside the form column; native controls by public geometry, association
      // and value; the date field's closed internals are never measured.
      const form = root.querySelector('.event-form');
      for (const field of form.querySelectorAll('bingo-text-field, bingo-date-field, bingo-select-field')) {
        const shadow = field.shadowRoot;
        const texts = [shadow.querySelector('.label-row'), shadow.querySelector('.hint')].filter(Boolean);
        fits(`${field.tagName.toLowerCase()} label and hint`, texts, field);
      }
      const errored = form.querySelectorAll('bingo-text-field')[1];
      fits('field error message', [errored.shadowRoot.querySelector('.error')], errored);
      expectUsableControl(form.querySelector('bingo-text-field').shadowRoot.querySelector('input'), 'text field input');
      expectUsableControl(form.querySelector('bingo-date-field').shadowRoot.querySelector('input'), 'date field input');
      const select = form.querySelector('bingo-select-field');
      const selectControl = select.shadowRoot.querySelector('select');
      expectUsableControl(selectControl, 'select field control');
      expect(selectControl.value, 'select exposes its selected value publicly').to.equal('Jules');
      // Action row: status and both button variants inside the wrapping flex row.
      const actions = root.querySelector('bingo-form-actions');
      fits('form actions status', [actions.querySelector('[slot="status"]').shadowRoot.querySelector('p')], actions);
      fits('form action buttons', [...actions.querySelectorAll('bingo-button')], actions);
    });

    it(`public display, overlays and dialog fit under ${theme} at 1280×720`, async () => {
      cleanup = await loadTheme(theme);
      const root = await fixture(publicFixture()); await settle(root);
      const q = (selector) => root.querySelector(selector);
      const eventColumn = q('.public-event');
      const sideColumn = q('.public-side');
      // Prizes and the latest ball inside their column.
      const prizes = q('bingo-prize-display');
      fits('prize labels and lots', [...prizes.shadowRoot.querySelectorAll('dt, dd')], eventColumn);
      const ball = q('bingo-number');
      fits('latest ball glyphs', [ball.shadowRoot.querySelector('span')], ball);
      expect(boxInside(ball, eventColumn, false), 'latest ball stays inside its column').to.equal(true);
      // Public board: the waiting note is aria-only; each of the 90 cells holds its number text node
      // (the called-state note spans are visually hidden and never measured).
      expectAriaOnly(q('#public-board').shadowRoot.querySelector('p.note'), 'public board note');
      fitCells([...q('#public-board').shadowRoot.querySelectorAll('ol > li')], 'public board');
      // Full history list (wraps by design, no hidden overflow) and the aria-only announcer.
      const history = q('#public-history');
      expect(getComputedStyle(history.shadowRoot.querySelector('ol')).flexWrap, 'full history wraps by design').to.equal('wrap');
      fits('history heading', [history.shadowRoot.querySelector('h3')], sideColumn);
      for (const chipEl of history.shadowRoot.querySelectorAll('.chip')) fits('history chip digits', [chipEl], chipEl);
      expectAriaOnly(q('bingo-latest-draw').shadowRoot.querySelector('.announcement'), 'latest draw announcement');
      // Overlays: card content inside the card, card inside the fixed viewport overlay.
      const celebration = q('bingo-line-celebration');
      const celebrationCard = celebration.shadowRoot.querySelector('.card');
      fits('celebration word and facts', [...celebration.shadowRoot.querySelectorAll('.word, .facts')], celebrationCard);
      expect(boxInside(celebrationCard, celebration), 'celebration card stays in the viewport').to.equal(true);
      const tongo = q('bingo-tongo');
      const tongoCard = tongo.shadowRoot.querySelector('.card');
      fits('tongo word and note', [...tongo.shadowRoot.querySelectorAll('.word, .note')], tongoCard);
      expect(boxInside(tongoCard, tongo), 'tongo card stays in the viewport').to.equal(true);
      // Dialog: heading, slotted body and both action labels inside the modal card.
      const dialog = q('#dialog');
      await dialog.show();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const card = dialog.shadowRoot.querySelector('dialog');
      fits('dialog heading and body', [card.querySelector('h2'), dialog.querySelector('p')], card);
      fits('dialog action buttons', [...card.querySelectorAll('.actions bingo-button')], card);
    });
  }
});
