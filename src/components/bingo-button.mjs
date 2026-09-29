import { LitElement, css, html } from 'lit';

// A themed button. Inside a form, type="submit" or "reset" acts on the owning form (the shadow
// button cannot); variant="primary" marks the one main action of a form or dialog, and block
// stretches the button to fill its container.
export class BingoButton extends LitElement {
  static formAssociated = true;
  // disabled is attribute-backed and synchronous like a native button's: a form-associated host with
  // a stale disabled attribute would silently ignore click().
  static properties = {
    disabled: { type: Boolean, noAccessor: true },
    type: { type: String },
    variant: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
  };
  static styles = css`
    :host { display: inline-block; }
    :host([hidden]) { display: none; }
    :host([block]) { display: block; }
    button {
      font: inherit; color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border-strong); border-radius: var(--bingo-radius-control);
      cursor: pointer; white-space: nowrap;
      padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
      box-shadow: var(--bingo-border-width-strong) var(--bingo-border-width-strong) 0 var(--bingo-color-shadow);
      transition: background-color var(--bingo-motion-normal) var(--bingo-motion-easing);
    }
    :host([block]) button { width: 100%; }
    :host([variant="primary"]) button {
      color: var(--bingo-color-on-accent); background: var(--bingo-color-accent); border-color: var(--bingo-color-accent);
      font-weight: var(--bingo-font-emphasis);
    }
    button:not(:disabled):hover { color: var(--bingo-color-on-accent); background: var(--bingo-color-accent-hover); }
    button:not(:disabled):active { color: var(--bingo-color-on-accent); background: var(--bingo-color-accent-active); }
    :host([variant="primary"]) button:not(:disabled):hover { color: var(--bingo-color-accent); background: var(--bingo-color-surface); }
    button:disabled {
      color: var(--bingo-color-disabled); background: var(--bingo-color-disabled-surface); border-color: var(--bingo-color-border);
      box-shadow: none; cursor: not-allowed; opacity: var(--bingo-opacity-disabled);
    }
    :host([variant="primary"]) button:disabled { border-color: var(--bingo-color-border); }
    button:focus-visible { outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small); }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  constructor() {
    super();
    this.type = 'button'; this.variant = ''; this.block = false;
    this.internals = this.attachInternals();
    // Registered first, so a disabled host swallows even programmatic clicks before other listeners.
    this.addEventListener('click', (event) => this.activate(event));
  }
  get disabled() { return this.disabledState ?? false; }
  set disabled(value) {
    const old = this.disabledState;
    this.disabledState = Boolean(value);
    this.toggleAttribute('disabled', this.disabledState);
    this.requestUpdate('disabled', old);
  }
  get button() { return this.shadowRoot.querySelector('button'); }
  get form() { return this.internals.form; }
  activate(event) {
    if (this.disabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.type === 'submit') this.form?.requestSubmit();
    else if (this.type === 'reset') this.form?.reset();
  }
  render() {
    return html`<button part="button" type="button" ?disabled=${this.disabled}><slot></slot></button>`;
  }
}

customElements.define('bingo-button', BingoButton);
