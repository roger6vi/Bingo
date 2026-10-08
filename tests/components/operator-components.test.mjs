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
import '../../src/components/bingo-operator-board.mjs';
import { sendKeys, setViewport } from '@web/test-runner-commands';
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
async function loadOperator(options = {}) {
  const page = new DOMParser().parseFromString(await (await fetch(new URL('../../src/operator.html', import.meta.url))).text(), 'text/html');
  const main = document.importNode(page.querySelector('bingo-app-shell'), true);
  // Browser-only tests cannot resolve Electron's local simulator protocol; keep its message sink inert.
  main.querySelector('#public-simulator').src = 'about:blank';
  main.querySelector('#public-simulator').removeAttribute('sandbox');
  document.body.append(main);
  const links = await Promise.all(['jules', 'light', 'high-contrast']
    .map((name) => stylesheet(new URL(`../../src/generated/${name}.css`, import.meta.url).href)));
  const screen = document.createElement('style');
  screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  document.head.append(screen);
  const requests = [];
  const replies = { getCurrentEvent: null, setTheme: null, updateEvent: null, drawManual: null, playTongo: null, getPrizes: null, updatePrizes: null };
  const reads = { prizes: 0, line: 0, event: 0, legacy: 0 };
  // Line-lot boundary: unavailable and refusing draws unless a test scripts it; logged apart from the other requests.
  const lot = { reads: 0, draws: [], presents: [], status: null, read: async () => ({ ok: false, code: 'not_available' }),
    draw: async () => ({ ok: false, code: 'not_available' }), present: async () => ({ ok: true }), ...options.lot };
  // First-line boundary: the default is an idle main; a test replaces a reply to script another state.
  const lineSession = { sessionId: 's1', eventId: 'a', calledNumbers: [4, 9], linePrize: { amount: 10, lot: 'Jam\u00f3n' } };
  const lineAward = (winnerCount) => ({ eventId: 'a', award: { winnerCount, totalCents: 1000, shareCents: Math.floor(1000 / winnerCount),
    remainderCents: 1000 % winnerCount, lot: 'Jam\u00f3n', lotResolution: winnerCount > 1 ? 'pending' : 'not_required' },
  presentation: { id: 'p', status: 'pending', startedAt: null, deadlineAt: null } });
  const line = { read: async () => ({ ok: true, state: 'none' }), begin: async () => ({ ok: true, session: lineSession }),
    cancel: async () => ({ ok: true }), confirm: async (count) => ({ ok: true, award: lineAward(count) }), session: lineSession,
    retry: async () => ({ ok: false, message: 'unexpected' }), repeat: async () => ({ ok: false, message: 'unexpected' }), push: null, ...options.line };
  // Legacy checking_line boundary: nothing to cancel unless a test scripts a held check.
  const legacy = { read: async () => ({ ok: false, code: 'not_available', message: 'There is no line check to cancel.' }),
    cancel: async () => ({ ok: true, state: 'recovered' }), ...options.legacy };
  let theme = 'jules';
  const prizes = { a: { line: { amount: 150, lot: 'Jam\u00f3n' }, bingo: { amount: 0, lot: '' } } };
  const activeId = () => events.find((event) => event.active).id;
  const none = { line: { amount: 0, lot: '' }, bingo: { amount: 0, lot: '' } };
  let events = [
    { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', phase: 'drawing', createdAt: '2026-01-01T00:00:00.000Z', active: true },
    { id: 'b', name: 'Fiesta', date: '2026-10-01', place: 'Sala', phase: 'drawing', createdAt: '2026-01-02T00:00:00.000Z', active: false },
  ];
  const list = () => ({ ok: true, events: events.map((event) => ({ ...event })) });
  window.desktop = {
    getCurrentEvent: async () => {
      reads.event++;
      return replies.getCurrentEvent ? replies.getCurrentEvent() : { ok: true, snapshot: { calledNumbers: [4, 9], phase: 'drawing', lastTransitionAt: null } };
    },
    drawManual: async (number) => {
      requests.push('draw');
      return replies.drawManual ? replies.drawManual(number) : { ok: false, message: 'unexpected' };
    },
    drawDigital: async () => { requests.push('draw'); return { ok: false, message: 'unexpected' }; },
    playTongo: async () => {
      requests.push('tongo');
      return replies.playTongo ? replies.playTongo()
        : { ok: false, code: 'public_unavailable', message: 'Open the public window, then try Tongo again.' };
    },
    readLineSetup: async () => { reads.line++; return line.read(); },
    beginLineSetup: async () => { requests.push('line:begin'); return line.begin(); },
    cancelLineSetup: async (id, eventId) => { requests.push(`line:cancel:${id}:${eventId}`); return line.cancel(); },
    confirmLine: async (id, eventId, count) => { requests.push(`line:confirm:${id}:${eventId}:${count}`); return line.confirm(count); },
    retryLinePresentation: async (id) => { requests.push(`line:retry:${id}`); return line.retry(id); },
    repeatLinePresentation: async (id) => { requests.push(`line:repeat:${id}`); return line.repeat(id); },
    readLegacyLineCheck: async () => { reads.legacy++; return legacy.read(); },
    cancelLegacyLineCheck: async (eventId, sequence, head) => { requests.push(`legacy:cancel:${eventId}:${sequence}:${head}`); return legacy.cancel(); },
    onLinePresentation: (callback) => { line.push = callback; return () => { line.push = null; }; },
    readLineLot: async () => { lot.reads++; return lot.read(); },
    drawLineLot: async (expected) => { lot.draws.push(expected); return lot.draw(expected); },
    // Private presentation request, recorded apart from draws; `omitPresent` scripts a desktop without the method.
    ...(lot.omitPresent ? {} : { presentLineLot: (snapshot) => { lot.presents.push(snapshot); return lot.present(snapshot); } }),
    onPublicStatus: (callback) => { lot.status = callback; }, openPublic: () => {}, movePublicToSecondary: () => {},
    getTheme: async () => ({ ok: true, theme }),
    setTheme: async (next) => {
      requests.push(`theme:${next}`);
      if (replies.setTheme) return replies.setTheme;
      theme = next;
      return { ok: true, theme };
    },
    listEvents: async () => list(),
    createEvent: async () => (options.createEvent ? options.createEvent() : list()),
    selectEvent: async (id) => {
      requests.push(`select:${id}`);
      events = events.map((event) => ({ ...event, active: event.id === id }));
      return list();
    },
    // Reads are counted apart from writes, so write-only request assertions stay unchanged.
    getPrizes: async () => {
      reads.prizes++;
      if (replies.getPrizes) return replies.getPrizes;
      return { ok: true, eventId: activeId(), prizes: structuredClone(prizes[activeId()] ?? none) };
    },
    updatePrizes: async (id, next) => {
      requests.push(`prizes:update:${id}:${JSON.stringify(next)}`);
      if (replies.updatePrizes) return replies.updatePrizes;
      prizes[id] = structuredClone(next);
      return { ok: true, eventId: id, prizes: structuredClone(next) };
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
    window.dispatchEvent(new Event('pagehide'));
    main.remove();
    links.forEach((link) => link.remove());
    screen.remove();
    delete window.desktop;
    delete document.documentElement.dataset.theme;
  };
  return { main, requests, replies, reads, line, legacy, lot, simulator, cleanup };
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
  // Every operator form control is a shared component; no raw text, date or select controls remain,
  // except the one deliberate native volume slider in the rail.
  expect(page.querySelectorAll('main input, main select, main textarea')).to.have.length(3);
  expect(page.querySelector('main input#cue-mute[type="checkbox"]')).not.to.equal(null);
  expect(page.querySelector('main input#cue-volume[type="range"]')).not.to.equal(null);
  expect(page.querySelector('main input#cue-test[type="button"]')).not.to.equal(null);
  expect(page.querySelectorAll('main form button')).to.have.length(0);
  expect(page.querySelector('#panel-events form#create-event bingo-date-field#event-date[name="date"][required]')).not.to.equal(null);
  for (const [id, name] of [['event-name', 'name'], ['event-place', 'place']]) {
    const field = page.querySelector(`#panel-events form#create-event bingo-text-field#${id}`);
    expect([field.getAttribute('name'), field.hasAttribute('required'), field.getAttribute('maxlength')]).to.deep.equal([name, true, '120']);
  }
  expect(page.querySelector('#create-event bingo-form-actions bingo-button#create-event-submit[type="submit"][slot="primary"]').textContent)
    .to.equal('Crear evento');
  // Bingo: the dominant zone beside a side rail with draw, claim, and public-window controls.
  expect(page.querySelector('#panel-bingo .bingo-workspace > bingo-panel.board-zone > bingo-operator-board#operator-board'))
    .not.to.equal(null, 'the 1–90 board is the dominant zone');
  const rail = page.querySelector('#panel-bingo .bingo-workspace > bingo-side-rail');
  expect(rail.getAttribute('label')).to.equal('Controles de la partida');
  expect(rail.querySelector('bingo-draw-controls#draw-controls')).not.to.equal(null);
  expect([...rail.querySelectorAll('.claim-buttons bingo-button')].map((button) => [button.textContent, button.hasAttribute('disabled')]))
    .to.deep.equal([['Línea', false], ['Bingo', true], ['Sorteo de empate', true]]);
  expect(rail.querySelector('[slot="footer"] #open-public')).not.to.equal(null, 'the public-window launch is pinned to the rail');
  expect(rail.querySelector('[slot="footer"] input#cue-mute[type="checkbox"]')).not.to.equal(null);
  expect(rail.querySelector('[slot="footer"] input#cue-volume[type="range"]')).not.to.equal(null);
  expect(rail.querySelector('[slot="footer"] input#cue-test[type="button"]')).not.to.equal(null);
  expect(page.querySelector('#panel-settings bingo-select-field#theme-select').getAttribute('label')).to.equal('Tema para ambas pantallas');
  for (const [id, tag, label] of [['settings-name', 'bingo-text-field', 'Nombre'], ['settings-place', 'bingo-text-field', 'Lugar'],
    ['settings-date', 'bingo-date-field', 'Fecha']]) {
    const field = page.querySelector(`#panel-settings form#settings-form .settings-scroll ${tag}#${id}[required][disabled]`);
    expect(field.getAttribute('label')).to.equal(label);
  }
  expect(page.querySelector('#settings-save').textContent).to.equal('Guardar cambios');
  expect(page.querySelector('#settings-form .settings-footer #settings-save[type="submit"]')).not.to.equal(null);
  // Actions keep one order: status first, secondary, then the primary action last.
  expect([...page.querySelector('bingo-form-actions#settings-actions').children].map((child) => [child.id, child.slot]))
    .to.deep.equal([['settings-state', 'status'], ['settings-discard', ''], ['settings-save', 'primary']]);
  const simulator = page.querySelector('#panel-settings figure.simulator iframe#public-simulator');
  expect([simulator.getAttribute('src'), simulator.hasAttribute('inert'), simulator.title])
    .to.deep.equal(['bingo-public://simulator/public.html', true, 'Simulador de la pantalla pública']);
  expect([...page.querySelectorAll('bingo-select-field#theme-select option')].map((option) => [option.value, option.textContent]))
    .to.deep.equal([['jules', 'Jules'], ['light', 'Claro'], ['high-contrast', 'Alto contraste']]);
  expect(page.querySelector('bingo-status#theme-status')).not.to.equal(null);
  // Premios: two fieldsets (Línea, Bingo), each a shared text field for money and one for the lot.
  const prizePanel = page.querySelector('#panel-settings form#settings-form .settings-scroll bingo-panel[heading="Premios"]');
  expect(prizePanel).not.to.equal(null);
  expect([...prizePanel.querySelectorAll('fieldset.prize-fieldset legend')].map((legend) => legend.textContent))
    .to.deep.equal(['Línea', 'Bingo']);
  for (const [id, label] of [['settings-line-amount', 'Dinero (euros enteros)'], ['settings-line-lot', 'Lote'],
    ['settings-bingo-amount', 'Dinero (euros enteros)'], ['settings-bingo-lot', 'Lote']]) {
    const field = prizePanel.querySelector(`bingo-text-field#${id}[disabled]`);
    expect(field.getAttribute('label'), id).to.equal(label);
  }
  expect(prizePanel.querySelector('bingo-status#prizes-status')).not.to.equal(null);
  expect(page.querySelector('bingo-operator-summary#event-summary')).not.to.equal(null);
  expect(page.querySelector('bingo-side-rail bingo-call-history#called-numbers.last-calls[limit="8"]'))
    .not.to.equal(null, 'a compact last-calls strip in the side rail');
  for (const id of ['phase-status', 'event-status', 'public-status']) {
    expect(page.querySelector(`footer[slot="status"] bingo-status#${id}`)).not.to.equal(null, `${id} in the status bar`);
  }
  for (const id of ['open-public', 'move-public']) expect(page.querySelector(`bingo-button#${id}`)).not.to.equal(null);
  expect([...page.querySelectorAll('bingo-dialog')].map((dialog) => dialog.id)).to.deep.equal(['unsaved-dialog', 'line-dialog', 'legacy-dialog']);
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
  const links = await Promise.all(['jules', 'light', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  // Paint the themed canvas behind the fixture, as screen.css does for the page: jules' light text
  // only meets contrast against its own dark canvas, not the browser's default white background.
  document.body.style.background = 'var(--bingo-color-canvas)';
  try {
    for (const theme of ['jules', 'light', 'high-contrast']) {
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
    document.body.style.removeProperty('background');
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
  const links = await Promise.all(['jules', 'light', 'high-contrast'].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  try {
    for (const theme of ['jules', 'light', 'high-contrast']) {
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
    getTheme: async () => ({ ok: true, theme: 'jules' }),
    setTheme: async () => ({ ok: false, message: 'Write failed' }),
    // An unreadable line state now keeps drawing locked, so this wiring test supplies an idle main.
    readLineSetup: async () => ({ ok: true, state: 'none' }),
    onLinePresentation: () => () => {},
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
    expect(status.message).to.equal('Actualizando el evento');
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
    controls.modeInput('digital').click();
    await controls.updateComplete;
    expect(main.querySelector('#operator-board').readonly).to.equal(true, 'digital mode makes the board read-only');
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
    expect([root.dataset.theme, select.disabled, save.disabled]).to.deep.equal(['jules', false, true]);
    const canvas = () => getComputedStyle(root).getPropertyValue('--bingo-color-canvas').trim();
    const classic = canvas();
    select.value = 'high-contrast';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(root.dataset.theme).to.equal('jules', 'a draft never restyles the operator or the public window');
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
    select.value = 'light';
    select.dispatchEvent(new Event('change'));
    save.click();
    await settle();
    expect(requests).to.deep.equal(['theme:high-contrast', 'theme:light']);
    expect([root.dataset.theme, select.value]).to.deep.equal(['high-contrast', 'light'], 'the failed draft is kept');
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
    const committedBanner = 'Verbena — 2026-08-15, Plaza';
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
    const saved = 'Gran Bingo — 2026-09-01, Plaza';
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
    for (const theme of ['jules', 'light', 'high-contrast']) {
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

it('the Configuraci\u00f3n scroller stays reachable by keyboard when every field is disabled, across themes', async () => {
  // Regression: with no active event (or any other state where every field is disabled), the
  // scrolling control column had no focusable descendant left inside it, so axe's
  // scrollable-region-focusable rule failed \u2014 a keyboard user could not reach the overflowing
  // content at all. The scroller itself must stay in the tab order regardless of field state.
  await setViewport({ width: 1280, height: 500 });
  const op = await loadOperator();
  try {
    const { main } = op;
    main.querySelector('#tab-settings').click();
    await frames();
    const scroller = main.querySelector('.settings-scroll');
    expect(scroller.getAttribute('tabindex')).to.equal('0');
    for (const field of scroller.querySelectorAll('bingo-text-field, bingo-date-field, bingo-select-field')) field.disabled = true;
    await frames();
    expect(scroller.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')).to.have.length(0,
      'nothing inside the scroller can be reached except the scroller itself');
    expect(scroller.scrollHeight).to.be.greaterThan(scroller.clientHeight, 'the panel content still overflows');
    scroller.focus();
    expect(document.activeElement).to.equal(scroller, 'the scroller is reachable and focusable by keyboard');
    for (const theme of ['jules', 'light', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      await expect(main.querySelector('#panel-settings')).to.be.accessible();
    }
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
    for (const theme of ['jules', 'light', 'high-contrast']) {
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

const cells = (board) => [...board.shadowRoot.querySelectorAll('.cell')];
const cellOf = (board, number) => board.shadowRoot.querySelector(`[data-number="${number}"]`);
const themeLinks = () => Promise.all(['jules', 'light', 'high-contrast']
  .map((name) => stylesheet(new URL(`../../src/generated/${name}.css`, import.meta.url).href)));

it('operator board lays out 1–90 in numeric rows with uncalled, called, latest and disabled states', async () => {
  const board = await fixture(html`<bingo-operator-board style="height: 540px; width: 720px"></bingo-operator-board>`);
  const rows = [...board.shadowRoot.querySelectorAll('[role="row"]')];
  expect(rows).to.have.length(9);
  expect(rows.map((row) => [...row.querySelectorAll('.cell')].map((cell) => Number(cell.dataset.number))))
    .to.deep.equal(Array.from({ length: 9 }, (_, row) => Array.from({ length: 10 }, (__, column) => row * 10 + column + 1)));
  // Before the committed snapshot arrives every number is disabled and nothing is callable.
  expect(new Set(cells(board).map((cell) => cell.dataset.state))).to.deep.equal(new Set(['disabled']));
  expect(board.shadowRoot.querySelector('.state').textContent).to.equal('Esperando el evento');
  board.loaded = true;
  board.calledNumbers = [90, 3, 42];
  await board.updateComplete;
  const state = (number) => cellOf(board, number).dataset.state;
  expect([state(1), state(3), state(90), state(42)]).to.deep.equal(['uncalled', 'called', 'called', 'latest']);
  expect([cellOf(board, 1), cellOf(board, 3), cellOf(board, 42)].map((cell) => cell.getAttribute('aria-label')))
    .to.deep.equal(['Número 1, sin cantar', 'Número 3, cantado', 'Número 42, última bola cantada']);
  // The latest marker does not rely on color alone: it carries a text badge and a ring.
  expect(cellOf(board, 42).querySelector('.badge').textContent).to.equal('Última');
  expect(board.shadowRoot.querySelectorAll('.badge')).to.have.length(1);
  expect([cellOf(board, 3), cellOf(board, 42)].every((cell) => cell.getAttribute('aria-disabled') === 'true')).to.equal(true);
  expect(cellOf(board, 1).hasAttribute('aria-disabled')).to.equal(false);
  board.disabled = true;
  await board.updateComplete;
  expect([state(1), state(3), state(42)]).to.deep.equal(['disabled', 'called', 'latest']);
  expect(cellOf(board, 1).getAttribute('aria-disabled')).to.equal('true');
  expect(board.shadowRoot.querySelector('[role="grid"]').getAttribute('aria-readonly')).to.equal('true');
  const links = await themeLinks();
  try {
    for (const theme of ['jules', 'light', 'high-contrast']) {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(board).getPropertyValue('--bingo-color-call-called-surface').trim();
      document.body.append(probe);
      expect(getComputedStyle(cellOf(board, 3)).backgroundColor).to.equal(getComputedStyle(probe).color, `${theme} called cell`);
      expect(getComputedStyle(cellOf(board, 42)).outlineStyle).to.equal('solid', `${theme} latest ring`);
      const swatch = (name) => getComputedStyle(board.shadowRoot.querySelector(`.swatch.${name}`)).backgroundColor;
      expect([swatch('called'), swatch('latest')], `${theme} legend matches the cells`)
        .to.deep.equal([getComputedStyle(cellOf(board, 3)).backgroundColor, getComputedStyle(cellOf(board, 42)).backgroundColor]);
      probe.remove();
      await expect(board).to.be.accessible();
    }
  } finally {
    delete document.documentElement.dataset.theme;
    links.forEach((link) => link.remove());
  }
});

it('operator board supports arrow-key grid navigation and Enter/Space calling in manual mode', async () => {
  const board = await fixture(html`<bingo-operator-board style="height: 540px; width: 720px"></bingo-operator-board>`);
  board.loaded = true;
  board.calledNumbers = [5];
  await board.updateComplete;
  const chosen = [];
  board.addEventListener('number-select', (event) => chosen.push(event.detail.number));
  expect(cells(board).filter((cell) => cell.tabIndex === 0).map((cell) => cell.dataset.number)).to.deep.equal(['1'], 'one tab stop');
  cellOf(board, 1).focus();
  const focused = () => Number(board.shadowRoot.activeElement?.dataset.number);
  const press = async (key) => { await sendKeys({ press: key }); await board.updateComplete; };
  await press('ArrowRight');
  expect(focused()).to.equal(2);
  await press('ArrowDown');
  expect(focused()).to.equal(12);
  await press('End');
  expect(focused()).to.equal(20);
  await press('Home');
  expect(focused()).to.equal(11);
  await press('PageDown');
  expect(focused()).to.equal(81);
  await press('ArrowDown');
  expect(focused()).to.equal(81, 'navigation stops at the edge');
  await press('Control+End');
  expect(focused()).to.equal(90);
  await press('PageUp');
  expect(focused()).to.equal(10);
  expect(cells(board).filter((cell) => cell.tabIndex === 0).map((cell) => cell.dataset.number)).to.deep.equal(['10']);
  await press('Enter');
  expect(chosen).to.deep.equal([10]);
  await press('ArrowLeft');
  await press('ArrowLeft');
  await press('ArrowLeft');
  await press('ArrowLeft');
  await press('ArrowLeft');
  expect(focused()).to.equal(5);
  await press('Space');
  expect(chosen).to.deep.equal([10], 'an already-called number is inert');
  await press('ArrowRight');
  await press('Space');
  expect(chosen).to.deep.equal([10, 6]);
});

it('operator board calls only uncalled numbers in manual mode and is read-only in digital mode', async () => {
  const board = await fixture(html`<bingo-operator-board style="height: 540px; width: 720px"></bingo-operator-board>`);
  board.loaded = true;
  board.calledNumbers = [7];
  await board.updateComplete;
  const chosen = [];
  board.addEventListener('number-select', (event) => chosen.push(event.detail.number));
  cellOf(board, 7).click();
  expect(chosen).to.deep.equal([]);
  cellOf(board, 8).click();
  expect(chosen).to.deep.equal([8]);
  // Pending: the request is marked on its cell but never shown as called, and the board is inert.
  board.pending = true;
  await board.updateComplete;
  expect([cellOf(board, 8).dataset.state, cellOf(board, 8).hasAttribute('data-pending'), cellOf(board, 8).getAttribute('aria-label')])
    .to.deep.equal(['uncalled', true, 'Número 8, cantándose']);
  expect(board.shadowRoot.querySelector('[role="grid"]').getAttribute('aria-busy')).to.equal('true');
  cellOf(board, 9).click();
  expect(chosen).to.deep.equal([8]);
  board.pending = false;
  await board.updateComplete;
  expect(cellOf(board, 8).hasAttribute('data-pending')).to.equal(false);
  board.readonly = true;
  await board.updateComplete;
  cellOf(board, 9).click();
  expect(chosen).to.deep.equal([8]);
  expect(cells(board).every((cell) => cell.getAttribute('aria-disabled') === 'true')).to.equal(true);
  expect(board.shadowRoot.querySelector('.state').textContent).to.equal('Solo lectura (modo digital)');
  expect(cells(board).filter((cell) => cell.tabIndex === 0)).to.have.length(1, 'read-only numbers stay reachable by keyboard');
  board.stale = true;
  await board.updateComplete;
  expect(board.shadowRoot.querySelector('.state').textContent).to.equal('Puede estar desactualizado');
  const links = await themeLinks();
  try {
    document.documentElement.dataset.theme = 'high-contrast';
    expect(getComputedStyle(board.shadowRoot.querySelector('.board')).outlineStyle).to.equal('dashed');
    await expect(board).to.be.accessible();
  } finally {
    delete document.documentElement.dataset.theme;
    links.forEach((link) => link.remove());
  }
});

it('operator board announces each newly committed latest call once and respects reduced motion', async () => {
  const board = await fixture(html`<bingo-operator-board style="height: 540px; width: 720px"></bingo-operator-board>`);
  const live = board.shadowRoot.querySelector('[aria-live="polite"]');
  board.loaded = true;
  board.calledNumbers = [12, 34];
  await board.updateComplete;
  expect(live.textContent).to.equal('', 'the history present on load is not announced');
  board.calledNumbers = [12, 34, 56];
  await board.updateComplete;
  expect(live.textContent).to.equal('Última bola cantada: 56');
  board.calledNumbers = [12, 34, 56];
  board.stale = true;
  await board.updateComplete;
  expect(live.textContent).to.equal('Última bola cantada: 56');
  expect(board.shadowRoot.querySelectorAll('[aria-live]')).to.have.length(1);
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).to.equal(true);
  expect(getComputedStyle(cellOf(board, 56)).animationName).to.equal('none');
  expect(getComputedStyle(cellOf(board, 1)).transitionDuration).to.equal('0s');
});

it('the Bingo tab calls a board number through the manual draw IPC and shows it only once committed', async () => {
  await setViewport({ width: 1280, height: 720 });
  const op = await loadOperator();
  try {
    const { main, requests, replies } = op;
    main.querySelector('#tab-bingo').click();
    const board = main.querySelector('#operator-board');
    await board.updateComplete;
    expect(board.calledNumbers).to.deep.equal([4, 9]);
    expect([cellOf(board, 9).dataset.state, board.readonly]).to.deep.equal(['latest', false]);
    let acknowledge;
    const drawn = [];
    replies.drawManual = (number) => { drawn.push(number); return new Promise((resolve) => { acknowledge = resolve; }); };
    cellOf(board, 42).click();
    await board.updateComplete;
    expect(drawn).to.deep.equal([42]);
    expect([cellOf(board, 42).dataset.state, board.pending, cellOf(board, 42).hasAttribute('data-pending')])
      .to.deep.equal(['uncalled', true, true], 'never shown as called before the acknowledgement');
    cellOf(board, 43).click();
    expect(drawn).to.deep.equal([42], 'one request at a time');
    acknowledge({ ok: true, snapshot: { calledNumbers: [4, 9, 42], phase: 'drawing', lastTransitionAt: null } });
    await settle();
    await board.updateComplete;
    expect([cellOf(board, 42).dataset.state, cellOf(board, 9).dataset.state, board.pending]).to.deep.equal(['latest', 'called', false]);
    expect(main.querySelector('#event-summary').latest).to.equal(42);
    const strip = main.querySelector('#called-numbers');
    await strip.updateComplete;
    expect([...strip.shadowRoot.querySelectorAll('li')].map((item) => item.textContent.trim())).to.deep.equal(['4', '9', '42']);
    // A rejected draw keeps the committed board, marks it stale and explains in Spanish.
    replies.drawManual = async () => ({ ok: false, code: 'duplicate', message: 'That number has already been called.' });
    cellOf(board, 50).click();
    await settle();
    await board.updateComplete;
    expect([cellOf(board, 50).dataset.state, board.stale, board.calledNumbers]).to.deep.equal(['uncalled', true, [4, 9, 42]]);
    expect(main.querySelector('#event-error').message).to.equal('Ese número ya se ha cantado.');
    // Digital mode: the board is read-only and never requests a draw.
    const controls = main.querySelector('#draw-controls');
    controls.modeInput('digital').click();
    await board.updateComplete;
    const before = requests.length;
    cellOf(board, 60).click();
    await settle();
    expect([board.readonly, requests.length]).to.deep.equal([true, before]);
    expect(controls.shadowRoot.querySelector('#draw-digital').closest('[hidden]')).to.equal(null, 'the digital control is shown');
    expect(controls.shadowRoot.querySelector('#draw-manual').closest('[hidden]')).not.to.equal(null);
    // Readable at 1280×720, inside the dominant zone, with no rail or document scroll.
    const zone = main.querySelector('.board-zone').getBoundingClientRect();
    const grid = board.shadowRoot.querySelector('[role="grid"]').getBoundingClientRect();
    expect(grid.bottom).to.be.at.most(zone.bottom);
    expect(grid.right).to.be.at.most(zone.right);
    const cell = cellOf(board, 1).getBoundingClientRect();
    expect(cell.height).to.be.at.least(44);
    expect(cell.width).to.be.at.least(cell.height);
    expect(parseFloat(getComputedStyle(cellOf(board, 1)).fontSize)).to.be.at.least(20);
    const rail = main.querySelector('bingo-side-rail').shadowRoot.querySelector('.body');
    expect(rail.scrollHeight).to.be.at.most(rail.clientHeight, 'the rail fits at 1280×720');
    expect(document.scrollingElement.scrollHeight).to.be.at.most(innerHeight);
    await expect(main.querySelector('#panel-bingo')).to.be.accessible();
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});

it('the Bingo tab plays Tongo once from the claims rail, locking every live action until it ends', async () => {
  await setViewport({ width: 1280, height: 720 });
  const op = await loadOperator();
  try {
    const { main, requests, replies } = op;
    main.querySelector('#tab-bingo').click();
    const board = main.querySelector('#operator-board');
    const controls = main.querySelector('#draw-controls');
    const control = main.querySelector('bingo-side-rail .claim-buttons > bingo-tongo-control#tongo-control');
    expect(control).not.to.equal(null, 'Tongo sits with the claims in the rail');
    const tongoError = main.querySelector('.rail-section bingo-status#tongo-error');
    await settle();
    await control.updateComplete;
    expect(control.disabled).to.equal(false, 'offered while the fresh event is drawing');
    const rail = main.querySelector('bingo-side-rail').shadowRoot.querySelector('.body');
    expect(rail.scrollHeight).to.be.at.most(rail.clientHeight, 'the rail still fits at 1280×720');
    // A refusal explains in Spanish and plays nothing.
    control.button.click();
    await settle();
    await control.updateComplete;
    expect(requests.filter((request) => request === 'tongo')).to.have.length(1);
    expect([tongoError.hidden, tongoError.tone, tongoError.message])
      .to.deep.equal([false, 'error', 'Abre la pantalla pública y vuelve a intentar el Tongo.']);
    await frames();
    expect(tongoError.getBoundingClientRect().bottom).to.be.at.most(rail.getBoundingClientRect().bottom + 1,
      'the whole refusal is visible in the rail');
    expect([control.progress, control.disabled, board.disabled]).to.deep.equal([null, false, false]);
    // An acknowledged Tongo locks draws, the board, reload, event selection and settings until it ends.
    let acknowledge;
    replies.playTongo = () => new Promise((resolve) => { acknowledge = resolve; });
    control.button.click();
    await settle();
    control.button.click();
    await settle();
    expect(requests.filter((request) => request === 'tongo')).to.have.length(2, 'one request at a time');
    expect([control.disabled, board.disabled, controls.manualDisabled, controls.reloadDisabled,
      main.querySelector('#event-list').disabled]).to.deep.equal([true, true, true, true, true]);
    acknowledge({ ok: true, presentation: { kind: 'tongo', id: 1, durationMs: 500 } });
    await settle();
    await control.updateComplete;
    expect(control.shadowRoot.querySelector('progress')).not.to.equal(null);
    expect(tongoError.hidden).to.equal(true, 'a new request clears the last refusal');
    await frames();
    expect(rail.scrollHeight).to.be.at.most(rail.clientHeight, 'the rail still fits while Tongo plays');
    const draws = requests.filter((request) => request === 'draw').length;
    cellOf(board, 50).click();
    await settle();
    expect(requests.filter((request) => request === 'draw')).to.have.length(draws, 'no draw while Tongo plays');
    await expect(main.querySelector('#panel-bingo')).to.be.accessible();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await control.updateComplete;
    expect([control.progress, control.disabled, board.disabled, controls.manualDisabled,
      main.querySelector('#event-list').disabled]).to.deep.equal([null, false, false, false, false]);
    expect(board.calledNumbers).to.deep.equal([4, 9], 'Tongo never changes the game');
  } finally {
    op.cleanup();
    await setViewport({ width: 800, height: 600 });
  }
});

it('prizes draft into the simulator, validate like the store, and save only the active event through the operator IPC', async () => {
  const op = await loadOperator();
  try {
    const { main, requests, simulator } = op;
    const field = (id) => main.querySelector(`#settings-${id}`);
    const save = main.querySelector('#settings-save');
    expect(['line-amount', 'line-lot', 'bingo-amount', 'bingo-lot'].map((id) => [field(id).value, field(id).disabled]))
      .to.deep.equal([['150', false], ['Jamón', false], ['', false], ['', false]]);
    expect(simulator.last('prizes')).to.deep.equal({ line: { amount: 150, lot: 'Jamón' }, bingo: { amount: 0, lot: '' } });
    type(field('bingo-amount'), '12,50');
    await field('bingo-amount').updateComplete;
    expect([field('bingo-amount').error, save.disabled]).to.deep.equal(['Escribe un importe en euros enteros, de 0 a 100 000.', true]);
    expect(simulator.last('prizes').bingo).to.deep.equal({ amount: 0, lot: '' }, 'an invalid prize previews its committed value');
    type(field('bingo-amount'), '500');
    type(field('bingo-lot'), '  Cesta de Navidad ');
    await settle();
    expect(simulator.last('prizes')).to.deep.equal({ line: { amount: 150, lot: 'Jamón' }, bingo: { amount: 500, lot: 'Cesta de Navidad' } });
    expect(main.querySelector('#settings-state').message).to.equal('Cambios sin guardar: solo se ven en el simulador.');
    op.replies.updatePrizes = { ok: false, code: 'storage_failure', message: 'x' };
    save.click();
    await settle();
    const request = `prizes:update:a:${JSON.stringify({ line: { amount: 150, lot: 'Jamón' }, bingo: { amount: 500, lot: 'Cesta de Navidad' } })}`;
    expect(requests).to.deep.equal([request]);
    expect([field('bingo-amount').value, main.querySelector('#settings-error').message])
      .to.deep.equal(['500', 'No se guardaron los premios. Los cambios siguen en el borrador; inténtalo de nuevo.']);
    op.replies.updatePrizes = null;
    save.click();
    await settle();
    expect(requests).to.deep.equal([request, request]);
    expect([field('bingo-lot').value, main.querySelector('#settings-state').message, main.querySelector('#settings-error').hidden])
      .to.deep.equal(['Cesta de Navidad', 'Sin cambios pendientes.', true]);
    await expect(main.querySelector('#settings-form')).to.be.accessible();
  } finally { op.cleanup(); }
});

it('an unsaved prize edit is guarded like any other and the next event brings its own prizes', async () => {
  const op = await loadOperator();
  try {
    const { main, requests } = op;
    const dialog = main.querySelector('#unsaved-dialog');
    const lineAmount = main.querySelector('#settings-line-amount');
    main.querySelector('#tab-settings').click();
    type(lineAmount, '300');
    main.querySelector('#tab-bingo').click();
    await settle();
    expect(dialog.shadowRoot.querySelector('dialog').open).to.equal(true);
    dialog.shadowRoot.querySelector('[data-action="save"]').button.click();
    await settle();
    expect(main.querySelector('#tab-bingo').getAttribute('aria-selected')).to.equal('true');
    expect(requests.at(-1)).to.equal(`prizes:update:a:${JSON.stringify({ line: { amount: 300, lot: 'Jamón' }, bingo: { amount: 0, lot: '' } })}`);
    main.querySelector('#tab-settings').click();
    type(lineAmount, '999');
    main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    dialog.shadowRoot.querySelector('[data-action="discard"]').button.click();
    await settle();
    expect([lineAmount.value, main.querySelector('#settings-line-lot').value, op.simulator.last('prizes')])
      .to.deep.equal(['', '', { line: { amount: 0, lot: '' }, bingo: { amount: 0, lot: '' } }]);
    expect(requests.filter((request) => request.startsWith('prizes:update'))).to.have.length(1, 'the discarded 999 was never sent');
  } finally { op.cleanup(); }
});

it('prizes that cannot be read stay locked with an actionable message while the rest stays editable', async () => {
  const op = await loadOperator();
  try {
    const { main } = op;
    op.replies.getPrizes = { ok: false, code: 'storage_failure', message: 'Could not read the prizes. Try again.' };
    main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    const status = main.querySelector('#prizes-status');
    expect([status.hidden, status.message, status.tone]).to.deep.equal([false,
      'No se pudieron leer los premios guardados. Pulsa «Recargar eventos» en Eventos para reintentarlo.', 'error']);
    expect(['line-amount', 'line-lot', 'bingo-amount', 'bingo-lot'].map((id) => main.querySelector(`#settings-${id}`).disabled))
      .to.deep.equal([true, true, true, true]);
    expect([main.querySelector('#settings-name').disabled, op.simulator.last('prizes')]).to.deep.equal([false, null]);
    op.replies.getPrizes = null;
    main.querySelector('#reload-events').click();
    await settle();
    expect([status.hidden, main.querySelector('#settings-line-amount').disabled]).to.deep.equal([true, false]);
  } finally { op.cleanup(); }
});

it('a failed re-read locks previously read prizes with the visible error', async () => {
  const op = await loadOperator();
  try {
    const { main } = op;
    op.replies.getPrizes = { ok: true, eventId: 'a', prizes: { line: { amount: 5, lot: '' }, bingo: { amount: 0, lot: '' } } };
    main.querySelector('#reload-events').click();
    await settle();
    const amount = main.querySelector('#settings-line-amount');
    expect([amount.disabled, amount.value]).to.deep.equal([false, '5']);
    op.replies.getPrizes = { ok: false, code: 'storage_failure', message: 'Could not read the prizes. Try again.' };
    main.querySelector('#reload-events').click();
    await settle();
    expect([amount.disabled, amount.value, main.querySelector('#prizes-status').hidden]).to.deep.equal([true, '', false]);
  } finally { op.cleanup(); }
});

// First-line declaration through the real operator page.
async function openLineDialog(op) {
  op.main.querySelector('#tab-bingo').click();
  await settle();
  const claim = op.main.querySelector('#claim-line');
  await claim.updateComplete;
  claim.button.focus();
  claim.button.click();
  await settle();
  const dialog = op.main.querySelector('#line-dialog');
  await dialog.updateComplete;
  return { claim, dialog, field: op.main.querySelector('#line-winners'), status: op.main.querySelector('#line-status'),
    action: (name) => dialog.shadowRoot.querySelector(`[data-action="${name}"]`).button };
}

it('Línea opens an accessible Spanish dialog with the physical-check reminder, no identities and one winner', async () => {
  await setViewport({ width: 1280, height: 720 });
  const op = await loadOperator();
  try {
    const { claim, dialog, field } = await openLineDialog(op);
    expect(claim.disabled).to.equal(false);
    expect(dialog.shadowRoot.querySelector('dialog').open).to.equal(true);
    expect(dialog.label).to.equal('Declarar la línea');
    expect(dialog.textContent).to.include('cartón físico, fuera de esta aplicación');
    expect(dialog.textContent).to.include('Premio de línea configurado: 10 € + lote «Jamón».');
    expect(field.value).to.equal('1');
    expect(dialog.querySelectorAll('bingo-text-field')).to.have.length(1, 'only the winner count is asked');
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal(['line:begin']);
    await expect(dialog).to.be.accessible();
    // The corrected rail still fits.
    const rail = op.main.querySelector('bingo-side-rail').shadowRoot.querySelector('.body');
    expect(rail.scrollHeight).to.be.at.most(rail.clientHeight);
  } finally { op.cleanup(); await setViewport({ width: 800, height: 600 }); }
});

it('cancelling the line dialog by button or Escape cancels the session and restores focus without declaring', async () => {
  const op = await loadOperator();
  try {
    for (const how of ['button', 'escape']) {
      const { claim, dialog, action } = await openLineDialog(op);
      if (how === 'button') action('cancel').click();
      else dialog.shadowRoot.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      await settle();
      expect(dialog.shadowRoot.querySelector('dialog').open).to.equal(false);
      expect(claim.button.getRootNode().activeElement === claim.button).to.equal(true, 'focus returns to the Línea button');
    }
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([
      'line:begin', 'line:cancel:s1:a', 'line:begin', 'line:cancel:s1:a']);
  } finally { op.cleanup(); }
});

it('an invalid winner count keeps the dialog open with an inline Spanish error and sends nothing', async () => {
  const op = await loadOperator();
  try {
    const { dialog, field, action } = await openLineDialog(op);
    type(field.shadowRoot.querySelector('input'), '0');
    action('confirm').click();
    await settle();
    await dialog.updateComplete;
    expect(dialog.shadowRoot.querySelector('dialog').open).to.equal(true);
    expect(field.error).to.equal('Escribe un número entero de ganadores, 1 o más.');
    expect(field.value).to.equal('0');
    expect(op.requests.filter((request) => request.startsWith('line:confirm'))).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('confirming sends the explicit count once and shows the committed share, remainder and lot without public delivery', async () => {
  const op = await loadOperator();
  try {
    const { claim, field, status, action } = await openLineDialog(op);
    type(field.shadowRoot.querySelector('input'), '3');
    action('confirm').click();
    await settle();
    expect(op.requests.filter((request) => request.startsWith('line:confirm'))).to.deep.equal(['line:confirm:s1:a:3']);
    expect([status.hidden, status.tone]).to.deep.equal([false, 'info'], 'a pending celebration is not a success');
    expect(status.message).to.include('Línea declarada con 3 ganadores.');
    expect(status.message).to.include('3,33 € cada uno');
    expect(status.message).to.include('Sobra');
    expect(status.message).to.include('pendiente de resolver');
    expect(status.message).to.include('todavía no muestra la celebración');
    expect([claim.disabled, claim.textContent]).to.deep.equal([true, 'Línea declarada']);
  } finally { op.cleanup(); }
});

it('a lost confirmation asks to check the state, never confirms again, and a read recovers the committed award', async () => {
  const op = await loadOperator();
  try {
    const { claim, field, status, action } = await openLineDialog(op);
    op.line.confirm = async () => ({ ok: false, code: 'storage_failure',
      message: 'Could not declare the line. Reopen the setup and check the state before trying again.' });
    action('confirm').click();
    await settle();
    expect(status.message).to.equal('No se pudo confirmar la línea. No la declares de nuevo: pulsa «Comprobar línea» para leer el estado.');
    expect([status.tone, claim.disabled, claim.textContent]).to.deep.equal(['error', false, 'Comprobar línea']);
    expect(op.requests.filter((request) => request.startsWith('line:confirm'))).to.have.length(1);
    op.line.read = async () => ({ ok: true, state: 'declared', award: { eventId: 'a', award: { winnerCount: 1, totalCents: 1000,
      shareCents: 1000, remainderCents: 0, lot: '', lotResolution: 'not_required' }, presentation: { id: 'p', status: 'pending', startedAt: null, deadlineAt: null } } });
    claim.button.click();
    await settle();
    expect(status.message).to.include('Línea declarada con 1 ganador.');
    expect(op.requests.filter((request) => request === 'line:begin')).to.have.length(1);
    expect(op.requests.filter((request) => request.startsWith('line:confirm'))).to.have.length(1);
    expect(field.isConnected).to.equal(true);
  } finally { op.cleanup(); }
});

it('reload recovery adopts an open setup without opening, cancelling or confirming it, then resumes on request', async () => {
  const op = await loadOperator({ line: { read: async () => ({ ok: true, state: 'setup', session: { sessionId: 's9', eventId: 'a',
    calledNumbers: [4, 9], linePrize: { amount: 0, lot: '' } } }) } });
  try {
    const { main } = op;
    const claim = main.querySelector('#claim-line');
    expect(main.querySelector('#line-dialog').shadowRoot.querySelector('dialog').open).to.equal(false);
    expect(claim.textContent).to.equal('Reanudar línea');
    expect(main.querySelector('#line-status').message).to.include('declaración de línea abierta');
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
    // A setup in main blocks draws, so the controls say so instead of failing at main.
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(true);
    main.querySelector('#tab-bingo').click();
    claim.button.click();
    await settle();
    expect(main.querySelector('#line-dialog').shadowRoot.querySelector('dialog').open).to.equal(true);
    expect(main.querySelector('#line-dialog').textContent).to.include('sin premio');
    expect(op.requests.filter((request) => request === 'line:begin')).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('an open setup blocks drawing, event selection and settings but leaves the explicit reload available', async () => {
  const op = await loadOperator({ line: { read: async () => ({ ok: true, state: 'setup', session: { sessionId: 's9', eventId: 'a',
    calledNumbers: [4, 9], linePrize: { amount: 0, lot: '' } } }) } });
  try {
    const { main } = op;
    const controls = main.querySelector('#draw-controls');
    expect([controls.manualDisabled, controls.digitalDisabled, controls.reloadDisabled]).to.deep.equal([true, true, false]);
    expect(main.querySelector('#event-list').disabled).to.equal(true, 'event selection stays blocked');
    expect(main.querySelector('#settings-name').disabled).to.equal(true, 'settings stay blocked');
    expect(main.querySelector('#operator-board').disabled).to.equal(true);
    // Reloading re-reads the event only: it neither cancels nor confirms the open session.
    controls.reloadButton.click();
    await settle();
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
    expect(main.querySelector('#claim-line').textContent).to.equal('Reanudar línea');
    expect(controls.reloadDisabled).to.equal(false);
  } finally { op.cleanup(); }
});

it('a line already declared at load is shown after reload and cannot be declared again', async () => {
  const op = await loadOperator({ line: { read: async () => ({ ok: true, state: 'declared', award: { eventId: 'a',
    award: { winnerCount: 2, totalCents: 1000, shareCents: 500, remainderCents: 0, lot: '', lotResolution: 'not_required' },
    presentation: { id: 'p', status: 'pending', startedAt: null, deadlineAt: null } } }) } });
  try {
    const claim = op.main.querySelector('#claim-line');
    expect([claim.disabled, claim.textContent]).to.deep.equal([true, 'Línea declarada']);
    expect(op.main.querySelector('#line-status').message).to.include('5,00 € cada uno');
  } finally { op.cleanup(); }
});

// The submit handler reads the hosts' values; dispatching the event also covers a path that bypasses the disabled button.
function submitCreate(form) {
  form.elements.name.value = 'Nuevo';
  form.elements.place.value = 'Sala';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

const declaredA = { ok: true, state: 'declared', award: { eventId: 'a', award: { winnerCount: 1, totalCents: 1000, shareCents: 1000,
  remainderCents: 0, lot: '', lotResolution: 'not_required' }, presentation: { id: 'p', status: 'completed', startedAt: 1000, deadlineAt: 5000 } } };

it('selecting another event re-reads the line state instead of keeping the previous event declared', async () => {
  let answer = declaredA;
  const op = await loadOperator({ line: { read: async () => answer } });
  try {
    const { main } = op;
    const claim = main.querySelector('#claim-line');
    expect([claim.disabled, claim.textContent]).to.deep.equal([true, 'Línea declarada']);
    answer = { ok: true, state: 'none' };
    const before = op.reads.line;
    main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    await settle();
    expect(op.reads.line).to.be.greaterThan(before, 'the new active event was read');
        expect([claim.disabled, claim.textContent]).to.deep.equal([false, 'Línea']);
    expect(main.querySelector('#line-status').hidden).to.equal(true);
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([], 'a read never confirms or cancels');
  } finally { op.cleanup(); }
});

it('reloading events and the draw reload re-read the line state, and a create that changes the active event does too', async () => {
  let answer = { ok: true, state: 'none' };
  const created = { ok: true, events: [
    { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', phase: 'drawing', createdAt: '2026-01-01T00:00:00.000Z', active: false },
    { id: 'n', name: 'Nuevo', date: '2026-11-01', place: 'Sala', phase: 'drawing', createdAt: '2026-01-03T00:00:00.000Z', active: true }] };
  const op = await loadOperator({ line: { read: async () => answer }, createEvent: async () => created });
  try {
    const { main } = op;
    const claim = main.querySelector('#claim-line');
    answer = declaredA;
    main.querySelector('#reload-events').click();
    await settle();
    expect(claim.textContent).to.equal('Línea declarada');
    answer = { ok: true, state: 'none' };
    main.querySelector('#draw-controls').reloadButton.click();
    await settle();
    expect(claim.textContent).to.equal('Línea');
    // The created event is now the active one, so its own award is the one that is valid.
    answer = { ...declaredA, award: { ...declaredA.award, eventId: 'n' } };
    const before = op.reads.line;
    const form = main.querySelector('#create-event');
    submitCreate(form);
    await settle();
    await settle();
    expect(op.reads.line).to.be.greaterThan(before);
    expect(claim.textContent).to.equal('Línea declarada');
  } finally { op.cleanup(); }
});

it('an interrupted celebration shows a specific Spanish warning with the award, no completion claim and no automatic action', async () => {
  const interrupted = { ...declaredA, award: { ...declaredA.award, award: { ...declaredA.award.award, winnerCount: 3, shareCents: 333, remainderCents: 1 },
    presentation: { id: 'old', status: 'interrupted', startedAt: 1000, deadlineAt: 5000 } } };
  const op = await loadOperator({ line: { read: async () => interrupted } });
  try {
    const claim = op.main.querySelector('#claim-line');
    const status = op.main.querySelector('#line-status');
    expect([status.hidden, status.tone]).to.deep.equal([false, 'warning']);
    expect(status.message).to.include('Línea declarada con 3 ganadores.');
    expect(status.message).to.include('interrumpida');
    expect(status.message).to.include('bloqueados');
    expect(status.message).to.include('manualmente');
    expect(status.message).to.not.match(/completada|entregad|todavía no muestra/);
    expect([claim.disabled, claim.textContent]).to.deep.equal([true, 'Línea declarada']);
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
    expect(op.main.querySelector('#line-retry').hidden).to.equal(true);
    expect(op.main.querySelector('#line-repeat').hidden).to.equal(false);
  } finally { op.cleanup(); }
});

it('a line state that names another event than the active one is rejected, never shown or usable, and a proper check recovers', async () => {
  let answer = { ...declaredA, award: { ...declaredA.award, eventId: 'zzz' } };
  const op = await loadOperator({ line: { read: async () => answer } });
  try {
    const { main } = op;
    const claim = main.querySelector('#claim-line');
    const status = main.querySelector('#line-status');
    const controls = main.querySelector('#draw-controls');
    // The initial read raced the naming of the active event: whatever it held, the foreign award is not shown.
    expect(claim.textContent).to.not.equal('Línea declarada');
    expect(status.message).to.not.include('Línea declarada');
    expect([controls.manualDisabled, controls.digitalDisabled]).to.deep.equal([true, true]);
    // An explicit reload under the named event reads the foreign award again: it fails closed with the check message.
    main.querySelector('#reload-events').click();
    await settle();
    await settle();
    expect([claim.textContent, claim.disabled, status.tone]).to.deep.equal(['Comprobar línea', false, 'error']);
    expect(status.message).to.equal('Respuesta de la línea no válida. Pulsa «Comprobar línea» para leer el estado; no la declares de nuevo.');
    expect(status.message).to.not.include('Línea declarada');
    expect([controls.manualDisabled, controls.digitalDisabled, main.querySelector('#operator-board').disabled]).to.deep.equal([true, true, true]);
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
    // The check reads only; a proper answer for the active event recovers.
    answer = declaredA;
    claim.button.click();
    await settle();
    await settle();
    expect([claim.textContent, controls.manualDisabled]).to.deep.equal(['Línea declarada', false]);
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('creating an event is locked while a line setup is open or in flight, with reload still available', async () => {
  const session = { sessionId: 's9', eventId: 'a', calledNumbers: [4, 9], linePrize: { amount: 0, lot: '' } };
  let creates = 0;
  const op = await loadOperator({ line: { read: async () => ({ ok: true, state: 'setup', session }) },
    createEvent: async () => { creates++; return { ok: false, message: 'x' }; } });
  try {
    const { main } = op;
    const submit = main.querySelector('#create-event-submit');
    expect([submit.disabled, main.querySelector('#reload-events').disabled]).to.deep.equal([true, false]);
    const form = main.querySelector('#create-event');
    submitCreate(form);
    await settle();
    expect(creates).to.equal(0, 'a submit that bypasses the disabled button sends nothing');
  } finally { op.cleanup(); }
  let release;
  const held = await loadOperator({ line: { begin: () => new Promise((resolve) => { release = resolve; }) } });
  try {
    const submit = held.main.querySelector('#create-event-submit');
    expect(submit.disabled).to.equal(false);
    held.main.querySelector('#tab-bingo').click();
    const claim = held.main.querySelector('#claim-line');
    await claim.updateComplete;
    claim.button.click();
    await settle();
    expect([submit.disabled, held.main.querySelector('#reload-events').disabled]).to.deep.equal([true, false]);
    release({ ok: false, code: 'storage_failure', message: 'Could not read the first-line state. Try again.' });
    await settle();
    expect(submit.disabled).to.equal(false);
  } finally { held.cleanup(); }
});

it('a line confirmation that cannot read the clock is explained in Spanish', async () => {
  const op = await loadOperator();
  try {
    const { status, action } = await openLineDialog(op);
    op.line.confirm = async () => ({ ok: false, code: 'storage_failure', message: 'Could not read the clock. Try again.' });
    action('confirm').click();
    await settle();
    expect(status.message).to.equal('No se pudo leer el reloj del equipo. Pulsa «Comprobar línea» para leer el estado y reintentar.');
  } finally { op.cleanup(); }
});

// Presentation recovery through the real operator page: explicit buttons, pushes and the draw lock.
const presentationAt = (status, id = 'p') => ({ id, status,
  ...(status === 'pending' || status === 'failed' ? { startedAt: null, deadlineAt: null } : { startedAt: 1000, deadlineAt: 5000 }) });
const awardFor = (status, id = 'p', extra = {}, eventId = 'a') => ({ eventId, award: { winnerCount: 1, totalCents: 1000, shareCents: 1000,
  remainderCents: 0, lot: '', lotResolution: 'not_required', ...extra }, presentation: presentationAt(status, id) });
const declaredAs = (status, id = 'p', extra = {}) => async () => ({ ok: true, state: 'declared', award: awardFor(status, id, extra) });
const lineRequests = (op) => op.requests.filter((request) => request.startsWith('line:'));

it('a failed celebration offers one explicit retry for the exact current id and a double click sends it once', async () => {
  const op = await loadOperator({ line: { read: declaredAs('failed', 'f1'), retry: async () => ({ ok: true, award: awardFor('pending', 'f2') }) } });
  try {
    const { main } = op;
    const retry = main.querySelector('#line-retry');
    const status = main.querySelector('#line-status');
    expect([retry.hidden, retry.textContent.trim(), main.querySelector('#line-repeat').hidden]).to.deep.equal([false, 'Reintentar celebración', true]);
    expect(retry.button.getAttribute('aria-disabled')).to.not.equal('true');
    expect([status.tone, status.message.includes('no se ha completado')]).to.deep.equal(['warning', true]);
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(true);
    expect(lineRequests(op)).to.deep.equal([], 'nothing retries by itself');
    retry.button.click();
    retry.button.click();
    await settle();
    expect(lineRequests(op)).to.deep.equal(['line:retry:f1']);
    expect(retry.hidden).to.equal(true);
    expect(status.message).to.include('todavía no muestra la celebración');
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(true);
  } finally { op.cleanup(); }
});

it('an interrupted celebration offers one explicit full repeat that adopts the rotated id', async () => {
  const op = await loadOperator({ line: { read: declaredAs('interrupted', 'i1'), repeat: async () => ({ ok: true, award: awardFor('pending', 'i2') }) } });
  try {
    const { main } = op;
    const repeat = main.querySelector('#line-repeat');
    expect([repeat.hidden, repeat.textContent.trim(), main.querySelector('#line-retry').hidden]).to.deep.equal([false, 'Repetir celebración completa', true]);
    repeat.button.click();
    await settle();
    expect(lineRequests(op)).to.deep.equal(['line:repeat:i1']);
    expect(repeat.hidden).to.equal(true);
    op.line.push(awardFor('interrupted', 'i1'));
    await settle();
    expect(main.querySelector('#line-status').message).to.include('todavía no muestra la celebración');
  } finally { op.cleanup(); }
});

it('pending, started, completed and unknown states offer no action and a forced click sends nothing', async () => {
  for (const status of ['pending', 'started', 'completed']) {
    const op = await loadOperator({ line: { read: declaredAs(status) } });
    try {
      const { main } = op;
      await settle();
      expect([main.querySelector('#line-retry').hidden, main.querySelector('#line-repeat').hidden]).to.deep.equal([true, true]);
      main.querySelector('#line-retry').button.click();
      main.querySelector('#line-repeat').button.click();
      await settle();
      expect(lineRequests(op)).to.deep.equal([], status);
    } finally { op.cleanup(); }
  }
  const unknown = await loadOperator({ line: { read: async () => ({ ok: false, message: 'Could not read the first-line state. Try again.' }) } });
  try {
    expect([unknown.main.querySelector('#line-retry').hidden, unknown.main.querySelector('#line-repeat').hidden,
      unknown.main.querySelector('#claim-line').textContent]).to.deep.equal([true, true, 'Comprobar línea']);
  } finally { unknown.cleanup(); }
});

it('pushes update the status; drawing stays locked with the dialog closed until a completed state and a fresh event read', async () => {
  const tied = { winnerCount: 2, shareCents: 500, lot: 'Jamón', lotResolution: 'pending' };
  const op = await loadOperator({ line: { read: declaredAs('pending', 'p', tied) } });
  try {
    const { main } = op;
    const controls = main.querySelector('#draw-controls');
    const status = main.querySelector('#line-status');
    expect(main.querySelector('#line-dialog').shadowRoot.querySelector('dialog').open).to.equal(false);
    expect([controls.manualDisabled, controls.digitalDisabled, main.querySelector('#operator-board').disabled]).to.deep.equal([true, true, true]);
    main.querySelector('#operator-board').dispatchEvent(new CustomEvent('number-select', { detail: { number: 5 } }));
    controls.digitalButton.click();
    await settle();
    expect(op.requests.filter((request) => request === 'draw')).to.deep.equal([], 'handlers are guarded as well');
    op.line.push(awardFor('started', 'p', tied));
    await settle();
    expect(status.message).to.include('en marcha');
    expect(controls.manualDisabled).to.equal(true);
    op.replies.getCurrentEvent = async () => ({ ok: true, snapshot: { calledNumbers: [4, 9], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    const before = op.reads.event;
    op.line.push(awardFor('completed', 'p', tied));
    await settle();
    await settle();
    expect(op.reads.event).to.equal(before + 1, 'the event is read once after the completion');
    expect(status.message).to.include('terminó');
    expect(status.message).to.include('pendiente de resolver');
    expect([controls.manualDisabled, controls.digitalDisabled, main.querySelector('#operator-board').disabled]).to.deep.equal([false, false, false]);
    expect(main.querySelector('#phase-status').message).to.include('Línea cantada');
    controls.digitalButton.click();
    await settle();
    expect(op.requests.filter((request) => request === 'draw')).to.have.length(1);
    expect(lineRequests(op)).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('a null, corrupt or foreign push fails closed or is ignored, and only Comprobar línea reads again', async () => {
  const op = await loadOperator({ line: { read: declaredAs('pending') } });
  try {
    const { main } = op;
    const claim = main.querySelector('#claim-line');
    const before = op.reads.event;
    op.line.push(awardFor('completed', 'p', {}, 'zzz'));
    await settle();
    expect([main.querySelector('#line-status').message.includes('todavía no muestra'), op.reads.event]).to.deep.equal([true, before]);
    op.line.push(null);
    await settle();
    expect([claim.textContent, main.querySelector('#line-status').tone, main.querySelector('#draw-controls').manualDisabled]).to.deep.equal(['Comprobar línea', 'error', true]);
    op.line.push(awardFor('completed'));
    await settle();
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(true, 'a push does not leave uncertainty');
    op.line.read = declaredAs('completed');
    claim.button.click();
    await settle();
    await settle();
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(false);
    expect(lineRequests(op)).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('a failed event refresh after the completion keeps drawing blocked until Recargar evento succeeds', async () => {
  const op = await loadOperator({ line: { read: declaredAs('started') } });
  try {
    const { main } = op;
    const controls = main.querySelector('#draw-controls');
    op.replies.getCurrentEvent = async () => ({ ok: false, message: 'Could not read the current event. Try again.' });
    op.line.push(awardFor('completed'));
    await settle();
    await settle();
    expect(controls.manualDisabled).to.equal(true);
    expect(main.querySelector('#line-status').message).to.include('no se pudo releer el evento');
    op.replies.getCurrentEvent = null;
    controls.reloadButton.click();
    await settle();
    await settle();
    expect([controls.manualDisabled, main.querySelector('#line-status').message.includes('no se pudo releer')]).to.deep.equal([false, false]);
  } finally { op.cleanup(); }
});

it('a completion during an event read in flight queues a second read after it', async () => {
  const op = await loadOperator({ line: { read: declaredAs('started') } });
  try {
    const { main } = op;
    let release;
    const declaredSnapshot = { ok: true, snapshot: { calledNumbers: [4, 9], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' } };
    op.replies.getCurrentEvent = () => {
      op.replies.getCurrentEvent = async () => declaredSnapshot;
      return new Promise((resolve) => { release = resolve; });
    };
    const before = op.reads.event;
    main.querySelector('#draw-controls').reloadButton.click();
    await settle();
    op.line.push(awardFor('completed'));
    await settle();
    expect(op.reads.event).to.equal(before + 1);
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(true);
    release({ ok: true, snapshot: { calledNumbers: [4, 9], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    await settle();
    await settle();
    expect(op.reads.event).to.equal(before + 2, 'the refresh was queued behind the running read');
    expect(main.querySelector('#draw-controls').manualDisabled).to.equal(false);
  } finally { op.cleanup(); }
});

it('failed and interrupted celebrations do not ban selecting another event, but pending and started do', async () => {
  for (const [status, blocked] of [['failed', false], ['interrupted', false], ['pending', true], ['started', true]]) {
    const op = await loadOperator({ line: { read: declaredAs(status) } });
    try {
      const { main } = op;
      expect(main.querySelector('#event-list').disabled).to.equal(blocked, status);
      expect(main.querySelector('#settings-name').disabled).to.equal(blocked, status);
      main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
      await settle();
      expect(op.requests.includes('select:b')).to.equal(!blocked, status);
    } finally { op.cleanup(); }
  }
});

it('a completion for the previous event arriving after another event was selected never unlocks or refreshes', async () => {
  let answer = declaredAs('failed', 'f1');
  const op = await loadOperator({ line: { read: () => answer() } });
  try {
    const { main } = op;
    answer = async () => ({ ok: true, state: 'none' });
    main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    await settle();
    const before = op.reads.event;
    op.line.push(awardFor('completed', 'f1'));
    await settle();
    expect(op.reads.event).to.equal(before);
    expect([main.querySelector('#claim-line').textContent, main.querySelector('#line-status').hidden]).to.deep.equal(['Línea', true]);
  } finally { op.cleanup(); }
});

// Line lot through the real operator page: the panel only renders controller state and asks for explicit reads and draws.
const tiedAward = { winnerCount: 2, shareCents: 500, lot: 'Jamón', lotResolution: 'pending' };
const lotSnap = (fact = { origin: 'none', resolution: 'pending' }, extra = {}) => ({ eventId: 'a', auditSequence: 7, winnerCount: 2,
  lot: 'Jamón', presentation: { id: 'p', status: 'completed' }, fact, ...extra });
const numbered = (participantNumber, colorId, extra = {}) =>
  lotSnap({ origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber, colorId }, extra);
const lotReply = (snapshot, kind = 'current') => ({ ok: true, kind, snapshot });
const tiedOp = (lot, status = 'completed') => loadOperator({ line: { read: declaredAs(status, 'p', tiedAward) }, lot });
const panel = (op) => {
  const element = op.main.querySelector('#line-lot');
  expect(element !== null, 'the line lot panel exists').to.equal(true);
  return element;
};
const lotButton = (op, intent) => panel(op).shadowRoot.querySelector(`button[data-intent="${intent}"]`);
const lotText = (op) => panel(op).shadowRoot.textContent.replace(/\s+/g, ' ');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

it('the line lot panel reads the pending lot, waits for the completed celebration and draws once per explicit request', async () => {
  let current = lotSnap(undefined, { presentation: { id: 'p', status: 'pending' } });
  const ack = deferred();
  const op = await tiedOp({ read: async () => lotReply(current), draw: () => ack.promise }, 'pending');
  try {
    expect([panel(op).hidden, op.lot.reads, lotButton(op, 'draw').disabled]).to.deep.equal([false, 1, true]);
    current = lotSnap();
    op.replies.getCurrentEvent = async () => ({ ok: true, snapshot: { calledNumbers: [4, 9], phase: 'line_declared', lastTransitionAt: '2026-01-01T00:00:00.000Z' } });
    op.line.push(awardFor('completed', 'p', tiedAward));
    await settle();
    await settle();
    expect(op.lot.reads).to.equal(2, 'the completion reads the lot once');
    const draw = lotButton(op, 'draw');
    expect(draw.disabled).to.equal(false);
    draw.click();
    draw.click();
    await settle();
    expect(op.lot.draws).to.deep.equal([{ eventId: 'a', auditSequence: 7, presentationId: 'p' }]);
    expect(lotText(op)).to.not.include('Ganador:', 'nothing is shown before the acknowledgement');
    expect(op.lot.presents).to.deep.equal([], 'nothing is presented before the acknowledgement');
    ack.resolve(lotReply(numbered(2, 'blue'), 'committed'));
    await settle();
    expect(lotText(op)).to.include('participante 2, color Azul');
    expect([lotButton(op, 'draw').disabled, op.lot.reads, lineRequests(op)]).to.deep.equal([true, 2, []]);
    expect(op.lot.presents).to.deep.equal([numbered(2, 'blue')], 'the own committed snapshot is presented once, unchanged');
  } finally { op.cleanup(); }
});

it('a failed lot read shows Spanish copy on the panel, never the controller English message', async () => {
  const op = await tiedOp({ read: async () => ({ ok: false, code: 'storage_failure' }) });
  try {
    expect(lotText(op)).to.include('El estado del lote no es fiable');
    expect(lotText(op)).to.not.include('Lot state needs a fresh read');
  } finally { op.cleanup(); }
});

it('a numbered or legacy winner restored at startup is shown as is, with no reroll, retry, replay or presentation request', async () => {
  const legacy = lotSnap({ origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' });
  // The largest safe count and a repeated palette colour (participant 7 is red again) are valid facts.
  for (const [snapshot, shown] of [[numbered(7, 'red', { winnerCount: Number.MAX_SAFE_INTEGER }), 'participante 7, color Rojo'],
    [legacy, 'Ganador desconocido']]) {
    const op = await tiedOp({ read: async () => lotReply(snapshot, 'recovered') });
    try {
      expect(lotText(op)).to.include(shown);
      expect([lotButton(op, 'draw').disabled, op.lot.reads, op.lot.draws, lineRequests(op)]).to.deep.equal([true, 1, [], []]);
    } finally { op.cleanup(); }
  }
});

it('only an own committed draw is presented: reads, recoveries, resyncs, late, disposed and mismatched acks are not', async () => {
  for (const kind of ['current', 'recovered']) {
    const op = await tiedOp({ read: async () => lotReply(numbered(7, 'red'), kind) });
    try {
      op.lot.status(true);
      op.main.querySelector('#reload-events').click();
      await settle();
      expect(op.lot.presents).to.deep.equal([], `a ${kind} read is never presented`);
    } finally { op.cleanup(); }
  }
  let answer = lotReply(lotSnap());
  const resync = await tiedOp({ read: async () => answer, draw: async () => ({ ok: false, code: 'read_required' }) });
  try {
    lotButton(resync, 'draw').click();
    await settle();
    answer = lotReply(numbered(2, 'blue'), 'recovered');
    lotButton(resync, 'resync').click();
    await settle();
    expect([lotText(resync).includes('participante 2'), resync.lot.presents]).to.deep.equal([true, []]);
  } finally { resync.cleanup(); }
  const ack = deferred();
  const away = await tiedOp({ read: async () => lotReply(lotSnap()), draw: () => ack.promise });
  try {
    lotButton(away, 'draw').click();
    await settle();
    away.line.read = async () => ({ ok: true, state: 'none' });
    away.main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    await settle();
    ack.resolve(lotReply(numbered(2, 'blue'), 'committed'));
    await settle();
    expect(away.lot.presents).to.deep.equal([], 'a late acknowledgement for the previous context');
  } finally { away.cleanup(); }
  const late = deferred();
  const gone = await tiedOp({ read: async () => lotReply(lotSnap()), draw: () => late.promise });
  try {
    lotButton(gone, 'draw').click();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    late.resolve(lotReply(numbered(2, 'blue'), 'committed'));
    await settle();
    expect(gone.lot.presents).to.deep.equal([], 'a disposed page');
  } finally { gone.cleanup(); }
  for (const bad of [numbered(2, 'blue', { auditSequence: 9 }), numbered(2, 'red'), { ok: false, code: 'read_required' }]) {
    const op = await tiedOp({ read: async () => lotReply(lotSnap()), draw: async () => (bad.ok === false ? bad : lotReply(bad, 'committed')) });
    try {
      lotButton(op, 'draw').click();
      await settle();
      expect(op.lot.presents).to.deep.equal([], 'a mismatched or failed acknowledgement');
    } finally { op.cleanup(); }
  }
});

it('a failing private presentation request never undoes the stored winner, retries, or blocks ordinary drawing', async () => {
  const unhandled = [];
  const onUnhandled = (event) => { unhandled.push(event.reason); event.preventDefault(); };
  window.addEventListener('unhandledrejection', onUnhandled);
  const scripts = [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }, () => Promise.reject(new Error('rejected')),
    async () => ({ ok: false, code: 'unsupported' }), null];
  try {
    for (const present of scripts) {
      const op = await tiedOp({ read: async () => lotReply(lotSnap()), draw: async () => lotReply(numbered(2, 'blue'), 'committed'),
        ...(present ? { present } : { omitPresent: true }) });
      try {
        lotButton(op, 'draw').click();
        await settle();
        await settle();
        expect(lotText(op)).to.include('participante 2, color Azul');
        expect(lotText(op)).to.not.include('Resultado incierto');
        op.lot.status(true);
        op.main.querySelector('#reload-events').click();
        await settle();
        const controls = op.main.querySelector('#draw-controls');
        expect([op.lot.presents.length, op.lot.draws.length, lotText(op).includes('participante 2, color Azul'),
          controls.manualDisabled, controls.digitalDisabled]).to.deep.equal([present ? 1 : 0, 1, true, false, false]);
      } finally { op.cleanup(); }
    }
    await settle();
    expect(unhandled).to.deep.equal([]);
  } finally { window.removeEventListener('unhandledrejection', onUnhandled); }
});

it('a lost draw acknowledgement locks the panel until an explicit keyboard resync, whatever else updates', async () => {
  let answer = lotReply(lotSnap());
  const op = await tiedOp({ read: async () => answer, draw: async () => ({ ok: false, code: 'read_required' }) });
  try {
    // The keyboard needs the rendered Bingo workspace, not the default Eventos tab.
    op.main.querySelector('#tab-bingo').click();
    await frames();
    lotButton(op, 'draw').focus();
    await sendKeys({ press: 'Space' });
    await settle();
    expect(lotText(op)).to.include('Resultado incierto');
    expect([lotButton(op, 'draw').disabled, lotButton(op, 'resync').disabled, op.lot.reads, op.lot.draws.length]).to.deep.equal([true, false, 1, 1]);
    op.lot.status(true);
    op.line.push(awardFor('completed', 'p', tiedAward));
    await settle();
    expect([lotText(op).includes('Resultado incierto'), lotButton(op, 'draw').disabled, op.lot.reads, op.lot.draws.length]).to.deep.equal([true, true, 1, 1]);
    answer = lotReply(lotSnap(undefined, { auditSequence: 8 }));
    lotButton(op, 'resync').focus();
    await sendKeys({ press: 'Enter' });
    await settle();
    expect([op.lot.reads, lotButton(op, 'draw').disabled]).to.deep.equal([2, false]);
    lotButton(op, 'resync').focus();
    await sendKeys({ press: 'Space' });
    await settle();
    expect([op.lot.reads, op.lot.draws.length]).to.deep.equal([3, 1]);
  } finally { op.cleanup(); }
});

it('switching event hides the old lot at once, ignores its late acknowledgement and still blocks a second physical draw', async () => {
  const ack = deferred();
  const op = await tiedOp({ read: async () => lotReply(lotSnap()), draw: () => ack.promise });
  try {
    lotButton(op, 'draw').click();
    await settle();
    const select = (id) => op.main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id } }));
    op.line.read = async () => ({ ok: true, state: 'none' });
    select('b');
    await settle();
    await settle();
    expect([panel(op).hidden, lotText(op).includes('Jamón')]).to.deep.equal([true, false]);
    op.line.read = declaredAs('completed', 'p', tiedAward);
    select('a');
    await settle();
    await settle();
    expect(panel(op).hidden).to.equal(false);
    lotButton(op, 'draw').click();
    await settle();
    expect(op.lot.draws).to.have.length(1, 'the first write is still unacknowledged');
    ack.resolve(lotReply(numbered(2, 'blue'), 'committed'));
    await settle();
    expect(lotText(op)).to.not.include('Ganador:', 'a reply for the previous context is inert');
  } finally { op.cleanup(); }
});

it('an unresolved lot never blocks ordinary drawing, and only an explicit reload reads it again', async () => {
  const op = await tiedOp({ read: async () => lotReply(lotSnap()) });
  try {
    const controls = op.main.querySelector('#draw-controls');
    expect([controls.manualDisabled, controls.digitalDisabled, op.main.querySelector('#claim-bingo').disabled]).to.deep.equal([false, false, true]);
    controls.digitalButton.click();
    op.lot.status(true);
    await settle();
    expect([op.requests.filter((request) => request === 'draw').length, op.lot.draws.length, op.lot.reads]).to.deep.equal([1, 0, 1]);
    op.main.querySelector('#reload-events').click();
    await settle();
    expect(op.lot.reads).to.equal(2);
  } finally { op.cleanup(); }
});

it('forced intents on a hidden panel write nothing and a disposed page ignores late replies', async () => {
  const idle = await loadOperator();
  try {
    const element = panel(idle);
    for (const name of ['line-lot-draw', 'line-lot-resync']) element.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
    await settle();
    expect([element.hidden, idle.lot.reads, idle.lot.draws]).to.deep.equal([true, 0, []]);
  } finally { idle.cleanup(); }
  const ack = deferred();
  const op = await tiedOp({ read: async () => lotReply(lotSnap()), draw: () => ack.promise });
  try {
    lotButton(op, 'draw').click();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    ack.resolve(lotReply(numbered(2, 'blue'), 'committed'));
    await settle();
    expect([lotText(op).includes('Ganador:'), op.lot.draws.length]).to.deep.equal([false, 1]);
  } finally { op.cleanup(); }
});

it('a single-winner line shows no panel and a foreign, malformed or mismatched lot reply never shows a winner', async () => {
  const single = await loadOperator({ line: { read: declaredAs('completed') } });
  try { expect([panel(single).hidden, single.lot.reads]).to.deep.equal([true, 0]); } finally { single.cleanup(); }
  // Foreign event, participant above the count, and a colour that is not the palette's colour for that participant.
  for (const bad of [numbered(2, 'blue', { eventId: 'b' }), numbered(3, 'green'), numbered(2, 'red')]) {
    const op = await tiedOp({ read: async () => lotReply(bad) });
    try {
      expect(lotText(op)).to.include('Resultado incierto').and.not.include('Ganador:');
      expect(lotButton(op, 'draw').disabled).to.equal(true);
    } finally { op.cleanup(); }
  }
  const op = await tiedOp({ read: async () => lotReply(lotSnap()), draw: async () => lotReply(numbered(2, 'blue', { auditSequence: 9 }), 'committed') });
  try {
    lotButton(op, 'draw').click();
    await settle();
    expect(lotText(op)).to.include('Resultado incierto').and.not.include('Ganador:');
  } finally { op.cleanup(); }
});

// Legacy checking_line recovery through the real operator page.
const HEAD = '2026-01-01T00:00:00.000Z';
const checking = { ok: true, snapshot: { calledNumbers: [4, 9], phase: 'checking_line', lastTransitionAt: HEAD } };
const drawing = { ok: true, snapshot: { calledNumbers: [4, 9], phase: 'drawing', lastTransitionAt: '2026-01-01T00:00:01.000Z' } };
const heldCheck = { ok: true, state: 'legacy_check', check: { eventId: 'a', phase: 'checking_line', lastTransitionAt: HEAD, auditSequence: 7 } };
// The event reads checking_line until the recovery acknowledgement, then drawing, as the real main would answer.
async function loadLegacy(extra = {}) {
  let recovered = false;
  const op = await loadOperator({ legacy: { read: async () => heldCheck, cancel: async () => { recovered = true; return { ok: true, state: 'recovered' }; },
    ...extra } });
  op.replies.getCurrentEvent = () => (recovered ? drawing : checking);
  op.main.querySelector('#draw-controls').reloadButton.click();
  await settle();
  const ui = { button: op.main.querySelector('#line-recover'), dialog: op.main.querySelector('#legacy-dialog'),
    status: op.main.querySelector('#line-status'), controls: op.main.querySelector('#draw-controls'),
    claim: op.main.querySelector('#claim-line'), cancels: () => op.requests.filter((request) => request.startsWith('legacy:cancel')) };
  return { op, ui, setRecovered: (value) => { recovered = value; } };
}
const dialogOpen = (dialog) => dialog.shadowRoot.querySelector('dialog').open;

it('a held checking_line offers Cancelar comprobación de línea, locks drawing and writes nothing on load', async () => {
  const { op, ui } = await loadLegacy();
  try {
    expect(ui.button).not.to.equal(null);
    expect([ui.button.hidden, ui.button.disabled, ui.button.textContent]).to.deep.equal([false, false, 'Cancelar comprobación de línea']);
    expect([ui.controls.manualDisabled, ui.controls.digitalDisabled]).to.deep.equal([true, true]);
    expect(ui.status.message).to.include('comprobación de línea');
    expect(ui.cancels()).to.deep.equal([]);
    expect(op.reads.legacy).to.be.greaterThan(0);
    expect(op.requests.filter((request) => request.startsWith('line:'))).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('nothing is offered or read for a drawing event, and a not-available check keeps the page as it was', async () => {
  const drawingOnly = await loadOperator();
  try {
    expect(drawingOnly.main.querySelector('#line-recover')?.hidden).to.equal(true);
    expect(drawingOnly.reads.legacy).to.equal(0);
  } finally { drawingOnly.cleanup(); }
  const none = await loadOperator();
  try {
    none.replies.getCurrentEvent = () => checking;
    none.main.querySelector('#draw-controls').reloadButton.click();
    await settle();
    expect(none.reads.legacy).to.be.greaterThan(0);
    expect(none.main.querySelector('#line-recover')?.hidden).to.equal(true);
    expect(none.requests.filter((request) => request.startsWith('legacy:'))).to.deep.equal([]);
  } finally { none.cleanup(); }
});

it('the confirmation is a Spanish modal that conserves numbers and prizes; Volver, Escape and focus write nothing', async () => {
  const { op, ui } = await loadLegacy();
  try {
    op.main.querySelector('#tab-bingo').click();
    await settle();
    for (const how of ['button', 'escape']) {
      ui.button.button.focus();
      ui.button.button.click();
      await settle();
      await ui.dialog.updateComplete;
      expect(dialogOpen(ui.dialog)).to.equal(true);
      expect(ui.dialog.label).to.equal('Cancelar comprobación de línea');
      expect(ui.dialog.textContent).to.include('números cantados');
      expect(ui.dialog.textContent).to.include('premios');
      expect([...ui.dialog.shadowRoot.querySelectorAll('bingo-button')].map((button) => button.textContent))
        .to.deep.equal(['Volver', 'Volver a cantar números']);
      if (how === 'button') await expect(ui.dialog).to.be.accessible();
      if (how === 'button') ui.dialog.shadowRoot.querySelector('[data-action="cancel"]').button.click();
      else ui.dialog.shadowRoot.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      await settle();
      expect(dialogOpen(ui.dialog)).to.equal(false);
      expect(ui.button.button.getRootNode().activeElement === ui.button.button).to.equal(true, 'focus returns to the opener');
    }
    expect(ui.cancels()).to.deep.equal([]);
  } finally { op.cleanup(); }
});

it('confirming dispatches the exact identity once, refreshes the event and unlocks only the drawing phase, with no award or presentation', async () => {
  const { op, ui } = await loadLegacy();
  try {
    op.main.querySelector('#tab-bingo').click();
    await settle();
    const eventReads = op.reads.event;
    ui.button.button.click();
    await settle();
    const confirm = ui.dialog.shadowRoot.querySelector('[data-action="confirm"]').button;
    confirm.click();
    confirm.click();
    await settle();
    await settle();
    expect(ui.cancels()).to.deep.equal([`legacy:cancel:a:7:${HEAD}`]);
    expect(op.reads.event).to.be.greaterThan(eventReads, 'the committed event is read again');
    expect(ui.button.hidden).to.equal(true);
    expect([ui.controls.manualDisabled, ui.controls.digitalDisabled]).to.deep.equal([false, false]);
    expect([ui.claim.disabled, ui.claim.textContent]).to.deep.equal([false, 'Línea']);
    expect(op.requests.filter((request) => /^(line:|tongo)/.test(request))).to.deep.equal([]);
    expect(op.lot.presents).to.deep.equal([]);
    // A new, ordinary declaration still opens after the recovery.
    ui.claim.button.click();
    await settle();
    expect(op.requests.filter((request) => request === 'line:begin')).to.have.length(1);
  } finally { op.cleanup(); }
});

it('a failed event refresh after recovery stays locked with a Spanish message until the reload succeeds', async () => {
  const { op, ui, setRecovered } = await loadLegacy();
  try {
    op.main.querySelector('#tab-bingo').click();
    await settle();
    let failing = true;
    op.replies.getCurrentEvent = () => (failing ? { ok: false, code: 'storage_failure', message: 'Could not read the current event. Try again.' } : drawing);
    ui.button.button.click();
    await settle();
    ui.dialog.shadowRoot.querySelector('[data-action="confirm"]').button.click();
    await settle();
    await settle();
    expect([ui.controls.manualDisabled, ui.controls.digitalDisabled]).to.deep.equal([true, true]);
    expect(ui.status.message).to.include('no se pudo releer el evento');
    expect(ui.cancels()).to.have.length(1);
    failing = false;
    setRecovered(true);
    ui.controls.reloadButton.click();
    await settle();
    await settle();
    expect([ui.controls.manualDisabled, ui.status.hidden]).to.deep.equal([false, true]);
    expect(ui.cancels()).to.have.length(1, 'reload never writes');
  } finally { op.cleanup(); }
});

it('a lost acknowledgement hides the stale identity, never retries, and an explicit read offers it again', async () => {
  let lost = true;
  const { op, ui } = await loadLegacy({ cancel: async () => { if (lost) return null; return { ok: true, state: 'recovered' }; } });
  try {
    op.main.querySelector('#tab-bingo').click();
    await settle();
    ui.button.button.click();
    await settle();
    ui.dialog.shadowRoot.querySelector('[data-action="confirm"]').button.click();
    await settle();
    await settle();
    expect(ui.button.textContent).to.equal('Releer comprobación de línea');
    expect(ui.status.tone).to.equal('error');
    expect(ui.status.message).to.include('Releer comprobación de línea');
    expect([ui.controls.manualDisabled, ui.cancels().length]).to.deep.equal([true, 1]);
    const before = op.reads.legacy;
    lost = false;
    ui.button.button.click();
    await settle();
    expect(dialogOpen(ui.dialog)).to.equal(false, 'rereading never opens the confirmation or writes');
    expect(op.reads.legacy).to.equal(before + 1);
    expect([ui.button.textContent, ui.cancels().length]).to.deep.equal(['Cancelar comprobación de línea', 1]);
  } finally { op.cleanup(); }
});

it('a failed check read fails closed in Spanish and offers only a read', async () => {
  const { op, ui } = await loadLegacy({ read: async () => ({ ok: false, code: 'storage_failure',
    message: 'Could not read the line check. Try again or review the event storage.' }) });
  try {
    expect(ui.button.textContent).to.equal('Releer comprobación de línea');
    expect(ui.status.message).to.include('almacenamiento');
    expect([ui.controls.manualDisabled, ui.cancels().length]).to.deep.equal([true, 0]);
  } finally { op.cleanup(); }
});

it('a recovery in flight locks the page, an ordinary reload re-reads without writing, and switching event drops the held check', async () => {
  let release;
  const { op, ui } = await loadLegacy({ cancel: () => new Promise((resolve) => { release = resolve; }) });
  try {
    op.main.querySelector('#tab-bingo').click();
    await settle();
    const before = op.reads.legacy;
    ui.controls.reloadButton.click();
    await settle();
    expect(op.reads.legacy).to.be.greaterThan(before);
    expect(ui.cancels()).to.deep.equal([]);
    ui.button.button.click();
    await settle();
    ui.dialog.shadowRoot.querySelector('[data-action="confirm"]').button.click();
    await settle();
    expect(op.main.querySelector('#event-list').disabled).to.equal(true);
    expect(ui.controls.manualDisabled).to.equal(true);
    ui.button.button.click();
    await settle();
    expect(dialogOpen(ui.dialog)).to.equal(false, 'a second request cannot be made while one is in flight');
    expect(ui.cancels()).to.have.length(1);
    release({ ok: true, state: 'recovered' });
    await settle();
  } finally { op.cleanup(); }
  const switched = await loadLegacy();
  try {
    switched.op.replies.getCurrentEvent = () => drawing;
    switched.op.main.querySelector('#event-list').dispatchEvent(new CustomEvent('event-select', { detail: { id: 'b' } }));
    await settle();
    await settle();
    expect(switched.ui.button.hidden).to.equal(true);
    expect(switched.ui.cancels()).to.deep.equal([]);
  } finally { switched.op.cleanup(); }
});
