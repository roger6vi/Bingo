import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import '../../src/components/bingo-tongo.mjs';
import '../../src/components/bingo-tongo-control.mjs';
import { createTongoController } from '../../src/tongo.mjs';

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

it('operator control dispatches one intent only when enabled and shows private progress and errors', async () => {
  const control = await fixture(html`<bingo-tongo-control></bingo-tongo-control>`);
  let intents = 0;
  control.addEventListener('tongo-play', () => intents++);
  expect(control.button.disabled).to.equal(true);
  control.button.click();
  expect(intents).to.equal(0);
  control.disabled = false;
  await control.updateComplete;
  await control.shadowRoot.querySelector('bingo-button').updateComplete;
  setTimeout(() => control.button.click());
  await oneEvent(control, 'tongo-play');
  expect(intents).to.equal(1);
  control.progress = 0.5;
  await control.updateComplete;
  await control.shadowRoot.querySelector('bingo-button').updateComplete;
  expect(control.button.disabled).to.equal(true);
  control.play();
  expect(intents).to.equal(1);
  const progress = control.shadowRoot.querySelector('progress');
  expect(progress.value).to.equal(50);
  expect(control.shadowRoot.querySelector('label[for="tongo-progress"]').textContent).to.include('Tongo');
  await expect(control).to.be.accessible();
  control.progress = null;
  control.error = 'Open the public window, then try Tongo again.';
  await control.updateComplete;
  expect(control.shadowRoot.querySelector('progress')).to.equal(null);
  expect(control.shadowRoot.querySelector('[role="alert"]').textContent).to.include('public window');
});

it('operator playback runs to completion on the default browser clock', async () => {
  const renders = [];
  const controller = createTongoController({ playTongo: async () => ({ ok: true,
    presentation: { kind: 'tongo', id: 1, durationMs: 500 } }) }, { render: (state) => renders.push(state) });
  await controller.play();
  expect(renders.at(-1).busy).to.equal(true);
  expect(renders.at(-1).progress).to.be.within(0, 0.2);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(renders.at(-1)).to.deep.equal({ busy: false, pending: false, progress: null, error: null });
  expect(renders.some(({ progress }) => progress > 0 && progress < 1)).to.equal(true);
});
