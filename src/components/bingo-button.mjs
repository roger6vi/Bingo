import { LitElement, css, html } from 'lit';

// `variant="primary"` is the filled call to action; `block` stretches the button to its container.
export class BingoButton extends LitElement {
  static properties = {
    disabled: { type: Boolean, reflect: true },
    variant: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
  };
  static styles = css`
    :host { display: inline-block; }
    :host([block]) { display: block; }
    button {
      font: inherit; color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: 1px solid var(--bingo-color-border); cursor: pointer;
      padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
      transition: background-color var(--bingo-motion-normal);
    }
    :host([block]) button { width: 100%; }
    :host([variant="primary"]) button {
      color: var(--bingo-color-canvas); background: var(--bingo-color-accent); border-color: var(--bingo-color-accent);
      font-weight: var(--bingo-font-emphasis);
    }
    button:not(:disabled):hover { color: var(--bingo-color-canvas); background: var(--bingo-color-accent); }
    :host([variant="primary"]) button:not(:disabled):hover { color: var(--bingo-color-accent); background: var(--bingo-color-surface); }
    button:disabled { color: var(--bingo-color-muted); background: var(--bingo-color-canvas); cursor: not-allowed; opacity: 0.65; }
    :host([variant="primary"]) button:disabled { border-color: var(--bingo-color-border); }
    button:focus-visible { outline: 2px solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small); }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  constructor() { super(); this.disabled = false; this.variant = ''; this.block = false; }
  get button() { return this.shadowRoot.querySelector('button'); }
  render() { return html`<button part="button" type="button" ?disabled=${this.disabled}><slot></slot></button>`; }
}

customElements.define('bingo-button', BingoButton);
