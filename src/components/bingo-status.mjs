import { LitElement, css, html } from 'lit';

class BingoStatus extends LitElement {
  static properties = { message: { type: String }, tone: { type: String } };
  static styles = css`
    :host { display: block; }
    p { margin: 0; font-weight: var(--bingo-font-emphasis); }
    .warning, .error { color: var(--bingo-color-danger); }
  `;
  constructor() { super(); this.message = 'Waiting for event state'; this.tone = 'info'; }
  render() {
    return html`<p class=${this.tone} role=${this.tone === 'error' ? 'alert' : 'status'}>${this.message}</p>`;
  }
}

customElements.define('bingo-status', BingoStatus);
