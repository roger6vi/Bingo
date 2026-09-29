import { LitElement, css, html } from 'lit';

class BingoNumber extends LitElement {
  static properties = {
    value: { type: Number }, emptyLabel: { type: String }, compact: { type: Boolean }, latest: { type: Boolean, reflect: true },
  };
  static styles = css`
    :host { display: inline-block; max-width: 100%; }
    span {
      display: inline-grid; place-items: center;
      max-width: 100%; box-sizing: border-box;
      padding: var(--bingo-space-inset-compact);
      border: var(--bingo-border-width-strong) solid var(--bingo-color-accent);
      border-radius: var(--bingo-radius-control);
      box-shadow: var(--bingo-elevation-raised) var(--bingo-elevation-raised) 0 var(--bingo-color-shadow);
      color: var(--bingo-color-call-called);
      background: var(--bingo-color-call-called-surface);
    }
    :host([latest]) span.drawn { color: var(--bingo-color-call-latest); background: var(--bingo-color-call-latest-surface); }
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
  constructor() { super(); this.value = null; this.emptyLabel = 'Waiting for draw'; this.compact = false; this.latest = false; }
  render() { return html`<span class=${this.value === null ? 'empty' : this.compact ? 'drawn compact' : 'drawn'}>${this.value === null ? this.emptyLabel : this.value}</span>`; }
}

customElements.define('bingo-number', BingoNumber);
