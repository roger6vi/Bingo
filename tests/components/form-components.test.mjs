import { fixture, html, expect } from '@open-wc/testing';
import { sendKeys } from '@web/test-runner-commands';
import '../../src/components/bingo-text-field.mjs';
import '../../src/components/bingo-date-field.mjs';
import '../../src/components/bingo-select-field.mjs';
import '../../src/components/bingo-form-actions.mjs';
import '../../src/components/bingo-button.mjs';

// Browser component tests for every state of the shared form controls (issue #79). They stand in
// for Storybook stories until Storybook exists on the base branch.
const THEMES = ['pixel-classic', 'high-contrast'];
async function withThemes(check) {
  const links = await Promise.all(THEMES.map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  // Paint the themed canvas behind the fixtures, as screen.css does for the page.
  document.body.style.background = 'var(--bingo-color-canvas)';
  try {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      await check(theme);
    }
  } finally {
    delete document.documentElement.dataset.theme;
    document.body.style.removeProperty('background');
    links.forEach((link) => link.remove());
  }
}
// Resolves a semantic token to the computed color the browser would paint.
function token(element, name) {
  const probe = document.createElement('span');
  probe.style.color = getComputedStyle(element).getPropertyValue(`--bingo-${name}`).trim();
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
const typeInto = async (field, value) => {
  field.control.focus();
  field.control.select?.();
  await sendKeys({ type: value });
  await field.updateComplete;
};

describe('bingo-text-field', () => {
  it('default state: labelled native control, required marker and hint wired through aria-describedby', async () => {
    const field = await fixture(html`<bingo-text-field label="Nombre" hint="Hasta 120 caracteres" required maxlength="120"
      autocomplete="off" name="name"></bingo-text-field>`);
    const control = field.control;
    expect([control.tagName, control.type, control.required, control.maxLength, control.getAttribute('autocomplete')])
      .to.deep.equal(['INPUT', 'text', true, 120, 'off']);
    expect(field.shadowRoot.querySelector('label[for="control"]').textContent).to.equal('Nombre');
    expect(field.shadowRoot.querySelector('.required').getAttribute('aria-hidden')).to.equal('true');
    expect(control.getAttribute('aria-describedby')).to.equal('hint');
    expect(field.shadowRoot.querySelector('#hint').textContent).to.equal('Hasta 120 caracteres');
    expect(control.getAttribute('aria-invalid')).to.equal('false');
    await expect(field).to.be.accessible();
  });

  it('value follows typing both ways and input/change reach the host', async () => {
    const field = await fixture(html`<bingo-text-field label="Lugar"></bingo-text-field>`);
    const seen = [];
    field.addEventListener('input', () => seen.push(`input:${field.value}`));
    field.addEventListener('change', () => seen.push(`change:${field.value}`));
    await typeInto(field, 'Plaza');
    field.control.dispatchEvent(new Event('change'));
    expect(seen.at(-2)).to.equal('input:Plaza');
    expect(seen.at(-1)).to.equal('change:Plaza');
    field.value = 'Sala';
    await field.updateComplete;
    expect(field.control.value).to.equal('Sala');
  });

  it('error state is announced, described, icon-marked and makes the host invalid', async () => {
    const field = await fixture(html`<bingo-text-field label="Lugar" hint="Obligatorio"></bingo-text-field>`);
    const region = field.shadowRoot.querySelector('#error');
    expect([region.getAttribute('aria-live'), region.textContent.trim()]).to.deep.equal(['polite', '']);
    field.error = 'Escribe un lugar de 1 a 120 caracteres.';
    await field.updateComplete;
    const control = field.control;
    expect(region, 'the live region persists so the change is announced').to.equal(field.shadowRoot.querySelector('#error'));
    expect([control.getAttribute('aria-invalid'), control.getAttribute('aria-describedby'), region.textContent.trim()])
      .to.deep.equal(['true', 'hint error', 'Error: Escribe un lugar de 1 a 120 caracteres.']);
    expect(region.querySelector('svg[aria-hidden="true"]'), 'not color-only').not.to.equal(null);
    expect([field.invalid, field.validity.customError, field.checkValidity(), field.matches(':state(invalid)')])
      .to.deep.equal([true, true, false, true]);
    await expect(field).to.be.accessible();
    field.error = '';
    await field.updateComplete;
    expect([control.getAttribute('aria-invalid'), control.getAttribute('aria-describedby'), region.textContent.trim(), field.checkValidity()])
      .to.deep.equal(['false', 'hint', '', true]);
  });

  it('disabled state is synchronous, removes the value from the form and reads as disabled without color', async () => {
    const form = await fixture(html`<form><bingo-text-field name="name" label="Nombre" value="Verbena"></bingo-text-field></form>`);
    const field = form.querySelector('bingo-text-field');
    await field.updateComplete;
    expect(new FormData(form).get('name')).to.equal('Verbena');
    field.disabled = true;
    expect([field.hasAttribute('disabled'), field.matches(':disabled')]).to.deep.equal([true, true]);
    await field.updateComplete;
    expect([field.control.disabled, new FormData(form).has('name')]).to.deep.equal([true, false]);
    expect(getComputedStyle(field.control).borderTopStyle).to.equal('dashed');
    field.disabled = false;
    await field.updateComplete;
    expect([field.control.disabled, field.hasAttribute('disabled')]).to.deep.equal([false, false]);
  });

  it('pending state marks the control busy with a non-textual indicator', async () => {
    const field = await fixture(html`<bingo-text-field label="Nombre" pending></bingo-text-field>`);
    expect(field.control.getAttribute('aria-busy')).to.equal('true');
    expect(field.shadowRoot.querySelector('.adornment .busy[aria-hidden="true"]')).not.to.equal(null);
    field.pending = false;
    await field.updateComplete;
    expect([field.control.hasAttribute('aria-busy'), field.shadowRoot.querySelector('.busy')]).to.deep.equal([false, null]);
  });

  it('participates in its form: named value, native required validity, reset and implicit submission', async () => {
    const form = await fixture(html`<form>
      <bingo-text-field name="name" label="Nombre" required></bingo-text-field>
      <bingo-button type="submit" id="go">Crear</bingo-button>
    </form>`);
    const field = form.elements.name;
    const submitter = form.querySelector('#go');
    expect(field.localName).to.equal('bingo-text-field');
    expect([field.form, form.checkValidity(), field.validity.valueMissing]).to.deep.equal([form, false, true]);
    let submits = 0;
    form.addEventListener('submit', (event) => { event.preventDefault(); submits++; });
    submitter.click();
    expect(submits, 'native interactive validation still blocks an invalid form').to.equal(0);
    await typeInto(field, 'Gran Bingo');
    expect([new FormData(form).get('name'), form.checkValidity()]).to.deep.equal(['Gran Bingo', true]);
    await sendKeys({ press: 'Enter' });
    expect(submits, 'Enter submits through the first submit button').to.equal(1);
    submitter.disabled = true;
    await sendKeys({ press: 'Enter' });
    expect(submits, 'no implicit submission while the submitter is disabled').to.equal(1);
    form.reset();
    await field.updateComplete;
    expect([field.value, field.control.value]).to.deep.equal(['', '']);
  });

  it('delegates focus to the native control', async () => {
    const field = await fixture(html`<bingo-text-field label="Nombre"></bingo-text-field>`);
    field.focus();
    expect([document.activeElement, field.shadowRoot.activeElement]).to.deep.equal([field, field.control]);
  });
});

describe('bingo-date-field', () => {
  it('renders a native date control with bounds, a themed calendar icon and every field state', async () => {
    const form = await fixture(html`<form><bingo-date-field name="date" label="Fecha" required min="2026-01-01" max="2026-12-31"
      value="2026-08-15"></bingo-date-field></form>`);
    const field = form.querySelector('bingo-date-field');
    const control = field.control;
    expect([control.type, control.value, control.min, control.max, control.required]).to.deep.equal(
      ['date', '2026-08-15', '2026-01-01', '2026-12-31', true]);
    expect(field.shadowRoot.querySelector('.adornment svg[aria-hidden="true"]')).not.to.equal(null);
    expect(new FormData(form).get('date')).to.equal('2026-08-15');
    field.value = '2027-01-01';
    await field.updateComplete;
    expect([field.validity.rangeOverflow, field.checkValidity()]).to.deep.equal([true, false]);
    field.value = '2026-09-01';
    field.error = 'Elige una fecha válida.';
    field.pending = true;
    await field.updateComplete;
    expect([control.getAttribute('aria-invalid'), control.getAttribute('aria-busy'), field.shadowRoot.querySelector('#error').textContent.trim()])
      .to.deep.equal(['true', 'true', 'Error: Elige una fecha válida.']);
    field.error = '';
    field.disabled = true;
    await field.updateComplete;
    expect([control.disabled, new FormData(form).has('date')]).to.deep.equal([true, false]);
    field.disabled = false;
    form.reset();
    await field.updateComplete;
    expect(field.value, 'reset restores the default attribute').to.equal('2026-08-15');
    await expect(field).to.be.accessible();
  });

  it('a native date input updates the host value independently of browser locale', async () => {
    const field = await fixture(html`<bingo-date-field label="Fecha"></bingo-date-field>`);
    field.control.value = '2026-09-01';
    field.control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await field.updateComplete;
    expect(field.value).to.equal('2026-09-01');
  });
});

describe('bingo-select-field', () => {
  it('mirrors light-DOM options, defaults like a native select and re-dispatches change', async () => {
    const field = await fixture(html`<bingo-select-field label="Tema" name="theme">
      <option value="pixel-classic">Pixel classic</option>
      <option value="high-contrast">High contrast</option>
    </bingo-select-field>`);
    const control = field.control;
    expect([...control.options].map((option) => [option.value, option.textContent])).to.deep.equal(
      [['pixel-classic', 'Pixel classic'], ['high-contrast', 'High contrast']]);
    expect([field.value, control.value]).to.deep.equal(['pixel-classic', 'pixel-classic']);
    expect(field.shadowRoot.querySelector('.adornment svg')).not.to.equal(null);
    const changes = [];
    field.addEventListener('change', () => changes.push(field.value));
    control.value = 'high-contrast';
    control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    control.dispatchEvent(new Event('change'));
    expect([field.value, changes]).to.deep.equal(['high-contrast', ['high-contrast']]);
    field.value = 'pixel-classic';
    await field.updateComplete;
    expect(control.value).to.equal('pixel-classic');
    await expect(field).to.be.accessible();
  });

  it('follows option changes and supports error, disabled and pending states', async () => {
    const form = await fixture(html`<form><bingo-select-field label="Tema" name="theme" value="b">
      <option value="a">A</option><option value="b">B</option>
    </bingo-select-field></form>`);
    const field = form.querySelector('bingo-select-field');
    await field.updateComplete;
    expect([field.value, new FormData(form).get('theme')]).to.deep.equal(['b', 'b']);
    const option = document.createElement('option');
    option.value = 'c';
    option.textContent = 'C';
    field.append(option);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await field.updateComplete;
    expect([...field.control.options].map((item) => item.value)).to.deep.equal(['a', 'b', 'c']);
    field.error = 'Elige un tema.';
    field.pending = true;
    await field.updateComplete;
    expect([field.control.getAttribute('aria-invalid'), field.control.getAttribute('aria-busy'),
      field.shadowRoot.querySelector('.adornment .busy') !== null, field.shadowRoot.querySelector('.adornment svg')])
      .to.deep.equal(['true', 'true', true, null], 'pending replaces the chevron');
    field.disabled = true;
    await field.updateComplete;
    expect([field.control.disabled, new FormData(form).has('theme')]).to.deep.equal([true, false]);
  });
});

describe('bingo-form-actions and bingo-button', () => {
  it('orders status, secondary and primary actions and submits the owning form', async () => {
    const form = await fixture(html`<form novalidate>
      <bingo-form-actions>
        <bingo-button slot="primary" variant="primary" type="submit" id="save">Guardar cambios</bingo-button>
        <bingo-button id="discard">Descartar cambios</bingo-button>
        <span slot="status" id="state">Cambios sin guardar</span>
      </bingo-form-actions>
    </form>`);
    const actions = form.querySelector('bingo-form-actions');
    const [save, discard, state] = ['#save', '#discard', '#state'].map((selector) => form.querySelector(selector));
    const x = (element) => element.getBoundingClientRect().left;
    expect(x(state) < x(discard) && x(discard) < x(save), 'status, secondary, then primary').to.equal(true);
    // Focus order follows the visual order.
    discard.button.focus();
    await sendKeys({ press: 'Tab' });
    expect(save.shadowRoot.activeElement).to.equal(save.button);
    expect(actions.internals.role).to.equal('group');
    let submits = 0;
    let discards = 0;
    form.addEventListener('submit', (event) => { event.preventDefault(); submits++; });
    discard.addEventListener('click', () => discards++);
    save.button.click();
    save.click();
    discard.click();
    expect([submits, discards]).to.deep.equal([2, 1], 'only the submit button submits');
    save.disabled = true;
    discard.disabled = true;
    save.click();
    discard.click();
    expect([submits, discards], 'a disabled host swallows programmatic clicks').to.deep.equal([2, 1]);
    await expect(actions).to.be.accessible();
  });

  it('pending and sticky states', async () => {
    const actions = await fixture(html`<bingo-form-actions sticky><span slot="status">Guardando cambios</span></bingo-form-actions>`);
    expect([getComputedStyle(actions).position, getComputedStyle(actions).bottom]).to.deep.equal(['sticky', '0px']);
    expect(actions.shadowRoot.querySelector('.busy')).to.equal(null);
    actions.pending = true;
    await actions.updateComplete;
    expect([actions.internals.ariaBusy, actions.shadowRoot.querySelector('.busy[aria-hidden="true"]') !== null]).to.deep.equal(['true', true]);
  });

  it('type="reset" resets the owning form', async () => {
    const form = await fixture(html`<form><bingo-text-field name="n" label="N" value="x"></bingo-text-field>
      <bingo-button type="reset">Restablecer</bingo-button></form>`);
    const field = form.querySelector('bingo-text-field');
    field.value = 'y';
    form.querySelector('bingo-button').click();
    expect(field.value).to.equal('x');
  });
});

it('every control consumes semantic tokens in both themes with a visible focus indicator', async () => {
  const form = await fixture(html`<form>
    <bingo-text-field label="Nombre" error="Escribe un nombre."></bingo-text-field>
    <bingo-date-field label="Fecha"></bingo-date-field>
    <bingo-select-field label="Tema"><option>A</option></bingo-select-field>
    <bingo-form-actions><bingo-button slot="primary" variant="primary" type="submit">Guardar</bingo-button></bingo-form-actions>
  </form>`);
  const [text, date, select] = ['bingo-text-field', 'bingo-date-field', 'bingo-select-field'].map((tag) => form.querySelector(tag));
  const primary = form.querySelector('bingo-button').button;
  await withThemes(async () => {
    for (const field of [text, date, select]) {
      const style = getComputedStyle(field.control);
      expect([style.color, style.backgroundColor]).to.deep.equal([token(field, 'color-text'), token(field, 'color-surface')]);
    }
    expect(getComputedStyle(date.control).borderTopColor, 'control boundaries use the 3:1 muted color').to.equal(token(date, 'color-muted'));
    expect(getComputedStyle(text.control).borderTopColor).to.equal(token(text, 'color-danger'));
    expect(getComputedStyle(text.shadowRoot.querySelector('#error')).color).to.equal(token(text, 'color-danger'));
    expect([getComputedStyle(primary).backgroundColor, getComputedStyle(primary).color])
      .to.deep.equal([token(primary, 'color-accent'), token(primary, 'color-canvas')]);
    date.control.focus();
    await sendKeys({ press: 'ArrowUp' });
    const focused = getComputedStyle(date.control);
    expect([focused.outlineStyle, focused.outlineColor]).to.deep.equal(['solid', token(date, 'color-focus')]);
    await expect(form).to.be.accessible();
    date.control.blur();
  });
  expect(getComputedStyle(text.control).transitionDuration, 'reduced motion').to.equal('0s');
});
