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

it('public overlay follows the active theme through semantic tokens only', async () => {
  const host = await fixture(html`<div style="--bingo-color-accent: rgb(1, 2, 3); --bingo-color-danger: rgb(4, 5, 6)">
    <bingo-tongo active></bingo-tongo></div>`);
  const shadow = host.querySelector('bingo-tongo').shadowRoot;
  expect(getComputedStyle(shadow.querySelector('.card')).borderTopColor).to.equal('rgb(1, 2, 3)');
  expect(getComputedStyle(shadow.querySelector('.word')).color).to.equal('rgb(4, 5, 6)');
});
