import { LitElement, css, html } from 'lit';

class BingoNumber extends LitElement {
  static properties = { value: { type: Number }, emptyLabel: { type: String } };
  static styles = css`
    :host { display: inline-block; }
    span {
      display: inline-grid; place-items: center;
      min-width: 2.5ch; padding: var(--bingo-space-inset-compact);
      border: 2px solid var(--bingo-color-accent);
      box-shadow: var(--bingo-space-small) var(--bingo-space-small) 0 var(--bingo-color-border);
      color: var(--bingo-color-text);
      font: var(--bingo-font-emphasis) var(--bingo-font-display)/var(--bingo-font-tight) var(--bingo-font-body);
    }
  `;
  constructor() { super(); this.value = null; this.emptyLabel = 'Waiting for draw'; }
  render() { return html`<span>${this.value === null ? this.emptyLabel : this.value}</span>`; }
}

customElements.define('bingo-number', BingoNumber);
