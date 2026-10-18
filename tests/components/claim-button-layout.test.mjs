import { fixture, html, expect } from '@open-wc/testing';
import { setViewport } from '@web/test-runner-commands';
import { EVENTS, LONG_EVENT } from '../../.storybook/lib/fixtures.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-event-list.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-prize-display.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-tongo-control.mjs';
import '../../src/components/bingo-tabs.mjs';

const THEMES = ['jules', 'light', 'high-contrast'];

// Geometry regression for the reported claim-button overflow (UI-A) and for the corrected generic
// wrapping (UI-B): BingoButton wraps long labels (`overflow-wrap: anywhere`) instead of overflowing
// its allocated box, proven here for the fixed claims grid and for a long inactive event name's real
// activation button. Everything is real: the real screen.css grids and rail, real themes, real
// components, measured on the actual rendered shadow buttons at the 1280×720 operator target.
const stylesheet = (href) => new Promise((resolve, reject) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onload = () => resolve(link);
  link.onerror = reject;
  document.head.append(link);
});

// The claims row exactly as operator.html paints it; the line label is what operator-ui renders for it.
const claimsFixture = (lineLabel) => html`
  <div class="bingo-workspace">
    <div class="board-zone"></div>
    <bingo-side-rail class="bingo-rail" label="Controles de la partida">
      <section class="rail-section" aria-labelledby="rail-claims-heading">
        <h2 id="rail-claims-heading" class="rail-heading">Reclamaciones</h2>
        <div class="claim-buttons">
          <bingo-button id="claim-line">${lineLabel}</bingo-button>
          <bingo-button id="claim-bingo">Bingo</bingo-button>
          <bingo-tongo-control></bingo-tongo-control>
          <bingo-button id="claim-tiebreak" class="claim-wide" disabled>Sorteo de empate</bingo-button>
        </div>
      </section>
    </bingo-side-rail>
  </div>`;

// The event list in its real operator context: the events-workspace grid column and a fill panel,
// with the documented long event fixture inactive so its «Activar …» activation button renders.
const eventsFixture = () => html`
  <div class="events-workspace">
    <bingo-panel heading="Eventos" compact fill>
      <bingo-event-list loaded .events=${[{ ...LONG_EVENT, active: false }, ...EVENTS.slice(1)]}></bingo-event-list>
    </bingo-panel>
  </div>`;

// Text bounds as the browser lays them out: a Range over the slotted label returns the painted glyph
// boxes of the text as it renders inside the shadow button, so a box crossing the button's border box is
// the reported overlap. `rendered`/`width` keep the test from passing silently on hidden or empty text.
function textFit(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()];
  const button = element.button.getBoundingClientRect();
  return {
    rendered: rects.length > 0,
    width: range.getBoundingClientRect().width,
    contained: rects.every((rect) => rect.left >= button.left && rect.right <= button.right),
  };
}

// Allocated-box containment: the whole border box of an element (a button that may itself be grown
// by its label) must stay inside the container screen.css actually allocates it, horizontally and —
// unless the container scrolls by design — vertically. Not an auto-sized box: the container is named.
const boxInside = (element, container, vertical = true) => {
  const box = container.getBoundingClientRect();
  expect(box.width, 'allocated container is actually visible').to.be.greaterThan(0);
  const rect = element.getBoundingClientRect();
  return rect.left >= box.left && rect.right <= box.right &&
    (!vertical || (rect.top >= box.top && rect.bottom <= box.bottom));
};

describe('claim and event button text fit', () => {
  // All three theme stylesheets are loaded together; each theme re-skins through data-theme. The
  // project's actual mono face is loaded from the locally installed @fontsource-variable package
  // (served from node_modules, no CDN/network) — screen.css imports it through the bundler, and the
  // stripped @import lines would otherwise leave Jules measuring its ui-monospace fallback.
  const withScreen = async (check) => {
    await setViewport({ width: 1280, height: 720 });
    document.documentElement.dataset.theme = THEMES[0];
    const links = await Promise.all(THEMES
      .map((name) => stylesheet(new URL(`../../src/generated/${name}.css`, import.meta.url).href)));
    // screen.css imports the themes through the bundler; the tests load them as links instead.
    const screen = document.createElement('style');
    screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text())
      .replace(/@import [^;]+;/g, '');
    document.head.append(screen);
    const font = await stylesheet('/node_modules/@fontsource-variable/roboto-mono/wght.css');
    await document.fonts.ready;
    try { await check(); } finally {
      screen.remove();
      font.remove();
      links.forEach((link) => link.remove());
      delete document.documentElement.dataset.theme;
      await setViewport({ width: 800, height: 600 });
    }
  };

  it('every label painted in the claims row fits its button in the real grid at 1280×720', async () => {
    await withScreen(async () => {
      const root = await fixture(claimsFixture('Línea'));
      const rail = root.querySelector('bingo-side-rail').getBoundingClientRect();
      expect(Math.round(rail.width)).to.equal(320, 'the real rail column width at 1280×720');
      for (const element of ['#claim-line', '#claim-bingo', '#claim-tiebreak'].map((id) => root.querySelector(id))) {
        await element.updateComplete;
        const fit = textFit(element);
        expect(fit.rendered, `${element.id} paints a visible label`).to.equal(true);
        expect(fit.width, `${element.id} paints a non-empty label`).to.be.greaterThan(0);
        expect(fit.contained, `${element.id} label stays inside its button`).to.equal(true);
      }
      const tongo = root.querySelector('bingo-tongo-control');
      await tongo.updateComplete;
      const tongoFit = textFit(tongo.shadowRoot.querySelector('bingo-button'));
      expect(tongoFit.rendered, 'tongo paints a visible label').to.equal(true);
      expect(tongoFit.contained, 'tongo label stays inside its button').to.equal(true);
    });
  });

  it('a declared-length label wraps to fit its fixed claims-column button', async () => {
    await withScreen(async () => {
      // Regression for the corrected generic wrapping: the old nowrap label really did cross its
      // button's border (pre-fix RED on record); it must now wrap and stay inside, painted and
      // non-empty — the short committed labels and all claim behavior are unchanged.
      const root = await fixture(claimsFixture('Línea declarada'));
      const fit = textFit(root.querySelector('#claim-line'));
      expect(fit.rendered, 'the long label is painted, not hidden').to.equal(true);
      expect(fit.width, 'the long label is non-empty').to.be.greaterThan(0);
      expect(fit.contained, 'the long label wraps inside its button').to.equal(true);
    });
  });

  it('a long inactive event name wraps inside its real activation button under every theme', async () => {
    await withScreen(async () => {
      // The actual reported defect case: the documented long event name on a real inactive row's
      // activation button. Under the old nowrap rule this button grew past its list row (RED on
      // record); it must now wrap and stay inside the real allocated row, list and panel column,
      // with painted non-empty Range evidence — no font shrinking, no hiding.
      for (const theme of THEMES) {
        document.documentElement.dataset.theme = theme;
        await document.fonts.ready;
        const root = await fixture(eventsFixture());
        const list = root.querySelector('bingo-event-list');
        await list.updateComplete;
        const item = list.shadowRoot.querySelectorAll('li')[0];
        const button = item.querySelector('bingo-button');
        await button.updateComplete;
        const fit = textFit(button);
        expect(fit.rendered, `${theme}: the long event label is painted, not hidden`).to.equal(true);
        expect(fit.width, `${theme}: the long event label is non-empty`).to.be.greaterThan(0);
        expect(fit.contained, `${theme}: the long event label stays inside its button`).to.equal(true);
        expect(boxInside(button, item), `${theme}: activation button stays inside its list row`).to.equal(true);
        expect(boxInside(item, list.shadowRoot.querySelector('ul')), `${theme}: the row stays inside the list`).to.equal(true);
        expect(boxInside(list, root.querySelector('bingo-panel').shadowRoot.querySelector('.body'), false),
          `${theme}: the list stays inside the allocated panel body`).to.equal(true);
      }
    });
  });

  // ── UI-B3 ────────────────────────────────────────────────────────────────────────────────────────
  // The harness above strips screen.css's @import lines, which omitted the @font-face for the
  // project's actual mono family, so Jules geometry was measured with the ui-monospace fallback.
  // The project face is the locally installed @fontsource-variable/roboto-mono package (family
  // 'Roboto Mono Variable', weight range 100–700), served from node_modules — no CDN or network.
  const CALLED = [7, 23, 41, 42, 55, 63, 78, 90];

  // Reachable operator states keep the short «Línea»/«Bingo» labels. Drawing admits only Línea;
  // its pending request or uncertain check locks Bingo. A settled Línea admits Bingo, whose
  // pending request locks Línea. The pending claim keeps focus; committed claims use success
  // while disabled. Recovery names the enabled Línea action only through aria-label.
  const CLAIM_STATES = [
    { name: 'active (drawing game, only Línea available)', line: {}, bingo: { disabled: true } },
    { name: 'line pending (request in flight keeps focus)', line: {}, bingo: { disabled: true } },
    { name: 'bingo pending (request in flight keeps focus)',
      line: { variant: 'success', disabled: true }, bingo: {} },
    { name: 'line declared (settled line admits Bingo)',
      line: { variant: 'success', disabled: true }, bingo: {} },
    { name: 'line declared (other guards lock Bingo)',
      line: { variant: 'success', disabled: true }, bingo: { disabled: true } },
    { name: 'bingo declared (both committed claims are disabled)',
      line: { variant: 'success', disabled: true }, bingo: { variant: 'success', disabled: true } },
    { name: 'guard-disabled (no drawable game)', line: { disabled: true }, bingo: { disabled: true } },
    { name: 'line recovery (uncertain check named via aria-label)',
      line: { ariaLabel: 'Comprobar línea' }, bingo: { disabled: true } },
  ];
  const claimsStateFixture = ({ lineVariant = '', lineDisabled = false, lineAriaLabel = null,
    bingoVariant = '', bingoDisabled = false }) => html`
      <div class="bingo-workspace">
        <div class="board-zone"></div>
        <bingo-side-rail class="bingo-rail" label="Controles de la partida">
          <section class="rail-section" aria-labelledby="rail-claims-heading">
            <h2 id="rail-claims-heading" class="rail-heading">Reclamaciones</h2>
            <div class="claim-buttons">
              <bingo-button id="claim-line" variant=${lineVariant} ?disabled=${lineDisabled}
                ariaLabel=${lineAriaLabel}>Línea</bingo-button>
              <bingo-button id="claim-bingo" variant=${bingoVariant} ?disabled=${bingoDisabled}>Bingo</bingo-button>
              <bingo-tongo-control></bingo-tongo-control>
              <bingo-button id="claim-tiebreak" class="claim-wide" disabled>Sorteo de empate</bingo-button>
            </div>
          </section>
        </bingo-side-rail>
      </div>`;

  // Layout-fragment containment for an element or text node, as in the inventory audit. Range
  // rects measure occupied text fragments, not actual painted ink; hidden or empty fragments fail.
  const glyphsInside = (text, container, vertical = true) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    expect(rects.length, 'text is painted, not hidden or empty').to.be.greaterThan(0);
    const box = container.getBoundingClientRect();
    expect(box.width, 'allocated container is actually visible').to.be.greaterThan(0);
    return rects.every((rect) => rect.left >= box.left && rect.right <= box.right &&
      (!vertical || (rect.top >= box.top && rect.bottom <= box.bottom)));
  };

  it('measures Jules with the project’s locally installed Roboto Mono Variable face, not a fallback', async () => {
    await withScreen(async () => {
      const root = await fixture(claimsFixture('Línea'));
      const line = root.querySelector('#claim-line');
      await line.updateComplete;
      // Loaded-face proof, not FontFaceSet.check: check() is true even when a missing face silently
      // falls back, while load() resolves to the faces actually loaded for the used weight, and an
      // unloaded face keeps status 'unloaded'.
      const loaded = await document.fonts.load('700 1rem "Roboto Mono Variable"', 'Línea Bingo');
      expect(loaded.length, 'the local variable face actually loads (no silent fallback)').to.be.greaterThan(0);
      expect(loaded.every((face) => face.status === 'loaded'), 'every requested project face is loaded').to.equal(true);
      const faces = [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Roboto Mono Variable');
      expect(faces.length, 'the project face is registered in the document FontFaceSet').to.be.greaterThan(0);
      expect(faces.some((face) => face.status === 'loaded'), 'a registered project face is loaded').to.equal(true);
      expect(getComputedStyle(line.button).fontFamily, 'Jules paints its declared mono family, not a fallback')
        .to.include('Roboto Mono Variable');
      const fit = textFit(line);
      expect(fit.rendered, 'the label is painted with the real face').to.equal(true);
      expect(fit.contained, 'the label stays inside its button with the real face').to.equal(true);
    });
  });

  it('claim buttons in every guarded state fit their fixed grid cells under every theme', async () => {
    await withScreen(async () => {
      for (const theme of THEMES) {
        document.documentElement.dataset.theme = theme;
        await document.fonts.ready;
        for (const state of CLAIM_STATES) {
          const root = await fixture(claimsStateFixture({
            lineVariant: state.line.variant ?? '', lineDisabled: Boolean(state.line.disabled),
            lineAriaLabel: state.line.ariaLabel ?? null,
            bingoVariant: state.bingo.variant ?? '', bingoDisabled: Boolean(state.bingo.disabled),
          }));
          const grid = root.querySelector('.claim-buttons');
          for (const id of ['#claim-line', '#claim-bingo']) {
            const element = root.querySelector(id);
            await element.updateComplete;
            const fit = textFit(element);
            expect(fit.rendered, `${theme} ${state.name}: ${id} paints the short committed label`).to.equal(true);
            expect(fit.width, `${theme} ${state.name}: ${id} paints a non-empty label`).to.be.greaterThan(0);
            expect(fit.contained, `${theme} ${state.name}: ${id} label stays inside its button`).to.equal(true);
            expect(boxInside(element, grid), `${theme} ${state.name}: ${id} stays inside the claims grid`).to.equal(true);
          }
          root.remove();
        }
      }
    });
  });

  // Public display below the 900px breakpoint: screen.css collapses .public-layout to one column and
  // the zones stack. Painted glyphs must stay inside what the single column actually allocates —
  // public interface only, real components, real grid, at a viewport below the documented breakpoint.
  const publicResponsiveFixture = () => html`
    <div class="public-layout">
      <div class="public-event">
        <bingo-panel heading="Premios">
          <bingo-prize-display .prizes=${{ line: { amount: 1500, lot: 'Cesta de Navidad del mercado municipal' }, bingo: { amount: 0, lot: '' } }}></bingo-prize-display>
        </bingo-panel>
        <bingo-number .value=${13} latest></bingo-number>
      </div>
      <div class="public-board-zone"><bingo-number-board loaded .calledNumbers=${CALLED}></bingo-number-board></div>
      <div class="public-side">
        <bingo-call-history .calledNumbers=${CALLED}></bingo-call-history>
        <bingo-latest-draw .latest=${13} .loaded=${true}></bingo-latest-draw>
      </div>
    </div>`;

  it('the public display stacks into one column below 900px with every glyph inside its container', async () => {
    await withScreen(async () => {
      await setViewport({ width: 800, height: 1000 });
      const root = await fixture(publicResponsiveFixture());
      for (const element of root.querySelectorAll('*')) if (element.updateComplete) await element.updateComplete;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      // fixture() returns the single top element, which is the layout itself when it has no wrapper.
      const layout = root.classList.contains('public-layout') ? root : root.querySelector('.public-layout');
      const eventColumn = root.querySelector('.public-event');
      const boardZone = root.querySelector('.public-board-zone');
      const sideColumn = root.querySelector('.public-side');
      const width = layout.getBoundingClientRect().width;
      let bottom = -Infinity;
      for (const [name, zone] of [['event column', eventColumn], ['board zone', boardZone], ['side column', sideColumn]]) {
        const box = zone.getBoundingClientRect();
        expect(box.width, `${name} is visible`).to.be.greaterThan(0);
        expect(Math.abs(box.width - width) < 1.5, `${name} fills the one-column layout`).to.equal(true);
        expect(box.top >= bottom, `${name} stacks below the previous zone`).to.equal(true);
        bottom = box.bottom;
      }
      // Glyphs against the actually allocated containers, public interface only.
      for (const text of root.querySelector('bingo-prize-display').shadowRoot.querySelectorAll('dt, dd'))
        expect(glyphsInside(text, eventColumn), 'prize text stays inside the event column').to.equal(true);
      const ball = root.querySelector('.public-event bingo-number');
      expect(glyphsInside(ball.shadowRoot.querySelector('span'), eventColumn, false),
        'the latest ball stays inside the event column').to.equal(true);
      const cells = root.querySelector('bingo-number-board').shadowRoot.querySelectorAll('ol > li');
      expect(cells.length, 'the fixed 1–90 public board').to.equal(90);
      for (const cell of cells) {
        const number = [...cell.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        expect(glyphsInside(number[0], cell), `board cell ${cell.dataset.number} fits`).to.equal(true);
        const badge = cell.querySelector('.badge');
        if (badge) expect(glyphsInside(badge, cell), `board cell ${cell.dataset.number} badge fits`).to.equal(true);
      }
      const history = root.querySelector('bingo-call-history');
      for (const chipEl of history.shadowRoot.querySelectorAll('.chip'))
        expect(glyphsInside(chipEl, sideColumn, false), 'history chip stays inside the side column').to.equal(true);
    });
  });

  // The real operator starts on the Events tab: the Bingo workspace lives inside a hidden
  // bingo-tab-panel (display: none) and paints nothing until the operator opens the Bingo tab. The
  // inventory audit measured the claims rail outside this tab-panel context; this closes that gap
  // with the actual collapsed→expanded transition through the real tabs component.
  const collapsedFixture = () => html`
    <bingo-app-shell class="operator-app">
      <header slot="header" class="app-header">
        <div class="app-brand"><span class="app-mark" aria-hidden="true">90</span><h1>Consola del operador</h1></div>
        <bingo-tabs class="app-tabs" label="Espacio de trabajo">
          <button type="button" role="tab" id="tab-events" aria-controls="panel-events" aria-selected="true">Eventos</button>
          <button type="button" role="tab" id="tab-settings" aria-controls="panel-settings" aria-selected="false">Configuración</button>
          <button type="button" role="tab" id="tab-bingo" aria-controls="panel-bingo" aria-selected="false">Bingo</button>
        </bingo-tabs>
      </header>
      <main class="app-main">
        <bingo-tab-panel id="panel-events" aria-labelledby="tab-events"><div class="events-workspace"></div></bingo-tab-panel>
        <bingo-tab-panel id="panel-settings" aria-labelledby="tab-settings" hidden></bingo-tab-panel>
        <bingo-tab-panel id="panel-bingo" aria-labelledby="tab-bingo" hidden>
          <div class="bingo-workspace">
            <div class="board-zone"></div>
            <bingo-side-rail class="bingo-rail" label="Controles de la partida">
              <section class="rail-section" aria-labelledby="rail-claims-heading">
                <h2 id="rail-claims-heading" class="rail-heading">Reclamaciones</h2>
                <div class="claim-buttons">
                  <bingo-button id="claim-line">Línea</bingo-button>
                  <bingo-button id="claim-bingo">Bingo</bingo-button>
                  <bingo-tongo-control></bingo-tongo-control>
                  <bingo-button id="claim-tiebreak" class="claim-wide" disabled>Sorteo de empate</bingo-button>
                </div>
              </section>
            </bingo-side-rail>
          </div>
        </bingo-tab-panel>
      </main>
    </bingo-app-shell>`;

  it('the claims rail fits the real collapsed Bingo workspace once it expands', async () => {
    await withScreen(async () => {
      const root = await fixture(collapsedFixture());
      const tabs = root.querySelector('bingo-tabs');
      const panel = root.querySelector('#panel-bingo');
      const workspace = panel.querySelector('.bingo-workspace');
      expect(panel.hidden, 'the Bingo workspace starts collapsed, as the real operator does').to.equal(true);
      expect(workspace.getBoundingClientRect().width, 'the collapsed workspace paints nothing').to.equal(0);
      // The real switch path: BingoTabs.request honours canLeave exactly like operator-ui's veto hook.
      tabs.request('tab-bingo');
      await tabs.updateComplete;
      await panel.updateComplete;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(panel.hidden, 'the workspace expands through the real tab path').to.equal(false);
      const rail = root.querySelector('bingo-side-rail');
      expect(Math.round(rail.getBoundingClientRect().width), 'the real rail column width after expansion').to.equal(320);
      for (const id of ['#claim-line', '#claim-bingo', '#claim-tiebreak']) {
        const element = root.querySelector(id);
        await element.updateComplete;
        const fit = textFit(element);
        expect(fit.rendered, `${id} paints a visible label after expansion`).to.equal(true);
        expect(fit.contained, `${id} label stays inside its button after expansion`).to.equal(true);
      }
      const tongo = root.querySelector('bingo-tongo-control');
      await tongo.updateComplete;
      const tongoFit = textFit(tongo.shadowRoot.querySelector('bingo-button'));
      expect(tongoFit.rendered, 'tongo paints a visible label after expansion').to.equal(true);
      expect(tongoFit.contained, 'tongo label stays inside its button after expansion').to.equal(true);
    });
  });
});
