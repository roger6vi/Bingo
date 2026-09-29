import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-event-list.mjs';
import { bindTabs } from '../../src/operator-tabs.mjs';
import { setViewport } from '@web/test-runner-commands';
import { SIMULATOR_MESSAGE } from '../../src/public-bridge.mjs';

const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
// ResizeObserver delivers on the next rendering frames.
const frames = async () => { for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve)); };
const stylesheet = (href) => new Promise((resolve, reject) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onload = () => resolve(link);
  link.onerror = reject;
  document.head.append(link);
});

// Mounts the real operator page and entry module against an in-memory desktop boundary, and records
// every message the Configuración simulator frame receives.
async function loadOperator() {
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/operator.html', import.meta.url))).text(), 'text/html');
  const main = document.importNode(page.querySelector('main'), true);
  // Browser-only tests cannot resolve Electron's local simulator protocol; keep its message sink inert.
  main.querySelector('#public-simulator').src = 'about:blank';
  main.querySelector('#public-simulator').removeAttribute('sandbox');
  document.body.append(main);
  const links = await Promise.all(['pixel-classic', 'high-contrast']
    .map((name) => stylesheet(new URL(`../../src/generated/${name}.css`, import.meta.url).href)));
  const screen = document.createElement('style');
  screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  document.head.append(screen);
  const requests = [];
  const replies = { setTheme: null, updateEvent: null };
  let theme = 'pixel-classic';
  let events = [
    { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', phase: 'drawing', createdAt: '2026-01-01T00:00:00.000Z', active: true },
    { id: 'b', name: 'Fiesta', date: '2026-10-01', place: 'Sala', phase: 'drawing', createdAt: '2026-01-02T00:00:00.000Z', active: false },
  ];
  const list = () => ({ ok: true, events: events.map((event) => ({ ...event })) });
  window.desktop = {
    getCurrentEvent: async () => ({ ok: true, snapshot: { calledNumbers: [4, 9], phase: 'drawing', lastTransitionAt: null } }),
    drawManual: async () => { requests.push('draw'); return { ok: false, message: 'unexpected' }; },
    drawDigital: async () => { requests.push('draw'); return { ok: false, message: 'unexpected' }; },
    onPublicStatus: () => {}, openPublic: () => {}, movePublicToSecondary: () => {},
    getTheme: async () => ({ ok: true, theme }),
    setTheme: async (next) => {
      requests.push(`theme:${next}`);
      if (replies.setTheme) return replies.setTheme;
      theme = next;
      return { ok: true, theme };
    },
    listEvents: async () => list(),
    createEvent: async () => list(),
    selectEvent: async (id) => {
      requests.push(`select:${id}`);
      events = events.map((event) => ({ ...event, active: event.id === id }));
      return list();
    },
    updateEvent: async (id, meta) => {
      requests.push(`update:${id}:${JSON.stringify(meta)}`);
      if (replies.updateEvent) return replies.updateEvent;
      events = events.map((event) => (event.id === id ? { ...event, ...meta } : event));
      return list();
    },
  };
  const entry = new URL('../../src/operator-ui.mjs', import.meta.url);
  const source = (await (await fetch(entry)).text())
    .replace("import './screen.css';", '')
    .replaceAll(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, entry).href}'`)
    .replaceAll(/import '(\.\/[^']+)'/g, (_, relative) => `import '${new URL(relative, entry).href}'`);
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { await import(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
  const frame = main.querySelector('#public-simulator');
  if (frame.getAttribute('src') !== 'about:blank' &&
    (frame.contentDocument?.readyState !== 'complete' || frame.contentWindow.location.href === 'about:blank')) {
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  }
  const messages = [];
  frame.contentWindow.addEventListener('message', (message) => {
    if (message.data?.type === SIMULATOR_MESSAGE) messages.push(message.data);
  });
  // Replay the feed into the listener, as a frame reload would.
  frame.dispatchEvent(new Event('load'));
  await settle();
  const simulator = { messages, last: (channel) => messages.filter((message) => message.channel === channel).at(-1)?.payload };
  const cleanup = () => {
    for (const dialog of main.querySelectorAll('bingo-dialog')) dialog.shadowRoot?.querySelector('dialog')?.close();
    main.remove();
    links.forEach((link) => link.remove());
    screen.remove();
    delete window.desktop;
    delete document.documentElement.dataset.theme;
  };
  return { main, requests, replies, simulator, cleanup };
}

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it('operator page exposes shared panels and interactive components', async () => {
  const response = await fetch(new URL('../../src/operator.html', import.meta.url));
  expect(response.ok).to.equal(true);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  expect(page.querySelector('main h1')).not.to.equal(null);
  expect([...page.querySelectorAll('main [role="tab"]')].map((tab) => tab.textContent))
    .to.deep.equal(['Eventos', 'Configuración', 'Bingo']);
  expect(page.querySelectorAll('#panel-bingo bingo-panel')).to.have.length(2);
  expect(page.querySelector('#panel-bingo #theme-select')).to.equal(null, 'the theme selector lives in Configuración');
  expect(page.querySelectorAll('#panel-settings .active-event-banner, #panel-bingo .active-event-banner')).to.have.length(2);
  expect(page.querySelector('#panel-events bingo-event-list#event-list')).not.to.equal(null);
  for (const selector of ['[role="tablist"]', '#panel-events', '#panel-settings']) {
    expect(page.querySelector(selector).getAttribute('lang')).to.equal('es');
  }
  expect([...page.querySelectorAll('.active-event-banner')].every((banner) => banner.lang === 'es')).to.equal(true);
  // Every form control is a shared component; no raw text, date or select controls remain.
  expect(page.querySelectorAll('main input, main select, main textarea')).to.have.length(0);
  expect(page.querySelectorAll('main form button')).to.have.length(0);
  expect(page.querySelector('#panel-events form#create-event bingo-date-field#event-date[name="date"][required]')).not.to.equal(null);
  for (const [id, name] of [['event-name', 'name'], ['event-place', 'place']]) {
    const field = page.querySelector(`#panel-events form#create-event bingo-text-field#${id}`);
    expect([field.getAttribute('name'), field.hasAttribute('required'), field.getAttribute('maxlength')]).to.deep.equal([name, true, '120']);
  }
  expect(page.querySelector('#create-event bingo-form-actions bingo-button#create-event-submit[type="submit"][slot="primary"]').textContent)
    .to.equal('Crear evento');
  expect(page.querySelector('#panel-bingo bingo-draw-controls#draw-controls')).not.to.equal(null);
  expect(page.querySelector('#panel-settings bingo-select-field#theme-select').getAttribute('label')).to.equal('Tema para ambas pantallas');
  for (const [id, tag, label] of [['settings-name', 'bingo-text-field', 'Nombre'], ['settings-place', 'bingo-text-field', 'Lugar'],
    ['settings-date', 'bingo-date-field', 'Fecha']]) {
    const field = page.querySelector(`#panel-settings form#settings-form ${tag}#${id}[required][disabled]`);
    expect(field.getAttribute('label')).to.equal(label);
  }
  expect(page.querySelector('#settings-save').textContent).to.equal('Guardar cambios');
  expect(page.querySelector('#settings-save[type="submit"]')).not.to.equal(null);
  // Actions keep one order: status first, secondary, then the primary action last.
  expect([...page.querySelector('bingo-form-actions#settings-actions').children].map((child) => [child.id, child.slot]))
    .to.deep.equal([['settings-state', 'status'], ['settings-discard', ''], ['settings-save', 'primary']]);
  const simulator = page.querySelector('#panel-settings figure.simulator iframe#public-simulator');
  expect([simulator.getAttribute('src'), simulator.hasAttribute('inert'), simulator.title])
    .to.deep.equal(['bingo-public://simulator/public.html', true, 'Simulador de la pantalla pública']);
  expect([...page.querySelectorAll('bingo-select-field#theme-select option')].map((option) => option.value))
    .to.deep.equal(['pixel-classic', 'high-contrast']);
  expect(page.querySelector('bingo-status#theme-status')).not.to.equal(null);
  expect(page.querySelector('bingo-operator-summary#event-summary')).not.to.equal(null);
  expect(page.querySelector('bingo-call-history#called-numbers')).not.to.equal(null);
  expect(page.querySelector('bingo-status#event-status')).not.to.equal(null);
  expect(page.querySelector('bingo-status#public-status')).not.to.equal(null);
  expect(page.querySelector('bingo-draw-controls#draw-controls')).not.to.equal(null);
  for (const id of ['open-public', 'move-public']) expect(page.querySelector(`bingo-button#${id}`)).not.to.equal(null);
  expect([...page.querySelectorAll('bingo-dialog')].map((dialog) => dialog.id)).to.deep.equal(['unsaved-dialog']);
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

it('operator theme selection drafts into the simulator and applies only committed themes', async () => {
  const op = await loadOperator();
  try {
    const { main, requests, simulator } = op;
    const select = main.querySelector('#theme-select');
    const status = main.querySelector('#theme-status');
    const state = main.querySelector('#settings-state');
    const save = main.querySelector('#settings-save');
    const root = document.documentElement;
    expect([root.dataset.theme, select.disabled, save.disabled]).to.deep.equal(['pixel-classic', false, true]);
    const canvas = () => getComputedStyle(root).getPropertyValue('--bingo-color-canvas').trim();
    const classic = canvas();
    select.value = 'high-contrast';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(root.dataset.theme).to.equal('pixel-classic', 'a draft never restyles the operator or the public window');
    expect(requests).to.deep.equal([]);
    expect(simulator.last('theme')).to.equal('high-contrast');
    expect([state.message, state.tone, save.disabled]).to.deep.equal(['Cambios sin guardar: solo se ven en el simulador.', 'warning', false]);
    save.click();
    await settle();
    expect(requests).to.deep.equal(['theme:high-contrast']);
    expect(root.dataset.theme).to.equal('high-contrast');
    expect(canvas()).not.to.equal(classic);
    expect([status.message, state.message, save.disabled]).to.deep.equal(['Tema guardado: High contrast', 'Sin cambios pendientes.', true]);
    op.replies.setTheme = { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' };
    select.value = 'pixel-classic';
    select.dispatchEvent(new Event('change'));
    save.click();
    await settle();
    expect(requests).to.deep.equal(['theme:high-contrast', 'theme:pixel-classic']);
    expect([root.dataset.theme, select.value]).to.deep.equal(['high-contrast', 'pixel-classic'], 'the failed draft is kept');
    const error = main.querySelector('#settings-error');
    expect([error.hidden, error.message]).to.deep.equal([false, 'No se guardó el tema. Los cambios siguen en el borrador; inténtalo de nuevo.']);
    await error.updateComplete;
    expect(error.shadowRoot.querySelector('[role="alert"]')).not.to.equal(null);
    main.querySelector('#settings-discard').click();
    await settle();
    expect([select.value, error.hidden, simulator.last('theme')]).to.deep.equal(['high-contrast', true, 'high-contrast']);
    await expect(select.closest('bingo-panel')).to.be.accessible();
  } finally { op.cleanup(); }
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

it('a pointer-vetoed tab switch restores focus to the selected tab', async () => {
  const root = await fixture(html`<div><div role="tablist">
    <button role="tab" id="v1" aria-controls="vp1" aria-selected="true">Configuración</button>
    <button role="tab" id="v2" aria-controls="vp2" aria-selected="false">Bingo</button>
  </div><div id="vp1"></div><div id="vp2"></div></div>`);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  bindTabs(root.querySelector('[role="tablist"]'), { canLeave: async () => false });
  tabs[1].focus();
  tabs[1].click();
  await settle();
  expect([tabs[0].getAttribute('aria-selected'), document.activeElement]).to.deep.equal(['true', tabs[0]]);
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

it('event details draft into the simulator, validate like the store, and save through the operator IPC', async () => {
  const op = await loadOperator();
  try {
    const { main, requests, simulator } = op;
    const name = main.querySelector('#settings-name');
    const place = main.querySelector('#settings-place');
    const date = main.querySelector('#settings-date');
    const save = main.querySelector('#settings-save');
    const banners = [...main.querySelectorAll('.active-event-banner')];
    const committedBanner = 'Evento activo: Verbena — 2026-08-15, Plaza';
    expect([name.value, place.value, date.value, name.disabled]).to.deep.equal(['Verbena', 'Plaza', '2026-08-15', false]);
    expect(banners.map((banner) => banner.message)).to.deep.equal([committedBanner, committedBanner]);
    expect(simulator.last('event')).to.deep.equal({ ok: true, eventChanged: true,
      snapshot: { calledNumbers: [4, 9], phase: 'drawing', lastTransitionAt: null } }, 'the simulator shows committed history');
    type(name, '  Gran Bingo ');
    type(date, '2026-09-01');
    await settle();
    expect(simulator.last('meta')).to.deep.equal({ name: 'Gran Bingo', date: '2026-09-01', place: 'Plaza' });
    expect(banners.map((banner) => banner.message)).to.deep.equal([committedBanner, committedBanner]);
    type(place, '   ');
    await place.updateComplete;
    // The field describes and announces its own error; it is marked invalid, not only colored.
    const placeError = place.shadowRoot.querySelector('#error');
    expect([place.error, place.control.getAttribute('aria-invalid'), place.control.getAttribute('aria-describedby'),
      placeError.getAttribute('aria-live'), placeError.textContent.trim(), place.validity.customError, save.disabled])
      .to.deep.equal(['Escribe un lugar de 1 a 120 caracteres.', 'true', 'error', 'polite',
        'Error: Escribe un lugar de 1 a 120 caracteres.', true, true]);
    type(place, 'Plaza');
    await place.updateComplete;
    expect([place.control.getAttribute('aria-invalid'), place.control.hasAttribute('aria-describedby'), placeError.textContent.trim(),
      place.validity.valid, save.disabled]).to.deep.equal(['false', false, '', true, false]);
    op.replies.updateEvent = { ok: false, code: 'storage_failure', message: 'Could not save the event details. Reload the events and try again.' };
    save.click();
    await settle();
    const request = 'update:a:{"name":"Gran Bingo","date":"2026-09-01","place":"Plaza"}';
    expect(requests).to.deep.equal([request]);
    expect([name.value, date.value]).to.deep.equal(['  Gran Bingo ', '2026-09-01'], 'a failed save keeps the draft');
    expect(main.querySelector('#settings-error').message)
      .to.equal('No se guardaron los datos del evento. Los cambios siguen en el borrador; inténtalo de nuevo.');
    expect(banners[0].message).to.equal(committedBanner);
    op.replies.updateEvent = null;
    save.click();
    await settle();
    expect(requests).to.deep.equal([request, request]);
    const saved = 'Evento activo: Gran Bingo — 2026-09-01, Plaza';
    expect(banners.map((banner) => [banner.message, banner.tone])).to.deep.equal([[saved, 'info'], [saved, 'info']]);
    expect([name.value, main.querySelector('#settings-state').message, main.querySelector('#settings-error').hidden])
      .to.deep.equal(['Gran Bingo', 'Sin cambios pendientes.', true]);
    expect(requests.includes('draw')).to.equal(false);
    await expect(main.querySelector('#settings-form')).to.be.accessible();
  } finally { op.cleanup(); }
});

it('leaving Configuración with unsaved edits offers Save, Discard, and Cancel with keyboard focus restored', async () => {
  const op = await loadOperator();
  try {
    const { main, requests } = op;
    const [eventsTab, settingsTab, bingoTab] = ['tab-events', 'tab-settings', 'tab-bingo'].map((id) => main.querySelector(`#${id}`));
    const dialog = main.querySelector('#unsaved-dialog');
    const native = () => dialog.shadowRoot.querySelector('dialog');
    const name = main.querySelector('#settings-name');
    const key = (tab, name) => tab.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    const choose = async (action) => {
      dialog.shadowRoot.querySelector(`[data-action="${action}"]`).button.click();
      await settle();
    };
    settingsTab.click();
    type(name, 'Borrador');
    settingsTab.focus();
    key(settingsTab, 'ArrowRight');
    await settle();
    expect(native().open).to.equal(true);
    expect(document.activeElement).to.equal(dialog, 'focus moves into the modal dialog');
    expect([...dialog.shadowRoot.querySelectorAll('bingo-button')].map((button) => button.textContent.trim()))
      .to.deep.equal(['Cancelar', 'Descartar cambios', 'Guardar cambios']);
    await expect(dialog).to.be.accessible();
    await choose('cancel');
    expect([native().open, settingsTab.getAttribute('aria-selected'), document.activeElement, name.value])
      .to.deep.equal([false, 'true', settingsTab, 'Borrador']);
    key(settingsTab, 'ArrowRight');
    await settle();
    native().dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle();
    expect([settingsTab.getAttribute('aria-selected'), document.activeElement]).to.deep.equal(['true', settingsTab], 'Escape cancels');
    key(settingsTab, 'ArrowRight');
    await settle();
    await choose('discard');
    expect([bingoTab.getAttribute('aria-selected'), document.activeElement, name.value]).to.deep.equal(['true', bingoTab, 'Verbena']);
    expect(requests).to.deep.equal([]);
    settingsTab.click();
    type(name, 'Guardado');
    op.replies.updateEvent = { ok: false, code: 'storage_failure', message: 'x' };
    eventsTab.click();
    await settle();
    await choose('save');
    expect([settingsTab.getAttribute('aria-selected'), name.value]).to.deep.equal(['true', 'Guardado'], 'a failed save stays put');
    op.replies.updateEvent = null;
    eventsTab.click();
    await settle();
    await choose('save');
    expect(eventsTab.getAttribute('aria-selected')).to.equal('true');
    expect(requests.at(-1)).to.equal('update:a:{"name":"Guardado","date":"2026-08-15","place":"Plaza"}');
    bingoTab.click();
    await settle();
    expect([native().open, bingoTab.getAttribute('aria-selected')]).to.deep.equal([false, 'true'], 'a clean draft never prompts');
  } finally { op.cleanup(); }
});

it('selecting another event with unsaved edits is guarded and the draft follows the newly active event', async () => {
  const op = await loadOperator();
  try {
    const { main, requests } = op;
    const dialog = main.querySelector('#unsaved-dialog');
    const list = main.querySelector('#event-list');
    const name = main.querySelector('#settings-name');
    main.querySelector('#tab-settings').click();
    type(name, 'Borrador');
    list.dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    dialog.shadowRoot.querySelector('[data-action="cancel"]').button.click();
    await settle();
    expect([requests, name.value]).to.deep.equal([[], 'Borrador']);
    list.dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    dialog.shadowRoot.querySelector('[data-action="discard"]').button.click();
    await settle();
    expect(requests).to.deep.equal(['select:b']);
    expect([name.value, main.querySelector('#settings-place').value, op.simulator.last('meta')?.name])
      .to.deep.equal(['Fiesta', 'Sala', 'Fiesta']);
  } finally { op.cleanup(); }
});

it('Configuración keeps a scrollable control column beside a 16:9 simulator and stacks at narrow widths', async () => {
  await setViewport({ width: 1400, height: 900 });
  const op = await loadOperator();
  try {
    const { main } = op;
    main.querySelector('#tab-settings').click();
    await frames();
    const controls = main.querySelector('.settings-controls');
    const viewport = main.querySelector('#simulator-viewport');
    const frame = main.querySelector('#public-simulator');
    let c = controls.getBoundingClientRect();
    let v = viewport.getBoundingClientRect();
    expect(v.left).to.be.at.least(c.right);
    expect(v.width).to.be.greaterThan(c.width);
    expect(Math.abs(v.width / v.height - 16 / 9)).to.be.lessThan(0.02);
    expect(Math.abs(frame.getBoundingClientRect().width - viewport.clientWidth)).to.be.lessThan(1, 'the 1920px page is scaled to fit');
    expect(getComputedStyle(controls).overflowY).to.equal('auto');
    expect(getComputedStyle(main.querySelector('.simulator')).position).to.equal('sticky');
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(viewport).getPropertyValue('--bingo-color-border').trim();
      document.body.append(probe);
      expect(getComputedStyle(viewport).borderTopColor).to.equal(getComputedStyle(probe).color);
      probe.remove();
      await expect(main.querySelector('#panel-settings')).to.be.accessible();
    }
    expect(getComputedStyle(main.querySelector('#settings-discard').button).transitionDuration).to.equal('0s');
    expect(getComputedStyle(main.querySelector('#settings-name').control).transitionDuration).to.equal('0s');
    await setViewport({ width: 600, height: 900 });
    await frames();
    c = controls.getBoundingClientRect();
    v = viewport.getBoundingClientRect();
    expect(v.top).to.be.at.least(c.bottom);
    expect(Math.abs(frame.getBoundingClientRect().width - viewport.clientWidth)).to.be.lessThan(1);
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});
