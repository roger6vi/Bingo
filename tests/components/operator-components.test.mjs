import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-event-list.mjs';
import '../../src/components/bingo-app-shell.mjs';
import '../../src/components/bingo-tabs.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-panel.mjs';
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
  const main = document.importNode(page.querySelector('bingo-app-shell'), true);
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

it('operator page is a Spanish three-tab application shell with shared panels and interactive components', async () => {
  const response = await fetch(new URL('../../src/operator.html', import.meta.url));
  expect(response.ok).to.equal(true);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  expect(page.documentElement.lang).to.equal('es');
  const shell = page.querySelector('body > bingo-app-shell');
  expect(shell).not.to.equal(null);
  expect([...shell.children].map((child) => [child.localName, child.getAttribute('slot')]))
    .to.deep.equal([['header', 'header'], ['main', null], ['footer', 'status']]);
  expect(page.querySelector('header h1').textContent).to.equal('Consola del operador');
  expect([...page.querySelectorAll('header bingo-tabs > [role="tab"]')].map((tab) => tab.textContent))
    .to.deep.equal(['Eventos', 'Configuración', 'Bingo']);
  expect([...page.querySelectorAll('main > bingo-tab-panel')].map((panel) => [panel.id, panel.getAttribute('aria-labelledby')]))
    .to.deep.equal([['panel-events', 'tab-events'], ['panel-settings', 'tab-settings'], ['panel-bingo', 'tab-bingo']]);
  expect(page.querySelector('#panel-bingo #theme-select')).to.equal(null, 'the theme selector lives in Configuración');
  expect(page.querySelectorAll('.active-event-banner')).to.have.length(1);
  expect(page.querySelector('header #active-event-banner')).not.to.equal(null, 'one active-event banner, visible from every tab');
  expect(page.querySelector('#panel-events bingo-event-list#event-list')).not.to.equal(null);
  expect(page.querySelector('#panel-events input#event-date[type="date"][required]')).not.to.equal(null);
  // Bingo: the dominant zone beside a side rail with draw, claim, and public-window controls.
  expect(page.querySelector('#panel-bingo .bingo-workspace > bingo-panel.board-zone')).not.to.equal(null);
  const rail = page.querySelector('#panel-bingo .bingo-workspace > bingo-side-rail');
  expect(rail.getAttribute('label')).to.equal('Controles de la partida');
  expect(rail.querySelector('bingo-draw-controls#draw-controls')).not.to.equal(null);
  expect([...rail.querySelectorAll('.claim-buttons bingo-button')].map((button) => [button.textContent, button.hasAttribute('disabled')]))
    .to.deep.equal([['Línea', true], ['Bingo', true], ['Sorteo de empate', true]]);
  expect(rail.querySelector('[slot="footer"] #open-public')).not.to.equal(null, 'the public-window launch is pinned to the rail');
  expect(rail.querySelector('[slot="footer"] input#public-volume[type="range"]')).not.to.equal(null);
  expect(page.querySelector('#panel-settings label[for="theme-select"]').textContent).to.equal('Tema para ambas pantallas');
  for (const id of ['settings-name', 'settings-place', 'settings-date']) {
    const input = page.querySelector(`#panel-settings form#settings-form .settings-scroll input#${id}[required]`);
    expect(page.querySelector(`label[for="${id}"]`)).not.to.equal(null);
    expect(page.getElementById(input.getAttribute('aria-describedby')).classList.contains('field-error')).to.equal(true);
  }
  expect(page.querySelector('#settings-save').textContent).to.equal('Guardar cambios');
  expect(page.querySelector('#settings-form .settings-footer #settings-save[type="submit"]')).not.to.equal(null);
  const simulator = page.querySelector('#panel-settings figure.simulator iframe#public-simulator');
  expect([simulator.getAttribute('src'), simulator.hasAttribute('inert'), simulator.title])
    .to.deep.equal(['bingo-public://simulator/public.html', true, 'Simulador de la pantalla pública']);
  expect([...page.querySelectorAll('select#theme-select option')].map((option) => [option.value, option.textContent]))
    .to.deep.equal([['pixel-classic', 'Píxel clásico'], ['high-contrast', 'Alto contraste']]);
  expect(page.querySelector('bingo-status#theme-status')).not.to.equal(null);
  expect(page.querySelector('bingo-operator-summary#event-summary')).not.to.equal(null);
  expect(page.querySelector('bingo-call-history#called-numbers')).not.to.equal(null);
  for (const id of ['phase-status', 'event-status', 'public-status']) {
    expect(page.querySelector(`footer[slot="status"] bingo-status#${id}`)).not.to.equal(null, `${id} in the status bar`);
  }
  for (const id of ['open-public', 'move-public']) expect(page.querySelector(`bingo-button#${id}`)).not.to.equal(null);
  expect([...page.querySelectorAll('bingo-dialog')].map((dialog) => dialog.id)).to.deep.equal(['unsaved-dialog']);
  // No English operator copy remains in the page.
  const copy = [page.title, page.body.textContent, ...[...page.querySelectorAll('[label],[heading],[message],[title],[aria-label]')]
    .flatMap((element) => ['label', 'heading', 'message', 'title', 'aria-label'].map((name) => element.getAttribute(name) ?? ''))].join(' ');
  expect(copy).not.to.match(/\b(?:Operator|console|Current|event|Public|window|preview|Claims|prizes|implemented|Open|reopen|Move|display|Reload|Draw|number|Called|Remaining)\b/);
});

it('summary and history show ordered acknowledged values, preserve them through stale states, and remain presentation-only', async () => {
  const summary = await fixture(html`<bingo-operator-summary></bingo-operator-summary>`);
  const history = await fixture(html`<bingo-call-history></bingo-call-history>`);
  expect(summary.shadowRoot.textContent.replace(/\s+/g, ' ')).to.include('Quedan 90');
  expect(history.shadowRoot.textContent).to.include('Aún no hay bolas cantadas');
  history.calledNumbers = [90, 3, 1];
  summary.latest = 1;
  summary.count = 3;
  summary.remaining = 87;
  await Promise.all([history.updateComplete, summary.updateComplete]);
  expect([...history.shadowRoot.querySelectorAll('li bingo-number')].map((number) => number.value)).to.deep.equal([90, 3, 1]);
  expect(history.shadowRoot.querySelectorAll('li[aria-current="true"]')).to.have.length(1);
  expect(summary.shadowRoot.querySelector('bingo-number').value).to.equal(1);
  expect([...summary.shadowRoot.querySelectorAll('output')].map((output) => output.textContent)).to.deep.equal(['3', '87']);
  const status = await fixture(html`<bingo-status tone="warning" message="El historial puede estar desactualizado"></bingo-status>`);
  expect(status.shadowRoot.querySelector('[role="status"]').textContent).to.equal('El historial puede estar desactualizado');
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
  const main = document.importNode(page.querySelector('bingo-app-shell'), true);
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
    expect(status.message).to.equal('Cargando el evento');
    expect(phase.message).to.equal('Fase: esperando el estado del evento');
    resolveLoad({ ok: true, snapshot: { calledNumbers: [90, 3, 1], phase: 'checking_bingo',
      lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await history.updateComplete;
    expect(summary.remaining).to.equal(87);
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    expect(phase.message).to.equal('Fase: Comprobando bingo');
    await phase.updateComplete;
    expect(phase.shadowRoot.querySelector('[role="status"]').textContent).to.equal('Fase: Comprobando bingo');
    await expect(phase).to.be.accessible();
    await controls.updateComplete;
    expect(controls.digitalButton.disabled).to.equal(false);
    controls.digitalButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    expect(summary.remaining).to.equal(87);
    expect(status.tone).to.equal('warning');
    expect(error.message).to.equal('Se produjo un error. Recarga e inténtalo de nuevo.', 'unknown English errors never reach the operator');
    expect(error.hidden).to.equal(false);
    expect(phase.message).to.equal('Fase: Comprobando bingo');
    main.querySelector('#open-public').shadowRoot.querySelector('button').click();
    main.querySelector('#move-public').shadowRoot.querySelector('button').click();
    expect([openCount, moveCount]).to.deep.equal([1, 1]);
    publicUpdate(true);
    expect(main.querySelector('#public-status').hidden).to.equal(false);
    expect(main.querySelector('#public-status').message).to.match(/^Pantalla secundaria desconectada/);
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
    expect([status.message, state.message, save.disabled]).to.deep.equal(['Tema guardado: Alto contraste', 'Sin cambios pendientes.', true]);
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

it('bingo-tabs follows WAI-ARIA selection by pointer and keyboard with a roving tabindex', async () => {
  const root = await fixture(html`<div>
    <bingo-tabs label="Espacio de trabajo">
      <button role="tab" id="t1" aria-controls="p1" aria-selected="true">Eventos</button>
      <button role="tab" id="t2" aria-controls="p2" aria-selected="false">Configuración</button>
      <button role="tab" id="t3" aria-controls="p3" aria-selected="false">Bingo</button>
    </bingo-tabs>
    <bingo-tab-panel id="p1" aria-labelledby="t1">A</bingo-tab-panel>
    <bingo-tab-panel id="p2" aria-labelledby="t2" hidden>B</bingo-tab-panel>
    <bingo-tab-panel id="p3" aria-labelledby="t3" hidden>C</bingo-tab-panel></div>`);
  const tablist = root.querySelector('bingo-tabs');
  await tablist.updateComplete;
  expect([tablist.getAttribute('role'), tablist.getAttribute('aria-label')]).to.deep.equal(['tablist', 'Espacio de trabajo']);
  expect([...root.querySelectorAll('bingo-tab-panel')].map((panel) => [panel.getAttribute('role'), panel.tabIndex]))
    .to.deep.equal([['tabpanel', 0], ['tabpanel', 0], ['tabpanel', 0]]);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const changes = [];
  tablist.addEventListener('tab-change', (event) => changes.push(event.detail.id));
  const state = () => tabs.map((tab) => [tab.getAttribute('aria-selected'), tab.tabIndex,
    root.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden]);
  expect(state()).to.deep.equal([['true', 0, false], ['false', -1, true], ['false', -1, true]]);
  expect(getComputedStyle(root.querySelector('#p2')).display).to.equal('none');
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
  expect(changes).to.deep.equal(['t3', 't1', 't3', 't1', 't3']);
  tablist.request('t2');
  expect(state()[1]).to.deep.equal(['true', 0, false]);
  await expect(root).to.be.accessible();
});

it('bingo-tabs defers to canLeave: a veto (pointer or keyboard) keeps the tab and restores its focus', async () => {
  const root = await fixture(html`<div><bingo-tabs>
    <button role="tab" id="v1" aria-controls="vp1" aria-selected="true">Configuración</button>
    <button role="tab" id="v2" aria-controls="vp2" aria-selected="false">Bingo</button>
  </bingo-tabs><bingo-tab-panel id="vp1"></bingo-tab-panel><bingo-tab-panel id="vp2"></bingo-tab-panel></div>`);
  const tablist = root.querySelector('bingo-tabs');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  let answer = false;
  const asked = [];
  tablist.canLeave = async (current, next) => { asked.push(`${current.id}>${next.id}`); return answer; };
  tabs[1].focus();
  tabs[1].click();
  tabs[1].click();
  await settle();
  expect([tabs[0].getAttribute('aria-selected'), document.activeElement, asked]).to.deep.equal(['true', tabs[0], ['v1>v2']],
    'a pending decision ignores further requests');
  tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  expect([tabs[0].getAttribute('aria-selected'), document.activeElement]).to.deep.equal(['true', tabs[0]]);
  answer = true;
  tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  expect([tabs[1].getAttribute('aria-selected'), document.activeElement, root.querySelector('#vp1').hidden])
    .to.deep.equal(['true', tabs[1], true]);
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
    const banners = [main.querySelector('#active-event-banner')];
    const committedBanner = 'Evento activo: Verbena — 2026-08-15, Plaza';
    expect([name.value, place.value, date.value, name.disabled]).to.deep.equal(['Verbena', 'Plaza', '2026-08-15', false]);
    expect(banners.map((banner) => banner.message)).to.deep.equal([committedBanner]);
    expect(simulator.last('event')).to.deep.equal({ ok: true, eventChanged: true,
      snapshot: { calledNumbers: [4, 9], phase: 'drawing', lastTransitionAt: null } }, 'the simulator shows committed history');
    type(name, '  Gran Bingo ');
    type(date, '2026-09-01');
    await settle();
    expect(simulator.last('meta')).to.deep.equal({ name: 'Gran Bingo', date: '2026-09-01', place: 'Plaza' });
    expect(banners.map((banner) => banner.message)).to.deep.equal([committedBanner]);
    type(place, '   ');
    const placeError = main.querySelector('#settings-place-error');
    expect([place.getAttribute('aria-invalid'), placeError.hidden, placeError.textContent, save.disabled])
      .to.deep.equal(['true', false, 'Escribe un lugar de 1 a 120 caracteres.', true]);
    type(place, 'Plaza');
    expect([place.getAttribute('aria-invalid'), placeError.hidden, save.disabled]).to.deep.equal(['false', true, false]);
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
    expect(banners.map((banner) => [banner.message, banner.tone])).to.deep.equal([[saved, 'info']]);
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

it('Configuración keeps a scrolling control column with fixed actions beside a fitted 16:9 simulator', async () => {
  await setViewport({ width: 1400, height: 900 });
  const op = await loadOperator();
  try {
    const { main } = op;
    main.querySelector('#tab-settings').click();
    await frames();
    const controls = main.querySelector('.settings-controls');
    const scroller = main.querySelector('.settings-scroll');
    const actions = main.querySelector('.settings-actions');
    const viewport = main.querySelector('#simulator-viewport');
    const frame = main.querySelector('#public-simulator');
    let c = controls.getBoundingClientRect();
    let v = viewport.getBoundingClientRect();
    expect(v.left).to.be.at.least(c.right);
    expect(v.width).to.be.greaterThan(c.width);
    expect(Math.abs(v.width / v.height - 16 / 9)).to.be.lessThan(0.02);
    expect(v.bottom).to.be.at.most(main.querySelector('.simulator').getBoundingClientRect().bottom, 'the simulator fits its column');
    expect(Math.abs(frame.getBoundingClientRect().width - viewport.clientWidth)).to.be.lessThan(1, 'the 1920px page is scaled to fit');
    expect(getComputedStyle(scroller).overflowY).to.equal('auto');
    // Save/discard stay at the bottom of the control column however long the form grows.
    scroller.append(Object.assign(document.createElement('div'), { style: 'height: 3000px' }));
    await frames();
    expect(scroller.scrollHeight).to.be.greaterThan(scroller.clientHeight);
    expect(Math.abs(actions.getBoundingClientRect().bottom - c.bottom)).to.be.lessThan(16);
    expect(document.scrollingElement.scrollHeight).to.be.at.most(innerHeight);
    scroller.lastElementChild.remove();
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(viewport).getPropertyValue('--bingo-color-border').trim();
      document.body.append(probe);
      expect(getComputedStyle(viewport).borderTopColor).to.equal(getComputedStyle(probe).color);
      probe.remove();
      await expect(main.querySelector('#panel-settings')).to.be.accessible();
    }
    expect(getComputedStyle(main.querySelector('#settings-discard')).transitionDuration).to.equal('0s');
    // Narrow windows stack the columns and scroll inside the tab, never the document.
    await setViewport({ width: 600, height: 700 });
    await frames();
    c = controls.getBoundingClientRect();
    v = viewport.getBoundingClientRect();
    expect(v.top).to.be.at.least(c.bottom);
    expect(Math.abs(frame.getBoundingClientRect().width - viewport.clientWidth)).to.be.lessThan(1);
    expect(document.scrollingElement.scrollHeight).to.be.at.most(innerHeight);
    expect(document.scrollingElement.scrollWidth).to.be.at.most(innerWidth);
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});

it('the operator fills the whole window with no document scroll on every tab at desktop sizes', async () => {
  const op = await loadOperator();
  try {
    const { main } = op;
    const header = main.querySelector('header[slot="header"]');
    const status = main.querySelector('footer[slot="status"]');
    for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
      await setViewport({ width, height });
      for (const id of ['events', 'settings', 'bingo']) {
        main.querySelector(`#tab-${id}`).click();
        await frames();
        const where = `${id} at ${width}×${height}`;
        expect(document.scrollingElement.scrollHeight).to.be.at.most(innerHeight, where);
        expect(document.scrollingElement.scrollWidth).to.be.at.most(innerWidth, where);
        const shell = main.getBoundingClientRect();
        expect([shell.left, shell.top, shell.width, shell.height]).to.deep.equal([0, 0, width, height], where);
        const panel = main.querySelector(`#panel-${id}`).getBoundingClientRect();
        expect(panel.width).to.be.greaterThan(width - 40, `${where}: the tab uses the full window width`);
        expect(panel.top).to.be.at.least(header.getBoundingClientRect().bottom);
        expect(panel.bottom).to.be.at.most(status.getBoundingClientRect().top);
        expect(panel.height).to.be.greaterThan(height * 0.75, `${where}: the tab fills the window height`);
      }
      // Bingo: the dominant zone is much larger than the side rail, which sits on the right.
      const zone = main.querySelector('.board-zone').getBoundingClientRect();
      const rail = main.querySelector('bingo-side-rail').getBoundingClientRect();
      expect(rail.left).to.be.at.least(zone.right);
      expect(zone.width).to.be.greaterThan(rail.width * 2);
      expect(Math.abs(zone.height - rail.height)).to.be.lessThan(1);
      // Eventos: list and creation form side by side.
      main.querySelector('#tab-events').click();
      await frames();
      const [list, form] = [...main.querySelectorAll('.events-workspace > bingo-panel')].map((element) => element.getBoundingClientRect());
      expect(form.left).to.be.at.least(list.right);
      expect(Math.abs(list.top - form.top)).to.be.lessThan(1);
    }
    for (const theme of ['pixel-classic', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(header).getPropertyValue('--bingo-color-surface').trim();
      document.body.append(probe);
      expect(getComputedStyle(header).backgroundColor).to.equal(getComputedStyle(probe).color, `${theme} header surface`);
      probe.remove();
    }
    main.querySelector('#tab-bingo').click();
    await frames();
    await expect(main.querySelector('#panel-bingo')).to.be.accessible();
    await expect(header).to.be.accessible();
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});

it('a long event list scrolls inside its panel, never the document', async () => {
  await setViewport({ width: 1280, height: 720 });
  const op = await loadOperator();
  try {
    const list = op.main.querySelector('#event-list');
    list.events = Array.from({ length: 60 }, (_, index) => ({ id: `e${index}`, name: `Evento ${index}`, date: '2026-10-01',
      place: 'Sala', phase: 'drawing', active: index === 0 }));
    await list.updateComplete;
    await frames();
    const panelHost = op.main.querySelector('.events-workspace > bingo-panel');
    const body = panelHost.shadowRoot.querySelector('.body');
    expect(getComputedStyle(body).overflowY).to.equal('auto');
    expect(body.scrollHeight).to.be.greaterThan(body.clientHeight);
    expect(document.scrollingElement.scrollHeight).to.be.at.most(innerHeight);
    // The panel itself (and its scrolling body) must stay physically bounded within the tab's
    // viewport: a long list may never inflate the panel past the space the tab grants it.
    const tabPanel = op.main.querySelector('#panel-events').getBoundingClientRect();
    const panelRect = panelHost.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    expect(panelRect.bottom).to.be.at.most(tabPanel.bottom + 1);
    expect(bodyRect.bottom).to.be.at.most(tabPanel.bottom + 1);
    // Every row, including the last, must be reachable by scrolling the body — not stranded below
    // the panel's own overflowing bounds.
    body.scrollTop = body.scrollHeight;
    await frames();
    const rows = [...list.shadowRoot.querySelectorAll('li')];
    const lastRow = rows[rows.length - 1];
    expect(lastRow, 'a rendered row for the 60th event').to.exist;
    expect(lastRow.textContent).to.include('Evento 59');
    const rowRect = lastRow.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    expect(rowRect.bottom).to.be.at.most(bodyBounds.bottom + 1);
    expect(rowRect.top).to.be.at.least(bodyBounds.top - 1);
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});
