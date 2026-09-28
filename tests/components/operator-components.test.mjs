import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-event-list.mjs';
import { bindTabs } from '../../src/operator-tabs.mjs';

it('operator page exposes shared panels and interactive components', async () => {
  const response = await fetch(new URL('../../src/operator.html', import.meta.url));
  expect(response.ok).to.equal(true);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  expect(page.querySelector('main h1')).not.to.equal(null);
  expect([...page.querySelectorAll('main [role="tab"]')].map((tab) => tab.textContent))
    .to.deep.equal(['Eventos', 'Configuración', 'Bingo']);
  expect(page.querySelectorAll('#panel-bingo bingo-panel')).to.have.length(3);
  expect(page.querySelectorAll('#panel-settings .active-event-banner, #panel-bingo .active-event-banner')).to.have.length(2);
  expect(page.querySelector('#panel-events bingo-event-list#event-list')).not.to.equal(null);
  for (const selector of ['[role="tablist"]', '#panel-events', '#panel-settings']) {
    expect(page.querySelector(selector).getAttribute('lang')).to.equal('es');
  }
  expect([...page.querySelectorAll('.active-event-banner')].every((banner) => banner.lang === 'es')).to.equal(true);
  expect(page.querySelector('#panel-events input#event-date[type="date"][required]')).not.to.equal(null);
  expect(page.querySelector('#panel-bingo bingo-draw-controls#draw-controls')).not.to.equal(null);
  expect(page.querySelector('label[for="theme-select"]').textContent).to.equal('Theme for both windows');
  expect([...page.querySelectorAll('select#theme-select option')].map((option) => option.value))
    .to.deep.equal(['pixel-classic', 'high-contrast']);
  expect(page.querySelector('bingo-status#theme-status')).not.to.equal(null);
  expect(page.querySelector('bingo-operator-summary#event-summary')).not.to.equal(null);
  expect(page.querySelector('bingo-call-history#called-numbers')).not.to.equal(null);
  expect(page.querySelector('bingo-status#event-status')).not.to.equal(null);
  expect(page.querySelector('bingo-status#public-status')).not.to.equal(null);
  expect(page.querySelector('bingo-draw-controls#draw-controls')).not.to.equal(null);
  for (const id of ['open-public', 'move-public']) expect(page.querySelector(`bingo-button#${id}`)).not.to.equal(null);
  expect(page.querySelector('bingo-dialog')).to.equal(null);
});

it('summary and history show ordered acknowledged values, preserve them through stale states, and remain presentation-only', async () => {
  const summary = await fixture(html`<bingo-operator-summary></bingo-operator-summary>`);
  const history = await fixture(html`<bingo-call-history></bingo-call-history>`);
  expect(summary.shadowRoot.textContent).to.include('Remaining: 90');
  expect(history.shadowRoot.textContent).to.include('No draws yet');
  history.calledNumbers = [90, 3, 1];
  summary.latest = 1;
  summary.count = 3;
  summary.remaining = 87;
  await Promise.all([history.updateComplete, summary.updateComplete]);
  expect([...history.shadowRoot.querySelectorAll('li bingo-number')].map((number) => number.value)).to.deep.equal([90, 3, 1]);
  expect(history.shadowRoot.querySelectorAll('li[aria-current="true"]')).to.have.length(1);
  expect(summary.shadowRoot.querySelector('bingo-number').value).to.equal(1);
  expect([...summary.shadowRoot.querySelectorAll('output')].map((output) => output.textContent)).to.deep.equal(['3', '87']);
  const status = await fixture(html`<bingo-status tone="warning" message="History may be stale"></bingo-status>`);
  expect(status.shadowRoot.querySelector('[role="status"]').textContent).to.equal('History may be stale');
  expect([...history.shadowRoot.querySelectorAll('li bingo-number')].map((number) => number.value)).to.deep.equal([90, 3, 1]);
  expect(history.shadowRoot.querySelectorAll('button,input,[tabindex],[aria-live]')).to.have.length(0);
  await expect(summary).to.be.accessible();
  await expect(history).to.be.accessible();
});

it('operator presentation follows both semantic themes without focusable shadow controls', async () => {
  const summary = await fixture(html`<bingo-operator-summary></bingo-operator-summary>`);
  const links = await Promise.all(['pixel-classic', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  try {
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const surface = getComputedStyle(summary).getPropertyValue('--bingo-color-text').trim();
      expect(surface).not.to.equal('');
      const probe = document.createElement('span');
      probe.style.color = surface;
      document.body.append(probe);
      expect(getComputedStyle(summary.shadowRoot.querySelector('p')).color).to.equal(getComputedStyle(probe).color);
      probe.remove();
      await expect(summary).to.be.accessible();
    }
    expect(summary.shadowRoot.querySelectorAll('button,input,[tabindex]')).to.have.length(0);
  } finally {
    delete document.documentElement.dataset.theme;
    links.forEach((link) => link.remove());
  }
});

it('native manual validity, keyboard activation and disabled states remain intact', async () => {
  const controls = await fixture(html`<bingo-draw-controls></bingo-draw-controls>`);
  controls.manualDisabled = false;
  await controls.updateComplete;
  const input = controls.manualInput;
  expect(input.checkValidity()).to.equal(false);
  for (const value of ['0', '91', '1.5']) {
    input.value = value;
    expect(input.checkValidity()).to.equal(false);
  }
  input.value = '42';
  expect(input.checkValidity()).to.equal(true);
  expect(input.valueAsNumber).to.equal(42);
  let activations = 0;
  controls.manualButton.addEventListener('click', () => activations++);
  controls.manualButton.focus();
  expect(controls.manualButton.tagName).to.equal('BUTTON');
  controls.manualButton.click();
  expect(activations).to.equal(1);
  controls.manualDisabled = true;
  controls.digitalDisabled = true;
  controls.reloadDisabled = true;
  await controls.updateComplete;
  expect(controls.manualInput.disabled).to.equal(true);
  expect(controls.manualButton.disabled).to.equal(true);
  expect(controls.digitalButton.disabled).to.equal(true);
  expect(controls.reloadButton.disabled).to.equal(true);
  controls.manualButton.click();
  expect(activations).to.equal(1);
  controls.manualDisabled = false;
  await controls.updateComplete;
  controls.manualButton.focus();
  const manualHost = controls.shadowRoot.querySelector('#draw-manual');
  expect(controls.shadowRoot.activeElement === manualHost).to.equal(true);
  expect(manualHost.shadowRoot.activeElement === controls.manualButton).to.equal(true);
  expect(customElements.get('bingo-button').styles.cssText).to.include('button:focus-visible');
});

it('isolated dialog supports label, Escape/cancel/confirm and focus restoration', async () => {
  const opener = await fixture(html`<button>Open dialog</button>`);
  const dialog = await fixture(html`<bingo-dialog label="Confirm correction"></bingo-dialog>`);
  const signals = [];
  dialog.addEventListener('confirm', () => signals.push('confirm'));
  dialog.addEventListener('dismiss', () => signals.push('dismiss'));
  opener.focus();
  await dialog.show();
  const native = dialog.shadowRoot.querySelector('dialog');
  expect(native.open).to.equal(true);
  expect(native.getAttribute('aria-labelledby')).not.to.equal(null);
  await expect(dialog).to.be.accessible();
  native.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(native.open).to.equal(false);
  expect(document.activeElement).to.equal(opener);
  await dialog.show();
  dialog.shadowRoot.querySelector('[data-action="cancel"]').button.click();
  expect(signals).to.deep.equal(['dismiss', 'dismiss']);
  await dialog.show();
  dialog.shadowRoot.querySelector('[data-action="confirm"]').button.click();
  expect(signals).to.deep.equal(['dismiss', 'dismiss', 'confirm']);
  expect(document.activeElement).to.equal(opener);
});

it('dialog restores exact nested shadow button focus after cancel and confirm', async () => {
  const controls = await fixture(html`<bingo-draw-controls></bingo-draw-controls>`);
  controls.manualDisabled = false;
  await controls.updateComplete;
  await controls.shadowRoot.querySelector('#draw-manual').updateComplete;
  const opener = controls.manualButton;
  const dialog = await fixture(html`<bingo-dialog label="Confirm correction"></bingo-dialog>`);
  expect(opener.getRootNode().host.getRootNode().host === controls).to.equal(true);
  for (const action of ['cancel', 'confirm']) {
    opener.focus();
    expect(opener.getRootNode().activeElement === opener).to.equal(true);
    await dialog.show();
    dialog.shadowRoot.querySelector(`[data-action="${action}"]`).button.click();
    expect(dialog.shadowRoot.querySelector('dialog').open).to.equal(false);
    expect(opener.getRootNode().activeElement === opener).to.equal(true);
  }
});

it('interactive components consume both semantic themes and reduced motion', async () => {
  const controls = await fixture(html`<bingo-draw-controls></bingo-draw-controls>`);
  const button = await fixture(html`<bingo-button>Action</bingo-button>`);
  const dialog = await fixture(html`<bingo-dialog label="Example"></bingo-dialog>`);
  const links = await Promise.all(['pixel-classic', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  try {
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      expect(getComputedStyle(button.shadowRoot.querySelector('button')).color).to.equal(
        getComputedStyle(controls.manualInput).color);
      expect(getComputedStyle(dialog.shadowRoot.querySelector('dialog')).backgroundColor).not.to.equal('rgba(0, 0, 0, 0)');
      await expect(button).to.be.accessible();
    }
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).to.equal(true);
    expect(getComputedStyle(button.shadowRoot.querySelector('button')).transitionDuration).to.equal('0s');
  } finally {
    delete document.documentElement.dataset.theme;
    links.forEach((link) => link.remove());
  }
});

it('operator wiring keeps committed state on failure and public controls use the desktop boundary', async () => {
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/operator.html', import.meta.url))).text(), 'text/html');
  const main = document.importNode(page.querySelector('main'), true);
  document.body.append(main);
  let resolveLoad;
  let openCount = 0;
  let moveCount = 0;
  let publicUpdate;
  const desktop = {
    getCurrentEvent: () => new Promise((resolve) => { resolveLoad = resolve; }),
    drawDigital: async () => ({ ok: false, message: 'Write failed' }),
    drawManual: async () => ({ ok: false, message: 'Write failed' }),
    openPublic: () => { openCount++; },
    movePublicToSecondary: () => { moveCount++; },
    onPublicStatus: (callback) => { publicUpdate = callback; },
    getTheme: async () => ({ ok: true, theme: 'pixel-classic' }),
    setTheme: async () => ({ ok: false, message: 'Write failed' }),
  };
  window.desktop = desktop;
  try {
    const entry = new URL('../../src/operator-ui.mjs', import.meta.url);
    const source = (await (await fetch(entry)).text())
      .replace("import './screen.css';", '')
      .replaceAll(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, entry).href}'`)
      .replaceAll(/import '(\.\/[^']+)'/g, (_, relative) => `import '${new URL(relative, entry).href}'`);
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await import(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    const history = main.querySelector('#called-numbers');
    const summary = main.querySelector('#event-summary');
    const status = main.querySelector('#event-status');
    const phase = main.querySelector('#phase-status');
    const error = main.querySelector('#event-error');
    const controls = main.querySelector('#draw-controls');
    await controls.updateComplete;
    expect(controls.digitalButton.disabled).to.equal(true);
    expect(status.message).to.equal('Loading event state');
    expect(phase.message).to.equal('Current phase: waiting for event state');
    resolveLoad({ ok: true, snapshot: { calledNumbers: [90, 3, 1], phase: 'checking_bingo',
      lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await history.updateComplete;
    expect(summary.remaining).to.equal(87);
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    expect(phase.message).to.equal('Current phase: Checking bingo');
    await phase.updateComplete;
    expect(phase.shadowRoot.querySelector('[role="status"]').textContent).to.equal('Current phase: Checking bingo');
    await expect(phase).to.be.accessible();
    await controls.updateComplete;
    expect(controls.digitalButton.disabled).to.equal(false);
    controls.digitalButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    expect(summary.remaining).to.equal(87);
    expect(status.tone).to.equal('warning');
    expect(error.message).to.equal('Write failed');
    expect(error.hidden).to.equal(false);
    expect(phase.message).to.equal('Current phase: Checking bingo');
    main.querySelector('#open-public').shadowRoot.querySelector('button').click();
    main.querySelector('#move-public').shadowRoot.querySelector('button').click();
    expect([openCount, moveCount]).to.deep.equal([1, 1]);
    publicUpdate(true);
    expect(main.querySelector('#public-status').hidden).to.equal(false);
    publicUpdate(false);
    expect(main.querySelector('#public-status').hidden).to.equal(true);
  } finally {
    main.remove();
    delete window.desktop;
    delete document.documentElement.dataset.theme;
  }
});

it('operator theme selection applies only committed themes and keeps the last one on failure', async () => {
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/operator.html', import.meta.url))).text(), 'text/html');
  const main = document.importNode(page.querySelector('main'), true);
  document.body.append(main);
  const links = await Promise.all(['pixel-classic', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const element = document.createElement('link');
    element.rel = 'stylesheet';
    element.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    element.onload = () => resolve(element);
    element.onerror = reject;
    document.head.append(element);
  })));
  let reply = { ok: true, theme: 'high-contrast' };
  const requests = [];
  window.desktop = {
    getCurrentEvent: async () => ({ ok: true, snapshot: { calledNumbers: [], phase: 'drawing', lastTransitionAt: null } }),
    onPublicStatus: () => {}, openPublic: () => {}, movePublicToSecondary: () => {},
    getTheme: async () => ({ ok: true, theme: 'pixel-classic' }),
    setTheme: async (theme) => { requests.push(theme); return reply; },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const entry = new URL('../../src/operator-ui.mjs', import.meta.url);
    const source = (await (await fetch(entry)).text())
      .replace("import './screen.css';", '')
      .replaceAll(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, entry).href}'`)
      .replaceAll(/import '(\.\/[^']+)'/g, (_, relative) => `import '${new URL(relative, entry).href}'`);
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await import(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    await settle();
    const select = main.querySelector('#theme-select');
    const status = main.querySelector('#theme-status');
    const root = document.documentElement;
    expect(root.dataset.theme).to.equal('pixel-classic');
    expect(select.disabled).to.equal(false);
    const canvas = () => getComputedStyle(root).getPropertyValue('--bingo-color-canvas').trim();
    const classic = canvas();
    select.value = 'high-contrast';
    select.dispatchEvent(new Event('change'));
    expect(select.disabled).to.equal(true);
    expect(root.dataset.theme).to.equal('pixel-classic');
    await settle();
    expect(root.dataset.theme).to.equal('high-contrast');
    expect(canvas()).not.to.equal(classic);
    expect(status.message).to.equal('Current theme: High contrast');
    reply = { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' };
    select.value = 'pixel-classic';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(requests).to.deep.equal(['high-contrast', 'pixel-classic']);
    expect(root.dataset.theme).to.equal('high-contrast');
    expect(select.value).to.equal('high-contrast');
    expect(status.message).to.equal('Could not save the theme. Try again.');
    await status.updateComplete;
    expect(status.shadowRoot.querySelector('[role="alert"]')).not.to.equal(null);
    await expect(select.closest('bingo-panel')).to.be.accessible();
  } finally {
    main.remove();
    links.forEach((link) => link.remove());
    delete window.desktop;
    delete document.documentElement.dataset.theme;
  }
});

it('operator tabs follow WAI-ARIA selection by pointer and keyboard with a roving tabindex', async () => {
  const root = await fixture(html`<div>
    <div role="tablist" aria-label="Espacio de trabajo">
      <button role="tab" id="t1" aria-controls="p1" aria-selected="true">Eventos</button>
      <button role="tab" id="t2" aria-controls="p2" aria-selected="false">Configuración</button>
      <button role="tab" id="t3" aria-controls="p3" aria-selected="false">Bingo</button>
    </div>
    <div role="tabpanel" id="p1" aria-labelledby="t1" tabindex="0">A</div>
    <div role="tabpanel" id="p2" aria-labelledby="t2" tabindex="0" hidden>B</div>
    <div role="tabpanel" id="p3" aria-labelledby="t3" tabindex="0" hidden>C</div></div>`);
  bindTabs(root.querySelector('[role="tablist"]'));
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const state = () => tabs.map((tab) => [tab.getAttribute('aria-selected'), tab.tabIndex,
    root.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden]);
  expect(state()).to.deep.equal([['true', 0, false], ['false', -1, true], ['false', -1, true]]);
  tabs[2].click();
  expect(state()[2]).to.deep.equal(['true', 0, false]);
  const key = (name) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  tabs[2].focus();
  key('ArrowRight');
  expect(document.activeElement).to.equal(tabs[0]);
  expect(state()[0]).to.deep.equal(['true', 0, false]);
  key('ArrowLeft');
  expect(document.activeElement).to.equal(tabs[2]);
  key('Home');
  key('End');
  expect([document.activeElement, state()[1][2]]).to.deep.equal([tabs[2], true]);
  await expect(root).to.be.accessible();
});

it('event list marks the committed active event, offers selection for others, and shows an empty state', async () => {
  const list = await fixture(html`<bingo-event-list></bingo-event-list>`);
  expect(list.shadowRoot.textContent).to.include('no disponible todavía');
  expect(list.shadowRoot.textContent).not.to.include('Todavía no hay eventos');
  list.loaded = true;
  await list.updateComplete;
  expect(list.shadowRoot.textContent).to.include('Todavía no hay eventos');
  list.events = [
    { id: 'a', name: 'Verbena', date: '2026-09-28', place: 'Plaza', phase: 'drawing', active: true },
    { id: 'b', name: 'Fiesta', date: '2026-10-01', place: 'Sala', phase: 'finished', active: false },
  ];
  await list.updateComplete;
  const items = [...list.shadowRoot.querySelectorAll('li')];
  expect(items.map((item) => item.getAttribute('aria-current'))).to.deep.equal(['true', 'false']);
  expect(items[0].textContent).to.include('Evento activo');
  expect(items[0].querySelector('bingo-button')).to.equal(null);
  const chosen = [];
  list.addEventListener('event-select', (event) => chosen.push(event.detail.id));
  items[1].querySelector('bingo-button').button.click();
  list.disabled = true;
  await list.updateComplete;
  items[1].querySelector('bingo-button').button.click();
  expect(chosen).to.deep.equal(['b']);
  expect(items[1].querySelector('bingo-button').button.disabled).to.equal(true);
  await expect(list).to.be.accessible();
});
