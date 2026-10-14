import { fixture, html, expect } from '@open-wc/testing';
import { setViewport } from '@web/test-runner-commands';
import { EVENTS, LONG_EVENT } from '../../.storybook/lib/fixtures.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-event-list.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-tongo-control.mjs';

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
  // All three theme stylesheets are loaded together; each theme re-skins through data-theme, and the
  // font swap is awaited before measuring so the geometry is the theme's real metrics.
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
    try { await check(); } finally {
      screen.remove();
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
});
