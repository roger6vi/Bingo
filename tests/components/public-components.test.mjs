import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-prize-display.mjs';
import { setViewport } from '@web/test-runner-commands';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-status.mjs';

const items = (board) => [...board.shadowRoot.querySelectorAll('ol > li')];
const states = (board) => items(board).map((item) => item.dataset.state);

it('board is a fixed passive 1\u201390 grid whose cells only change state', async () => {
  const board = await fixture(html`<bingo-number-board></bingo-number-board>`);
  expect(board.loaded).to.equal(false);
  expect(board.shadowRoot.textContent).to.include('Waiting for draw');
  expect(items(board).map((item) => parseInt(item.textContent, 10))).to.deep.equal(Array.from({ length: 90 }, (_, index) => index + 1));
  expect(states(board).every((state) => state === 'uncalled')).to.equal(true);
  board.loaded = true;
  await board.updateComplete;
  expect(board.shadowRoot.textContent).to.include('No draws yet');
  board.style.width = '900px';
  const place = () => items(board).map((item) => { const { left, top } = item.getBoundingClientRect(); return [left, top]; });
  const fixed = place();
  expect(fixed[0][1]).to.equal(fixed[9][1]);
  expect(fixed[10][1]).to.be.greaterThan(fixed[0][1]);
  expect(fixed[10][0]).to.equal(fixed[0][0]);
  board.calledNumbers = [90, 3, 1];
  await board.updateComplete;
  expect(place()).to.deep.equal(fixed);
  expect(items(board).map((item) => item.dataset.state).filter((state) => state !== 'uncalled')).to.deep.equal(['latest', 'called', 'called']);
  expect([items(board)[0], items(board)[2], items(board)[89]].map((item) => item.dataset.state)).to.deep.equal(['latest', 'called', 'called']);
  expect(items(board).filter((item) => item.hasAttribute('aria-current'))).to.deep.equal([items(board)[0]]);
  board.calledNumbers = [90, 3, 1, 42];
  await board.updateComplete;
  expect(items(board)[41].dataset.state).to.equal('latest');
  expect(items(board)[0].dataset.state).to.equal('called');
  board.calledNumbers = Array.from({ length: 90 }, (_, index) => 90 - index);
  await board.updateComplete;
  expect(states(board).filter((state) => state === 'uncalled')).to.have.length(0);
  expect(items(board)[0].dataset.state).to.equal('latest');
  expect(board.shadowRoot.querySelectorAll('[aria-live],button,a[href],input,[tabindex]')).to.have.length(0);
  await expect(board).to.be.accessible();
});

it('prize display always shows Línea and Bingo, gracefully empty, lot, amount or both', async () => {
  const display = await fixture(html`<bingo-prize-display></bingo-prize-display>`);
  const rows = () => [...display.shadowRoot.querySelectorAll('dl > div')].map((row) => [...row.children].map((part) => part.textContent.trim()).join(' '));
  expect(rows()).to.deep.equal(['Línea Sin definir', 'Bingo Sin definir']);
  display.prizes = { line: { amount: 0, lot: '' }, bingo: { amount: 12500, lot: 'Cesta navideña' } };
  await display.updateComplete;
  expect(rows()).to.deep.equal(['Línea Sin premio', 'Bingo Cesta navideña 12.500 €']);
  display.prizes = { line: { amount: 50, lot: '' }, bingo: { amount: 0, lot: 'Jamón' } };
  await display.updateComplete;
  expect(rows()).to.deep.equal(['Línea 50 €', 'Bingo Jamón']);
  display.prizes = null;
  await display.updateComplete;
  expect(rows()).to.deep.equal(['Línea Sin definir', 'Bingo Sin definir']);
  expect(display.shadowRoot.querySelectorAll('[aria-live],button,a[href],input,[tabindex]')).to.have.length(0);
  await expect(display).to.be.accessible();
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

it('public wiring keeps a committed phase visible beside separate stale feedback', async function () {
  this.timeout(15000);
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
  let receiveMeta;
  window.publicEventMeta = { subscribe: (callback) => {
    receiveMeta = callback;
    return () => { unsubscribed++; };
  } };
  let receivePrizes;
  window.publicEventPrizes = { subscribe: (callback) => {
    receivePrizes = callback;
    return () => { unsubscribed++; };
  } };
  let receiveLineAward;
  window.publicLineAward = { subscribe: (callback) => {
    receiveLineAward = callback;
    return () => { unsubscribed++; };
  } };
  // Tongo and the line celebration both listen on the presentation channel, as with the real preload.
  const presentationListeners = [];
  const receivePresentation = (value) => presentationListeners.forEach((callback) => callback(value));
  window.publicPresentation = { subscribe: (callback) => {
    presentationListeners.push(callback);
    return () => { unsubscribed++; };
  } };
  const receipts = [];
  window.publicLineReceipt = { started: (id) => receipts.push(id) };
  try {
    const entry = new URL('../../src/public-ui.mjs', import.meta.url);
    const response = await fetch(entry);
    expect(response.ok, `public UI fetch: ${response.status}`).to.equal(true);
    const original = await response.text();
    const source = original
      .replace("import './screen.css';", '')
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
    for (const invalid of ['body{}', 'https://example.com/x.css', '../generated/x.css', 'dark', null, 'pixel-classic']) receiveTheme(invalid);
    expect(document.documentElement.dataset.theme).to.equal('high-contrast');
    receiveTheme('light');
    expect(document.documentElement.dataset.theme).to.equal('light');
    receiveTheme('jules');
    expect(document.documentElement.dataset.theme).to.equal('jules');
    const heading = shell.querySelector('h1');
    const details = shell.querySelector('#event-details');
    expect([heading.textContent, details.hidden]).to.deep.equal(['Current event', true]);
    receiveMeta({ name: 'Verbena', date: '2026-08-15', place: 'Plaza Mayor' });
    expect([heading.textContent, details.textContent, details.hidden]).to.deep.equal(['Verbena', '2026-08-15 · Plaza Mayor', false]);
    for (const invalid of [null, { name: ' ', date: '2026-08-15', place: 'P' }, { name: 'N', date: 'x', place: 'P' }, 'Verbena']) {
      receiveMeta(invalid);
      expect([heading.textContent, details.hidden]).to.deep.equal(['Current event', true]);
    }
    receiveMeta({ name: 'Verbena', date: '2026-08-15', place: 'Plaza Mayor' });
    // Committed prizes: an event switch or unreadable payload never leaves the previous event's prizes.
    const prizes = shell.querySelector('#prizes');
    const committed = { line: { amount: 100, lot: '' }, bingo: { amount: 0, lot: 'Jamón' } };
    receivePrizes(committed);
    expect(prizes.prizes).to.deep.equal(committed);
    receivePrizes({ line: { amount: 1, lot: '' }, bingo: { amount: -1, lot: '' } });
    expect(prizes.prizes).to.equal(null);
    receivePrizes(committed);
    receivePrizes(null);
    expect(prizes.prizes).to.equal(null);
    receivePrizes(committed);
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
    // Committed first-line award: static text only, never a celebration; invalid or cleared payloads remove it.
    const lineAward = shell.querySelector('#line-award');
    expect(lineAward.hidden).to.equal(true);
    const committedAward = { eventId: 'event-a', winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1,
      lot: '', lotResolution: 'not_required' };
    const boardBefore = [...shell.querySelector('#called-numbers').calledNumbers];
    receiveLineAward(committedAward);
    expect([lineAward.hidden, lineAward.textContent]).to.deep.equal([false,
      'Línea declarada · 3 ganadores · 3,33 € cada uno · 1 céntimo sin repartir']);
    expect(shell.querySelector('#tongo').active).to.equal(false);
    expect([...shell.querySelector('#called-numbers').calledNumbers]).to.deep.equal(boardBefore);
    for (const invalid of [{ ...committedAward, shareCents: 1 }, 'award', undefined]) {
      receiveLineAward(invalid);
      expect([lineAward.hidden, lineAward.textContent]).to.deep.equal([true, '']);
      receiveLineAward(committedAward);
    }
    receiveLineAward(null);
    expect([lineAward.hidden, lineAward.textContent]).to.deep.equal([true, '']);
    receiveLineAward(committedAward);
    // Tongo overlays the unchanged board, then clears; repeats and junk never replay it.
    const tongo = shell.querySelector('#tongo');
    const board = () => [...shell.querySelector('#called-numbers').calledNumbers];
    const before = [board(), phase.message, status.message];
    receivePresentation({ kind: 'tongo', id: 1, durationMs: 500 });
    expect(tongo.active).to.equal(true);
    expect([board(), phase.message, status.message]).to.deep.equal(before);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(tongo.active).to.equal(false);
    for (const ignored of [{ kind: 'tongo', id: 1, durationMs: 500 }, { kind: 'tongo', id: 2 }, 'tongo']) receivePresentation(ignored);
    expect(tongo.active).to.equal(false);
    expect([board(), phase.message, status.message]).to.deep.equal(before);
    // First-line celebration: overlays the unchanged board with the committed facts, reports the start only once
    // rendered, hides itself, and never replays a repeated id or a Tongo/junk signal.
    const celebration = shell.querySelector('#line-celebration');
    expect(celebration.active).to.equal(false);
    expect(receipts).to.deep.equal([]);
    const lineBefore = [board(), phase.message, status.message];
    receivePresentation({ kind: 'line', id: 'p1', durationMs: 4000 });
    expect(celebration.active).to.equal(true);
    await celebration.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receipts).to.deep.equal(['p1']);
    expect(celebration.shadowRoot.querySelector('[role="status"]').textContent)
      .to.equal('¡Línea! Línea declarada · 3 ganadores · 3,33 € cada uno · 1 céntimo sin repartir');
    expect(celebration.shadowRoot.querySelector('.word').textContent).to.equal('¡Línea!');
    expect(getComputedStyle(celebration.shadowRoot.querySelector('.card')).animationName).to.equal('none');
    expect([board(), phase.message, status.message]).to.deep.equal(lineBefore);
    expect(tongo.active).to.equal(false);
    await expect(celebration).to.be.accessible();
    receivePresentation({ kind: 'line', id: 'p2', durationMs: 4000 });
    receivePresentation({ kind: 'line', id: 'p1', durationMs: 4000 });
    expect(receipts).to.deep.equal(['p1']);
    await new Promise((resolve) => setTimeout(resolve, 4100));
    expect(celebration.active).to.equal(false);
    for (const ignored of [{ kind: 'line', id: 'p1', durationMs: 4000 }, { kind: 'line', id: '', durationMs: 4000 },
      { kind: 'line', id: 'p3', durationMs: 1 }]) receivePresentation(ignored);
    expect(celebration.active).to.equal(false);
    expect(receipts).to.deep.equal(['p1']);
    window.dispatchEvent(new Event('pagehide'));
    expect(unsubscribed).to.equal(7);
  } finally {
    shell.remove();
    delete window.publicEvent;
    delete window.publicTheme;
    delete window.publicEventMeta;
    delete window.publicEventPrizes;
    delete window.publicLineAward;
    delete window.publicPresentation;
    delete window.publicLineReceipt;
    delete document.documentElement.dataset.theme;
  }
});

it('uses the three generated themes, wraps at narrow widths, and computes reduced motion', async () => {
  const response = await fetch(new URL('../../src/screen.css', import.meta.url));
  expect(response.ok).to.equal(true);
  const screenCss = await response.text();
  const imports = /^@import '@fontsource-variable\/roboto-mono\/wght\.css';\s*@import '\.\/generated\/jules\.css';\s*@import '\.\/generated\/light\.css';\s*@import '\.\/generated\/high-contrast\.css';\s*/;
  expect(screenCss).to.match(imports);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = screenCss.replace(imports, '');
  document.head.append(stylesheet);
  const themeSheets = await Promise.all(['jules', 'light', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
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
  const last = items(board)[0];
  const called = items(board)[89];
  const uncalled = items(board)[1];
  expect(getComputedStyle(last).outlineStyle).to.equal('solid');
  expect(getComputedStyle(called).outlineStyle).to.equal('none');
  try {
    const resolve = (name) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(board).getPropertyValue(name).trim();
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const chip = (item) => getComputedStyle(item);
    const shapes = {};
    for (const theme of ['jules', 'light', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      expect(getComputedStyle(board).getPropertyValue('--bingo-color-accent').trim()).not.to.equal('');
      expect(getComputedStyle(last).outlineColor).to.equal(resolve('--bingo-color-accent'));
      expect([chip(last).color, chip(last).backgroundColor])
        .to.deep.equal([resolve('--bingo-color-call-latest'), resolve('--bingo-color-call-latest-surface')], theme);
      expect([chip(called).color, chip(called).backgroundColor])
        .to.deep.equal([resolve('--bingo-color-call-called'), resolve('--bingo-color-call-called-surface')], theme);
      expect(chip(uncalled).backgroundColor).to.equal(resolve('--bingo-color-call-uncalled-surface'), theme);
      shapes[theme] = { radius: chip(last).borderTopLeftRadius, font: getComputedStyle(document.body).fontFamily };
      await expect(board).to.be.accessible();
    }
    // Same components, different token values: every theme is square; jules is set in bundled Roboto Mono.
    expect(Object.values(shapes).map((shape) => shape.radius)).to.deep.equal(['0px', '0px', '0px']);
    expect(shapes.jules.font).to.match(/^"?Roboto Mono Variable"?,/);
    expect(shapes.light.font).not.to.match(/Roboto Mono/);
    board.style.width = '900px';
    const box = board.getBoundingClientRect();
    expect(box.width / box.height).to.be.closeTo(10 / 9, 0.02);
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

it('at 1920×1080 a dominant near-square board sits between the event identity and the latest ball with prizes', async () => {
  await setViewport({ width: 1920, height: 1080 });
  const style = document.createElement('style');
  style.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  const theme = document.createElement('link');
  theme.rel = 'stylesheet';
  theme.href = new URL('../../src/generated/jules.css', import.meta.url).href;
  await new Promise((resolve, reject) => { theme.onload = resolve; theme.onerror = reject; document.head.append(theme); });
  document.head.append(style);
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/public.html', import.meta.url))).text(), 'text/html');
  const shell = document.importNode(page.querySelector('bingo-shell'), true);
  document.body.append(shell);
  try {
    const box = (selector) => shell.querySelector(selector).getBoundingClientRect();
    shell.querySelector('#called-numbers').loaded = true;
    await Promise.all([...shell.querySelectorAll('*')].map((element) => element.updateComplete));
    const [identity, board, latest, prizes] = ['#event-name', '#called-numbers', '#latest-draw', '#prizes'].map(box);
    expect(board.width / board.height).to.be.within(1, 1.2);
    expect(board.height).to.be.greaterThan(800);
    expect(board.width).to.be.greaterThan(2 * Math.max(identity.width, latest.width));
    expect(identity.right).to.be.at.most(board.left);
    expect(board.right).to.be.at.most(latest.left);
    expect(prizes.left).to.be.at.least(board.right);
    expect(prizes.bottom).to.be.at.most(1080);
    expect(document.documentElement.scrollHeight).to.be.at.most(1080);
    expect(shell.querySelector('#prizes').shadowRoot.querySelectorAll('dt')).to.have.length(2);
    expect(shell.querySelectorAll('video,button,input,[tabindex]')).to.have.length(0);
  } finally {
    shell.remove();
    style.remove();
    theme.remove();
    await setViewport({ width: 800, height: 600 });
  }
});

it('at 800×600 the public layout stacks in one column without horizontal scroll', async () => {
  await setViewport({ width: 800, height: 600 });
  const style = document.createElement('style');
  style.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  const theme = document.createElement('link');
  theme.rel = 'stylesheet';
  theme.href = new URL('../../src/generated/jules.css', import.meta.url).href;
  await new Promise((resolve, reject) => { theme.onload = resolve; theme.onerror = reject; document.head.append(theme); });
  document.head.append(style);
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/public.html', import.meta.url))).text(), 'text/html');
  const shell = document.importNode(page.querySelector('bingo-shell'), true);
  document.body.append(shell);
  try {
    shell.querySelector('#called-numbers').loaded = true;
    await Promise.all([...shell.querySelectorAll('*')].map((element) => element.updateComplete));
    expect(getComputedStyle(shell.querySelector('.public-layout')).gridTemplateColumns.split(' ')).to.have.length(1);
    for (const selector of ['#called-numbers', '#latest-draw', '#prizes']) {
      const { left, right } = shell.querySelector(selector).getBoundingClientRect();
      expect(left, selector).to.be.at.least(0);
      expect(right, selector).to.be.at.most(innerWidth);
    }
    expect(document.documentElement.scrollWidth).to.be.at.most(innerWidth);
  } finally {
    shell.remove();
    style.remove();
    theme.remove();
  }
});
