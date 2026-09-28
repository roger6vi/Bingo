import { LitElement, css, html } from 'lit';

export class BingoButton extends LitElement {
  static properties = { disabled: { type: Boolean, reflect: true } };
  static styles = css`
    :host { display: inline-block; }
    button {
      font: inherit; color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border-strong);
      border-radius: var(--bingo-radius-control); cursor: pointer;
      padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
      transition: background-color var(--bingo-motion-normal) var(--bingo-motion-easing);
    }
    button:not(:disabled):hover { color: var(--bingo-color-on-accent); background: var(--bingo-color-accent-hover); }
    button:not(:disabled):active { color: var(--bingo-color-on-accent); background: var(--bingo-color-accent-active); }
    button:disabled {
      color: var(--bingo-color-disabled); background: var(--bingo-color-disabled-surface);
      cursor: not-allowed; opacity: var(--bingo-opacity-disabled);
    }
    button:focus-visible {
      outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small);
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  constructor() { super(); this.disabled = false; }
  get button() { return this.shadowRoot.querySelector('button'); }
  render() { return html`<button type="button" ?disabled=${this.disabled}><slot></slot></button>`; }
}

customElements.define('bingo-button', BingoButton);
