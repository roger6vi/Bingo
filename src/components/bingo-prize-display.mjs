import { LitElement, css, html } from 'lit';
import { PRIZE_LABELS, formatEuros } from '../prize-format.mjs';

// The audience's read-only Línea and Bingo prizes. Both rows are always present: `prizes` is the committed
// `{ line, bingo }` (each `{ amount, lot }`), or null when none is available.
class BingoPrizeDisplay extends LitElement {
  static properties = { prizes: { attribute: false } };
  static styles = css`
    :host { display: block; min-width: 0; }
    dl { display: grid; gap: var(--bingo-space-section); margin: 0; }
    dt { color: var(--bingo-color-muted); font-size: var(--bingo-font-size); text-transform: uppercase; letter-spacing: var(--bingo-font-tracking); }
    dd { margin: 0; font: var(--bingo-font-emphasis) var(--bingo-font-size-large)/var(--bingo-font-tight) var(--bingo-font-body); overflow-wrap: anywhere; }
    .amount { display: block; }
  `;
  constructor() { super(); this.prizes = null; }
  value(prize) {
    if (prize === undefined) return 'Sin definir';
    if (prize.lot === '' && prize.amount === 0) return 'Sin premio';
    return html`${prize.lot}${prize.lot !== '' && prize.amount > 0 ? ' ' : ''}${prize.amount > 0 ? html`<span class="amount">${formatEuros(prize.amount)}</span>` : ''}`;
  }
  render() {
    return html`<dl>${Object.entries(PRIZE_LABELS).map(([key, label]) => html`<div><dt>${label}</dt><dd>${this.value(this.prizes?.[key])}</dd></div>`)}</dl>`;
  }
}

customElements.define('bingo-prize-display', BingoPrizeDisplay);
