import { LitElement, css, html, nothing } from 'lit';
import './bingo-number.mjs';

// Called numbers in draw order, the latest marked with aria-current. With `limit` it is a compact
// strip of only the last calls (still in draw order), for the side rail.
class BingoCallHistory extends LitElement {
  static properties = { calledNumbers: { attribute: false }, limit: { type: Number } };
  static styles = css`
    :host { display: block; min-width: 0; }
    h3 { margin: 0 0 0.5rem; font-size: 0.8125rem; color: var(--bingo-color-muted); }
    p { margin: 0; color: var(--bingo-color-muted); }
    ol { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin: 0; padding: 0; list-style: none; }
    li[aria-current] { outline: 2px solid var(--bingo-color-text); outline-offset: 3px; }
    /* The strip sits under the latest call; its heading stays for assistive technology only. */
    .strip h3 { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .strip ol { flex-wrap: nowrap; gap: 0.25rem; overflow: hidden; }
    .strip li { flex: 1 1 0; min-width: 0; max-width: 2.75rem; }
    .strip .chip { min-width: 0; width: 100%; }
    .chip {
      display: grid; place-items: center; min-width: 2rem; height: 1.75rem; box-sizing: border-box; padding-inline: 0.25rem;
      border: 1px solid var(--bingo-color-border); border-radius: 0.25rem;
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      font-weight: var(--bingo-font-emphasis); font-variant-numeric: tabular-nums;
    }
    .strip li[aria-current] { outline: none; }
    .strip li[aria-current] .chip { color: var(--bingo-color-canvas); background: var(--bingo-color-accent); border-color: var(--bingo-color-accent); }
  `;
  constructor() { super(); this.calledNumbers = []; this.limit = 0; }
  render() {
    const strip = this.limit > 0;
    const shown = strip ? this.calledNumbers.slice(-this.limit) : this.calledNumbers;
    return html`<div class=${strip ? 'strip' : 'full'}><h3 id="history-heading">${strip ? 'Últimas bolas (orden de salida)' : 'Bolas cantadas (orden de salida)'}</h3>
      ${this.calledNumbers.length ? '' : html`<p>Aún no hay bolas cantadas</p>`}
      <ol aria-labelledby="history-heading">${shown.map((number, index) => html`
        <li aria-current=${index === shown.length - 1 ? 'true' : nothing}>
          ${strip ? html`<span class="chip">${number}</span>` : html`<bingo-number .value=${number} .compact=${true}></bingo-number>`}
        </li>`)}</ol></div>`;
  }
}

customElements.define('bingo-call-history', BingoCallHistory);
