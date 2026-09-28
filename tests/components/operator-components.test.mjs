import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';

it('operator page exposes shared panels and interactive components', async () => {
  const response = await fetch(new URL('../../src/operator.html', import.meta.url));
  expect(response.ok).to.equal(true);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  expect(page.querySelector('main h1')).not.to.equal(null);
  expect(page.querySelectorAll('main bingo-panel')).to.have.length(2);
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
    const error = main.querySelector('#event-error');
    const controls = main.querySelector('#draw-controls');
    await controls.updateComplete;
    expect(controls.digitalButton.disabled).to.equal(true);
    expect(status.message).to.equal('Loading event state');
    resolveLoad({ ok: true, snapshot: { calledNumbers: [90, 3, 1] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await history.updateComplete;
    expect(summary.remaining).to.equal(87);
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    await controls.updateComplete;
    expect(controls.digitalButton.disabled).to.equal(false);
    controls.digitalButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history.calledNumbers).to.deep.equal([90, 3, 1]);
    expect(summary.remaining).to.equal(87);
    expect(status.tone).to.equal('warning');
    expect(error.message).to.equal('Write failed');
    expect(error.hidden).to.equal(false);
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
  }
});
