import { LitElement, css, html } from 'lit';

export class BingoButton extends LitElement {
  static properties = { disabled: { type: Boolean, reflect: true } };
  static styles = css`
    :host { display: inline-block; }
    button {
      font: inherit; color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: 1px solid var(--bingo-color-border); cursor: pointer;
      padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
      transition: background-color var(--bingo-motion-normal);
    }
    button:not(:disabled):hover { color: var(--bingo-color-canvas); background: var(--bingo-color-accent); }
    button:disabled { color: var(--bingo-color-muted); background: var(--bingo-color-canvas); cursor: not-allowed; opacity: 0.65; }
    button:focus-visible { outline: 2px solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small); }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  constructor() { super(); this.disabled = false; }
  get button() { return this.shadowRoot.querySelector('button'); }
  render() { return html`<button type="button" ?disabled=${this.disabled}><slot></slot></button>`; }
}

customElements.define('bingo-button', BingoButton);
