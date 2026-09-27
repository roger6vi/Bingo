import { LitElement, css, html } from 'lit';
import './bingo-number.mjs';

class BingoOperatorSummary extends LitElement {
  static properties = { latest: { type: Number }, count: { type: Number }, remaining: { type: Number } };
  static styles = css`
    :host { display: block; }
    .summary { display: flex; flex-wrap: wrap; gap: var(--bingo-space-section); align-items: center; }
    p { margin: 0; color: var(--bingo-color-text); }
    output { font-weight: var(--bingo-font-emphasis); }
    h3 { margin-block: var(--bingo-space-section) var(--bingo-space-small); font-size: var(--bingo-font-size); }
  `;
  constructor() { super(); this.latest = null; this.count = 0; this.remaining = 90; }
  render() {
    return html`<h3>Last confirmed call</h3><div class="summary">
      <bingo-number .value=${this.latest} emptyLabel="No draws yet"></bingo-number>
      <p>Called: <output aria-live="off">${this.count}</output></p>
      <p>Remaining: <output aria-live="polite">${this.remaining}</output></p>
    </div>`;
  }
}

customElements.define('bingo-operator-summary', BingoOperatorSummary);
