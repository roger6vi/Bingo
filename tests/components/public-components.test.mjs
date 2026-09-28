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

it('public wiring keeps a committed phase visible beside separate stale feedback', async () => {
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/public.html', import.meta.url))).text(), 'text/html');
  const shell = document.importNode(page.querySelector('bingo-shell'), true);
  document.body.append(shell);
  let receive;
  let unsubscribed = 0;
  let receiveTheme;
  window.publicEvent = { subscribe: (callback) => {
    receive = callback;
    return () => { unsubscribed++; };
  } };
  window.publicTheme = { subscribe: (callback) => {
    receiveTheme = callback;
    return () => { unsubscribed++; };
  } };
  try {
    const entry = new URL('../../src/public-ui.mjs', import.meta.url);
    const response = await fetch(entry);
    expect(response.ok, `public UI fetch: ${response.status}`).to.equal(true);
    const original = await response.text();
    const assetImport = /import sampleVideoUrl from '(?:\.\/)?\.\.\/assets\/sample\.mp4\?url';/;
    expect(original).to.match(assetImport);
    const source = original
      .replace("import './screen.css';", '')
      .replace(assetImport, "const sampleVideoUrl = 'sample.mp4';")
      .replaceAll(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, entry).href}'`)
      .replaceAll(/import '(\.\/[^']+)'/g, (_, relative) => `import '${new URL(relative, entry).href}'`);
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await import(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    const phase = shell.querySelector('#phase-status');
    const status = shell.querySelector('#event-status');
    const error = shell.querySelector('#event-error');
    expect(phase.message).to.equal('Current phase: waiting for event state');
    expect(document.documentElement.dataset.theme).to.equal(undefined);
    receiveTheme('high-contrast');
    expect(document.documentElement.dataset.theme).to.equal('high-contrast');
    for (const invalid of ['body{}', 'https://example.com/x.css', '../generated/x.css', 'dark', null]) receiveTheme(invalid);
    expect(document.documentElement.dataset.theme).to.equal('high-contrast');
    receiveTheme('pixel-classic');
    expect(document.documentElement.dataset.theme).to.equal('pixel-classic');
    receive({ ok: true, snapshot: { calledNumbers: [9], phase: 'line_declared',
      lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    expect(phase.message).to.equal('Current phase: Line declared');
    receive({ ok: true, snapshot: { calledNumbers: [9, 10], phase: 'unknown',
      lastTransitionAt: '2026-01-02T00:00:00.000Z' } });
    expect(phase.message).to.equal('Current phase: Line declared');
    expect(status.message).to.equal('Last confirmed history may be stale.');
    expect(error.hidden).to.equal(false);
    await phase.updateComplete;
    expect(phase.shadowRoot.querySelector('[role="status"]').textContent).to.equal('Current phase: Line declared');
    await expect(phase).to.be.accessible();
    window.dispatchEvent(new Event('pagehide'));
    expect(unsubscribed).to.equal(2);
  } finally {
    shell.remove();
    delete window.publicEvent;
    delete window.publicTheme;
    delete document.documentElement.dataset.theme;
  }
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
