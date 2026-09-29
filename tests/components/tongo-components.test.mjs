import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-tongo.mjs';

it('public overlay announces once, covers without removing the board, and honours reduced motion', async () => {
  const host = await fixture(html`<div><ol id="board"><li>7</li></ol><bingo-tongo></bingo-tongo></div>`);
  const tongo = host.querySelector('bingo-tongo');
  const live = () => tongo.shadowRoot.querySelector('[aria-live]');
  expect(live().getAttribute('role')).to.equal('status');
  expect(live().textContent).to.equal('');
  expect(tongo.shadowRoot.querySelector('.card')).to.equal(null);
  tongo.active = true;
  await tongo.updateComplete;
  expect(tongo.hasAttribute('active')).to.equal(true);
  expect(live().textContent).to.include('¡Tongo!');
  expect(tongo.shadowRoot.querySelector('.word').textContent).to.equal('¡Tongo!');
  expect(tongo.shadowRoot.querySelectorAll('[aria-live]')).to.have.length(1);
  expect(getComputedStyle(tongo).pointerEvents).to.equal('none');
  // The runner's browser context requests reduced motion.
  for (const part of ['.scrim', '.card', '.word']) {
    expect(getComputedStyle(tongo.shadowRoot.querySelector(part)).animationName).to.equal('none');
  }
  expect(host.querySelector('#board').textContent).to.equal('7');
  await expect(tongo).to.be.accessible();
  tongo.active = false;
  await tongo.updateComplete;
  expect(tongo.shadowRoot.querySelector('.card')).to.equal(null);
  expect(live().textContent).to.equal('');
});

const THEMES = ['jules', 'light', 'high-contrast'];
const stylesheet = (name) => new Promise((resolve, reject) => {
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet',
    href: new URL(`../../src/generated/${name}.css`, import.meta.url).href, onload: () => resolve(link), onerror: reject });
  document.head.append(link);
});
// Resolves a semantic color token to the value the browser paints.
function paint(element, name) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  element.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

it('public overlay follows each of the three themes through defined semantic tokens only', async () => {
  const links = await Promise.all(THEMES.map(stylesheet));
  const host = await fixture(html`<div><bingo-tongo active></bingo-tongo></div>`);
  const tongo = host.querySelector('bingo-tongo');
  const shadow = tongo.shadowRoot;
  try {
    const colors = new Set();
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const error = paint(host, '--bingo-color-error');
      // Every consumed color resolves in the theme: an undefined token would paint the inherited fallback.
      for (const name of ['--bingo-color-error', '--bingo-color-surface', '--bingo-color-text', '--bingo-color-overlay']) {
        expect(getComputedStyle(host).getPropertyValue(name).trim(), `${theme}: ${name}`).to.not.equal('');
      }
      expect(getComputedStyle(shadow.querySelector('.card')).borderTopColor, theme).to.equal(error);
      expect(getComputedStyle(shadow.querySelector('.word')).color, theme).to.equal(error);
      expect(getComputedStyle(shadow.querySelector('.card')).backgroundColor, theme).to.equal(paint(host, '--bingo-color-surface'));
      expect(getComputedStyle(shadow.querySelector('.note')).color, theme).to.equal(paint(host, '--bingo-color-text'));
      expect(getComputedStyle(tongo).zIndex, theme).to.equal(getComputedStyle(host).getPropertyValue('--bingo-layer-overlay').trim());
      colors.add(`${error}|${getComputedStyle(shadow.querySelector('.card')).backgroundColor}`);
      await expect(tongo, theme).to.be.accessible();
    }
    expect(colors.size).to.equal(THEMES.length);
  } finally {
    delete document.documentElement.dataset.theme;
    links.forEach((link) => link.remove());
  }
});
