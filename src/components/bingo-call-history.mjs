import { LitElement, css, html, nothing } from 'lit';
import './bingo-number.mjs';

// Called numbers in draw order, the latest marked with aria-current.
class BingoCallHistory extends LitElement {
  static properties = { calledNumbers: { attribute: false } };
  static styles = css`
    :host { display: block; min-width: 0; }
    h3 { margin: 0 0 0.5rem; font-size: 0.8125rem; color: var(--bingo-color-muted); }
    p { margin: 0; color: var(--bingo-color-muted); }
    ol { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin: 0; padding: 0; list-style: none; }
    li[aria-current] { outline: 2px solid var(--bingo-color-text); outline-offset: 3px; }
  `;
  constructor() { super(); this.calledNumbers = []; }
  render() {
    return html`<h3 id="history-heading">Bolas cantadas (orden de salida)</h3>
      ${this.calledNumbers.length ? '' : html`<p>Aún no hay bolas cantadas</p>`}
      <ol aria-labelledby="history-heading">${this.calledNumbers.map((number, index) => html`
        <li aria-current=${index === this.calledNumbers.length - 1 ? 'true' : nothing}>
          <bingo-number .value=${number} .compact=${true}></bingo-number>
        </li>`)}</ol>`;
  }
}

customElements.define('bingo-call-history', BingoCallHistory);
