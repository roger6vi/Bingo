import { fixture, html, expect } from '@open-wc/testing';
import { setViewport } from '@web/test-runner-commands';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-tongo-control.mjs';

// Geometry regression for the reported claim-button overflow (UI-A): the claims row paints inside a fixed
// 3-column grid in the operator side rail and BingoButton never wraps its label (`white-space: nowrap`),
// so a long label overflows its own button and overlaps the neighbouring claims. Everything here is real:
// the real screen.css grid and rail, the real Jules theme, the real components, measured on the actual
// rendered shadow button at the 1280×720 operator target.
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

describe('claim button text fit', () => {
  const withScreen = async (check) => {
    await setViewport({ width: 1280, height: 720 });
    document.documentElement.dataset.theme = 'jules';
    const links = await Promise.all(['jules']
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

  it('the reported defect: a declared-length nowrap label overflows the fixed claims column', async () => {
    await withScreen(async () => {
      // Characterization of the mechanism that caps the claim labels at Línea/Bingo: the grid and the
      // nowrap button are unchanged, so the old visible label really did cross its button's border.
      const root = await fixture(claimsFixture('Línea declarada'));
      const fit = textFit(root.querySelector('#claim-line'));
      expect(fit.rendered, 'the long label is painted, not hidden').to.equal(true);
      expect(fit.width, 'the long label is non-empty').to.be.greaterThan(0);
      expect(fit.contained, 'the long label crosses its button').to.equal(false);
    });
  });
});
