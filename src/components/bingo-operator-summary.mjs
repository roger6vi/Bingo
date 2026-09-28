import { LitElement, css, html } from 'lit';
import './bingo-number.mjs';

class BingoOperatorSummary extends LitElement {
  static properties = { latest: { type: Number }, count: { type: Number }, remaining: { type: Number } };
  static styles = css`
    :host { display: block; }
    .summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.75rem; align-items: center; }
    bingo-number { --bingo-font-display: clamp(2.25rem, 7vh, 4rem); justify-self: start; }
    .stats { display: grid; gap: 0.375rem; }
    p {
      display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem;
      margin: 0; color: var(--bingo-color-text);
    }
    .label { color: var(--bingo-color-muted); font-size: 0.8125rem; }
    output { font-weight: var(--bingo-font-emphasis); font-size: 1.25rem; font-variant-numeric: tabular-nums; }
  `;
  constructor() { super(); this.latest = null; this.count = 0; this.remaining = 90; }
  render() {
    return html`<div class="summary">
      <bingo-number .value=${this.latest} emptyLabel="Sin bolas"></bingo-number>
      <div class="stats">
        <p><span class="label">Cantadas</span> <output aria-live="off">${this.count}</output></p>
        <p><span class="label">Quedan</span> <output aria-live="polite">${this.remaining}</output></p>
      </div>
    </div>`;
  }
}

customElements.define('bingo-operator-summary', BingoOperatorSummary);
