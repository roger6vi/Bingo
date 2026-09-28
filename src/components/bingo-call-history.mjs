import { LitElement, css, html, nothing } from 'lit';
import './bingo-number.mjs';

class BingoCallHistory extends LitElement {
  static properties = { calledNumbers: { attribute: false } };
  static styles = css`
    :host { display: block; min-width: 0; }
    h3 { font-size: var(--bingo-font-size); }
    ol { display: flex; flex-wrap: wrap; gap: var(--bingo-space-inset-compact) var(--bingo-space-section); padding-inline-start: var(--bingo-space-list-indent); }
    li[aria-current] { outline: var(--bingo-border-width-strong) solid var(--bingo-color-accent); outline-offset: var(--bingo-space-small); }
  `;
  constructor() { super(); this.calledNumbers = []; }
  render() {
    return html`<h3 id="history-heading">Called numbers (draw order)</h3>
      ${this.calledNumbers.length ? '' : html`<p>No draws yet</p>`}
      <ol aria-labelledby="history-heading">${this.calledNumbers.map((number, index) => html`
        <li aria-current=${index === this.calledNumbers.length - 1 ? 'true' : nothing}>
          <bingo-number .value=${number} .compact=${true} ?latest=${index === this.calledNumbers.length - 1}></bingo-number>
        </li>`)}</ol>`;
  }
}

customElements.define('bingo-call-history', BingoCallHistory);
