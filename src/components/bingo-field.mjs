import { LitElement, css, html, nothing } from 'lit';

// Shared base for the operator form fields: a labelled native control in the shadow root, a hint,
// an announced error, and form association through ElementInternals. Subclasses render the control
// with renderControl(); every other state lives here so the fields look and behave alike.
const VALIDITY_FLAGS = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
  'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput'];

// Pending: three pixel blocks that appear only once the wait is noticeable; static under reduced motion.
export const busyStyles = css`
  .busy { display: inline-flex; gap: 2px; opacity: 0; animation: appear 0s linear 150ms forwards; }
  .busy i { width: 4px; height: 4px; background: var(--bingo-color-accent); animation: blink 900ms steps(1, end) infinite; }
  .busy i:nth-child(2) { animation-delay: 300ms; }
  .busy i:nth-child(3) { animation-delay: 600ms; }
  @keyframes appear { to { opacity: 1; } }
  @keyframes blink { 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) { .busy i { animation: none; } }
`;

const baseFieldStyles = css`
  :host { display: block; min-width: 0; }
  :host([hidden]) { display: none; }
  .field { display: grid; gap: var(--bingo-space-small); }
  .label-row { display: flex; align-items: baseline; gap: var(--bingo-space-small); }
  label {
    font: var(--bingo-font-emphasis) calc(var(--bingo-font-size) * 0.875)/var(--bingo-font-tight) var(--bingo-font-body);
    letter-spacing: 0.02em; color: var(--bingo-color-text);
  }
  .required { color: var(--bingo-color-muted); font-weight: var(--bingo-font-emphasis); }
  .control-wrap { position: relative; display: flex; align-items: center; }
  .control {
    box-sizing: border-box; width: 100%; margin: 0;
    padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
    font: var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body);
    color: var(--bingo-color-text); background: var(--bingo-color-surface);
    border: 1px solid var(--bingo-color-muted);
    border-radius: calc(var(--bingo-radius-surface) / 2);
    transition: border-color var(--bingo-motion-normal), box-shadow var(--bingo-motion-normal);
  }
  .control:not(:disabled):hover { border-color: var(--bingo-color-text); }
  .control:focus-visible {
    outline: 2px solid var(--bingo-color-focus); outline-offset: 1px;
    border-color: var(--bingo-color-accent);
  }
  /* Invalid: a thicker inline-start bar and an icon + message, never color alone. */
  .control[aria-invalid="true"] {
    border-color: var(--bingo-color-danger);
    box-shadow: inset 3px 0 0 var(--bingo-color-danger);
  }
  .control:disabled {
    color: var(--bingo-color-muted); background: var(--bingo-color-canvas);
    border-style: dashed; cursor: not-allowed;
  }
  .control[aria-busy="true"] { cursor: progress; }
  .has-adornment .control { padding-inline-end: calc(var(--bingo-space-inset-inline) * 2 + 1rem); }
  .adornment {
    position: absolute; inset-inline-end: var(--bingo-space-inset-inline);
    display: inline-flex; align-items: center; gap: var(--bingo-space-small);
    color: var(--bingo-color-muted); pointer-events: none;
  }
  .adornment svg { width: 1rem; height: 1rem; fill: currentColor; }
  .control:not(:disabled) ~ .adornment { color: var(--bingo-color-text); }
  .hint, .error { margin: 0; font-size: calc(var(--bingo-font-size) * 0.875); line-height: var(--bingo-font-tight); }
  .hint { color: var(--bingo-color-muted); }
  .error { display: flex; align-items: flex-start; gap: var(--bingo-space-small); color: var(--bingo-color-danger); font-weight: var(--bingo-font-emphasis); }
  /* The empty live region stays in the accessibility tree but out of the grid flow. */
  .error.empty { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .error svg { flex: none; width: 1em; height: 1em; margin-top: 0.1em; fill: currentColor; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .control { transition: none; } }
`;

export const fieldStyles = [busyStyles, baseFieldStyles];

export const busyIndicator = html`<span class="busy" aria-hidden="true"><i></i><i></i><i></i></span>`;
// A pixel octagon with a knocked-out "!", so the error reads without its color.
const errorIcon = html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path fill-rule="evenodd" d="M5 1h6l4 4v6l-4 4H5l-4-4V5zm2 3v5h2V4zm0 6v2h2v-2z"/></svg>`;

export class BingoField extends LitElement {
  static formAssociated = true;
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static properties = {
    label: { type: String }, hint: { type: String }, error: { type: String },
    name: { type: String, reflect: true }, value: { type: String },
    // Attribute-backed and synchronous, like a native control's (see bingo-button).
    required: { type: Boolean, reflect: true }, disabled: { type: Boolean, noAccessor: true },
    pending: { type: Boolean, reflect: true },
  };
  static styles = fieldStyles;

  constructor() {
    super();
    this.internals = this.attachInternals();
    this.label = ''; this.hint = ''; this.error = ''; this.name = '';
    this.value = ''; this.required = false; this.pending = false;
  }

  get disabled() { return this.disabledState ?? false; }
  set disabled(value) {
    const old = this.disabledState;
    this.disabledState = Boolean(value);
    this.toggleAttribute('disabled', this.disabledState);
    this.requestUpdate('disabled', old);
  }
  get control() { return this.shadowRoot?.querySelector('#control') ?? null; }
  get form() { return this.internals.form; }
  get validity() { return this.internals.validity; }
  get validationMessage() { return this.internals.validationMessage; }
  get willValidate() { return this.internals.willValidate; }
  get invalid() { return Boolean(this.error); }
  checkValidity() { return this.internals.checkValidity(); }
  reportValidity() { return this.internals.reportValidity(); }

  // The attribute value is the default a form reset restores.
  formResetCallback() { this.value = this.getAttribute('value') ?? ''; }
  formStateRestoreCallback(state) { if (typeof state === 'string') this.value = state; }

  describedBy() {
    return [this.hint ? 'hint' : '', this.error ? 'error' : ''].filter(Boolean).join(' ') || nothing;
  }

  onInput(event) { this.value = event.target.value; }
  // Native change does not cross the shadow boundary; re-dispatch it from the host.
  onChange(event) {
    this.value = event.target.value;
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Implicit submission, as a native text control would do: activate the form's first submit button.
  onKeydown(event) {
    if (event.key !== 'Enter' || event.isComposing || this.form === null) return;
    const submitter = [...this.form.elements].find((element) => element.type === 'submit');
    if (!submitter || submitter.disabled) return;
    event.preventDefault();
    submitter.click();
  }

  updated() {
    const control = this.control;
    this.internals.setFormValue(this.value);
    if (this.error) {
      this.internals.states?.add('invalid');
      this.internals.setValidity({ customError: true }, this.error, control ?? undefined);
      return;
    }
    this.internals.states?.delete('invalid');
    if (control && !control.validity.valid) {
      const flags = Object.fromEntries(VALIDITY_FLAGS.filter((flag) => control.validity[flag]).map((flag) => [flag, true]));
      this.internals.setValidity(flags, control.validationMessage, control);
    } else this.internals.setValidity({});
  }

  renderControl() { return nothing; }
  renderAdornment() { return this.pending ? busyIndicator : nothing; }

  render() {
    const adornment = this.renderAdornment();
    return html`<div class="field">
      <div class="label-row">
        <label for="control">${this.label}</label>
        ${this.required ? html`<span class="required" aria-hidden="true">*</span>` : nothing}
      </div>
      <div class="control-wrap ${adornment === nothing ? '' : 'has-adornment'}">
        ${this.renderControl()}
        ${adornment === nothing ? nothing : html`<span class="adornment">${adornment}</span>`}
      </div>
      ${this.hint ? html`<p id="hint" class="hint">${this.hint}</p>` : nothing}
      <div id="error" class=${this.error ? 'error' : 'error empty'} aria-live="polite">${this.error
        ? html`${errorIcon}<span><span class="visually-hidden">Error: </span>${this.error}</span>` : nothing}</div>
    </div>`;
  }
}
