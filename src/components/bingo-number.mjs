import { LitElement, css, html } from 'lit';

class BingoNumber extends LitElement {
  static properties = { value: { type: Number }, emptyLabel: { type: String }, compact: { type: Boolean } };
  static styles = css`
    :host { display: inline-block; max-width: 100%; }
    span {
      display: inline-grid; place-items: center;
      max-width: 100%; box-sizing: border-box;
      padding: var(--bingo-space-inset-compact);
      border: 2px solid var(--bingo-color-accent);
      box-shadow: var(--bingo-space-small) var(--bingo-space-small) 0 var(--bingo-color-border);
      color: var(--bingo-color-text);
    }
    span.drawn {
      min-width: 2.5ch;
      font: var(--bingo-font-emphasis) var(--bingo-font-display)/var(--bingo-font-tight) var(--bingo-font-body);
    }
    span.drawn.compact {
      font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body);
    }
    span.empty {
      font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body);
      overflow-wrap: anywhere;
    }
  `;
  constructor() { super(); this.value = null; this.emptyLabel = 'Waiting for draw'; this.compact = false; }
  render() { return html`<span class=${this.value === null ? 'empty' : this.compact ? 'drawn compact' : 'drawn'}>${this.value === null ? this.emptyLabel : this.value}</span>`; }
}

customElements.define('bingo-number', BingoNumber);
