import { expect } from '@open-wc/testing';
import { renderGallery, GALLERY_STATES } from '../../src/gallery-view.mjs';
import { THEME_LABELS } from '../../src/theme-controller.mjs';

const stylesheet = (href) => new Promise((resolve, reject) => {
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href, onload: () => resolve(link), onerror: reject });
  document.head.append(link);
});

async function mountGallery() {
  const links = await Promise.all(Object.keys(THEME_LABELS)
    .map((name) => stylesheet(new URL(`../../src/generated/${name}.css`, import.meta.url).href)));
  const screen = document.createElement('style');
  screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  document.head.append(screen);
  const root = document.createElement('main');
  document.body.append(root);
  await renderGallery(root);
  return { root, cleanup: () => { root.remove(); screen.remove(); links.forEach((link) => link.remove()); } };
}

it('renders every registered theme with every required component state', async () => {
  const { root, cleanup } = await mountGallery();
  try {
    expect(GALLERY_STATES).to.deep.equal(['normal', 'disabled', 'pending', 'error', 'stale', 'focus', 'checking', 'celebration']);
    const sections = [...root.querySelectorAll('section[data-theme]')];
    expect(sections.map((section) => section.dataset.theme)).to.deep.equal(Object.keys(THEME_LABELS));
    const canvases = new Set();
    for (const section of sections) {
      expect(section.querySelector('h2').textContent).to.include(THEME_LABELS[section.dataset.theme]);
      const states = new Set([...section.querySelectorAll('[data-state]')].map((specimen) => specimen.dataset.state));
      for (const state of GALLERY_STATES) expect(states.has(state), `${section.dataset.theme}: ${state}`).to.equal(true);
      canvases.add(getComputedStyle(section).backgroundColor);
      await expect(section).to.be.accessible();
    }
    expect(canvases.size).to.equal(sections.length, 'each theme scope paints its own canvas');
  } finally { cleanup(); }
});

it('shows representative sizes and real component states without desktop access', async () => {
  const { root, cleanup } = await mountGallery();
  try {
    const section = root.querySelector('section[data-theme]');
    const pending = section.querySelector('[data-state="pending"] bingo-button');
    expect(pending.disabled).to.equal(true);
    expect(section.querySelector('[data-state="stale"] bingo-status').tone).to.equal('warning');
    expect(section.querySelector('[data-state="error"] bingo-status').shadowRoot.querySelector('[role="alert"]')).not.to.equal(null);
    expect(section.querySelector('[data-state="checking"] bingo-status').message).to.match(/Checking/);
    const numbers = [...section.querySelectorAll('bingo-number')];
    expect(numbers.some((number) => number.compact) && numbers.some((number) => !number.compact && number.value !== null)).to.equal(true);
    expect(section.querySelector('bingo-number[latest]')).not.to.equal(null);
    const board = section.querySelector('[data-state="stale"] bingo-operator-board');
    expect([board.stale, board.calledNumbers.length]).to.deep.equal([true, 4]);
    expect(section.querySelector('[data-state="pending"] bingo-operator-board').pending).to.equal(true);
    expect(section.querySelector('[data-state="error"] bingo-text-field').error).to.match(/\S/);
    expect(section.querySelector('[data-state="pending"] bingo-text-field').pending).to.equal(true);
    expect(section.querySelector('[data-state="disabled"] bingo-select-field').disabled).to.equal(true);
    expect(window.desktop).to.equal(undefined);
  } finally { cleanup(); }
});

it('reports and honours reduced motion in every theme', async () => {
  const { root, cleanup } = await mountGallery();
  try {
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).to.equal(true);
    for (const section of root.querySelectorAll('section[data-theme]')) {
      expect(section.querySelector('[data-motion]').textContent).to.match(/reduced motion/i);
      const button = section.querySelector('[data-state="normal"] bingo-button').button;
      expect(getComputedStyle(button).transitionDuration).to.equal('0s');
    }
  } finally { cleanup(); }
});
