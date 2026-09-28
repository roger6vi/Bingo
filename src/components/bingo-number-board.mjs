import { LitElement, css, html, nothing } from 'lit';
import './bingo-number.mjs';

class BingoNumberBoard extends LitElement {
  static properties = {
    calledNumbers: { attribute: false },
    loaded: { type: Boolean },
  };
  static styles = css`
    :host { display: block; min-width: 0; }
    ol {
      display: flex; flex-wrap: wrap;
      gap: var(--bingo-space-inset-compact) var(--bingo-space-section);
      margin: 0; padding-inline-start: var(--bingo-space-list-indent);
    }
    li { padding-inline-end: var(--bingo-space-inset-compact); }
    li[aria-current] { outline: var(--bingo-border-width-strong) solid var(--bingo-color-accent); outline-offset: var(--bingo-space-small); }
  `;
  constructor() { super(); this.calledNumbers = []; this.loaded = false; }
  render() {
    return html`${!this.loaded ? html`<p>Waiting for draw</p>` :
      this.calledNumbers.length === 0 ? html`<p>No draws yet</p>` : ''}
      <ol aria-label="Called numbers in draw order">
        ${this.calledNumbers.map((number, index) => html`<li aria-current=${index === this.calledNumbers.length - 1 ? 'true' : nothing}>
          <bingo-number .value=${number} .compact=${true} ?latest=${index === this.calledNumbers.length - 1}></bingo-number>
        </li>`)}
      </ol>`;
  }
}

customElements.define('bingo-number-board', BingoNumberBoard);
