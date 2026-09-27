import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-status.mjs';

const list = (board) => board.shadowRoot.querySelector('ol');
const items = (board) => [...list(board).querySelectorAll('li')];
const values = (board) => items(board).map((item) => Number(item.querySelector('bingo-number').value));

it('board distinguishes waiting, empty and ordered draws without live or focusable descendants', async () => {
  const board = await fixture(html`<bingo-number-board></bingo-number-board>`);
  expect(board.calledNumbers).to.deep.equal([]);
  expect(board.loaded).to.equal(false);
  expect(board.shadowRoot.textContent).to.include('Waiting for draw');
  expect(list(board).getAttribute('aria-label')).to.include('draw order');
  board.loaded = true;
  await board.updateComplete;
  expect(board.shadowRoot.textContent).to.include('No draws yet');
  board.calledNumbers = [90, 3, 1];
  await board.updateComplete;
  expect(values(board)).to.deep.equal([90, 3, 1]);
  expect(items(board).every((item) => item.querySelector('bingo-number').compact)).to.equal(true);
  expect(items(board).at(-1).getAttribute('aria-current')).to.equal('true');
  expect(items(board).slice(0, -1).every((item) => !item.hasAttribute('aria-current'))).to.equal(true);
  board.calledNumbers = [90, 3, 1, 42];
  await board.updateComplete;
  expect(values(board)).to.deep.equal([90, 3, 1, 42]);
  board.calledNumbers = [...board.calledNumbers];
  await board.updateComplete;
  expect(values(board)).to.deep.equal([90, 3, 1, 42]);
  board.calledNumbers = Array.from({ length: 90 }, (_, index) => 90 - index);
  await board.updateComplete;
  expect(values(board)).to.deep.equal(Array.from({ length: 90 }, (_, index) => 90 - index));
  expect(board.shadowRoot.querySelectorAll('[aria-live],button,a[href],input,[tabindex]')).to.have.length(0);
  await expect(board).to.be.accessible();
});

it('panel, number, latest announcer and status respond to properties without duplicate announcements', async () => {
  const panel = await fixture(html`<bingo-panel heading="Calls"><bingo-number></bingo-number></bingo-panel>`);
  const section = panel.shadowRoot.querySelector('section');
  expect(section.getAttribute('aria-labelledby')).to.equal('panel-heading');
  expect(panel.shadowRoot.querySelector('slot').assignedElements()).to.have.length(1);
  panel.heading = 'Draws';
  await panel.updateComplete;
  expect(panel.shadowRoot.querySelector('h2').textContent).to.equal('Draws');
  const number = panel.querySelector('bingo-number');
  expect(number.shadowRoot.textContent).to.include('Waiting for draw');
  number.value = 7;
  await number.updateComplete;
  expect(number.shadowRoot.querySelector('span').textContent).to.equal('7');
  expect(number.shadowRoot.querySelector('output,[aria-live]')).to.equal(null);
  const latest = await fixture(html`<bingo-latest-draw><bingo-number></bingo-number></bingo-latest-draw>`);
  const live = latest.shadowRoot.querySelector('[aria-live]');
  expect(live.getAttribute('aria-live')).to.equal('polite');
  expect(live.getAttribute('aria-atomic')).to.equal('true');
  expect(live.textContent).to.equal('');
  latest.latest = 90;
  await latest.updateComplete;
  expect(live.textContent).to.equal('Latest draw: 90');
  const mutations = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(live, { childList: true, characterData: true, subtree: true });
  latest.latest = 90;
  await latest.updateComplete;
  expect(mutations).to.have.length(0);
  expect(live.textContent).to.equal('Latest draw: 90');
  latest.latest = 3;
  await latest.updateComplete;
  expect(live.textContent).to.equal('Latest draw: 3');
  expect(mutations).to.have.length(1);
  observer.disconnect();
  expect(latest.shadowRoot.querySelectorAll('[aria-live]')).to.have.length(1);
  const status = await fixture(html`<bingo-status></bingo-status>`);
  for (const [tone, role] of [['info', 'status'], ['warning', 'status'], ['error', 'alert']]) {
    status.tone = tone;
    status.message = tone;
    await status.updateComplete;
    expect(status.shadowRoot.querySelector('p').getAttribute('role')).to.equal(role);
    expect(status.shadowRoot.querySelector('p').textContent).to.equal(tone);
  }
  status.tone = 'info';
  status.message = 'Event ready';
  await status.updateComplete;
  expect(status.shadowRoot.querySelector('[role="status"]').textContent).to.equal('Event ready');
  await expect(panel).to.be.accessible();
});

it('uses both generated themes, wraps at narrow widths, and computes reduced motion', async () => {
  const response = await fetch(new URL('../../src/screen.css', import.meta.url));
  expect(response.ok).to.equal(true);
  const screenCss = await response.text();
  const imports = /^@import '\.\/generated\/pixel-classic\.css';\s*@import '\.\/generated\/high-contrast\.css';\s*/;
  expect(screenCss).to.match(imports);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = screenCss.replace(imports, '');
  document.head.append(stylesheet);
  const themeSheets = await Promise.all(['pixel-classic', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  const board = await fixture(html`<bingo-number-board></bingo-number-board>`);
  board.loaded = true;
  board.calledNumbers = [90, 3, 1];
  await board.updateComplete;
  const last = items(board).at(-1);
  const standalone = await fixture(html`<bingo-number .value=${90}></bingo-number>`);
  expect(parseFloat(getComputedStyle(items(board)[0].querySelector('bingo-number').shadowRoot.querySelector('span')).fontSize))
    .to.be.lessThan(parseFloat(getComputedStyle(standalone.shadowRoot.querySelector('span')).fontSize));
  expect(getComputedStyle(last).outlineStyle).to.equal('solid');
  expect(getComputedStyle(items(board)[0]).outlineStyle).to.equal('none');
  try {
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const accent = getComputedStyle(board).getPropertyValue('--bingo-color-accent').trim();
      expect(accent).not.to.equal('');
      const probe = document.createElement('span');
      probe.style.color = accent;
      document.body.append(probe);
      expect(getComputedStyle(last).outlineColor).to.equal(getComputedStyle(probe).color);
      probe.remove();
      await expect(board).to.be.accessible();
    }
    board.style.width = '80px';
    expect(items(board)[1].getBoundingClientRect().top).to.be.greaterThan(items(board)[0].getBoundingClientRect().top);
    board.style.width = '900px';
    expect(items(board)[1].getBoundingClientRect().top).to.equal(items(board)[0].getBoundingClientRect().top);
    const button = document.createElement('button');
    document.body.append(button);
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).to.equal(true);
    expect(getComputedStyle(button).transitionDuration).to.equal('0s');
    button.remove();
  } finally {
    delete document.documentElement.dataset.theme;
    stylesheet.remove();
    themeSheets.forEach((link) => link.remove());
  }
});
