import { LitElement, css, html, nothing } from 'lit';

const NUMBERS = Array.from({ length: 90 }, (_, index) => index + 1);

// The audience's passive 1–90 board: a fixed ten-column grid (1–10 … 81–90) that only recolours
// numbers as committed calls arrive. It has no controls, focus stops or live region.
class BingoNumberBoard extends LitElement {
  static properties = {
    calledNumbers: { attribute: false },
    loaded: { type: Boolean },
  };
  static styles = css`
    :host { display: block; min-width: 0; aspect-ratio: 10 / 9; container-type: inline-size; }
    ol {
      display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); grid-template-rows: repeat(9, minmax(0, 1fr));
      gap: max(2px, 0.8cqw); height: 100%; margin: 0; padding: 0; list-style: none;
    }
    li {
      display: grid; place-items: center; min-width: 0; box-sizing: border-box;
      font: var(--bingo-font-emphasis) calc(100cqw / 10 * 0.4)/1 var(--bingo-font-body); font-variant-numeric: tabular-nums;
      color: var(--bingo-color-call-uncalled); background: var(--bingo-color-call-uncalled-surface);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border); border-radius: var(--bingo-radius-control);
    }
    li[data-state="called"] {
      color: var(--bingo-color-call-called); background: var(--bingo-color-call-called-surface); border-color: var(--bingo-color-call-called-surface);
    }
    li[data-state="latest"] {
      color: var(--bingo-color-call-latest); background: var(--bingo-color-call-latest-surface); border-color: var(--bingo-color-call-latest-surface);
    }
    li[aria-current] { outline: var(--bingo-border-width-strong) solid var(--bingo-color-accent); outline-offset: var(--bingo-space-small); }
    .note { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  constructor() { super(); this.calledNumbers = []; this.loaded = false; }
  render() {
    const called = new Set(this.calledNumbers);
    const latest = this.calledNumbers.at(-1);
    return html`<p class="note">${!this.loaded ? 'Waiting for draw' : called.size === 0 ? 'No draws yet' : ''}</p>
      <ol aria-label="Numbers 1 to 90">
        ${NUMBERS.map((number) => {
          const state = number === latest ? 'latest' : called.has(number) ? 'called' : 'uncalled';
          return html`<li data-state=${state} aria-current=${state === 'latest' ? 'true' : nothing}>${number}${state === 'uncalled' ? nothing
            : html`<span class="note">, ${state === 'latest' ? 'latest call' : 'called'}</span>`}</li>`;
        })}
      </ol>`;
  }
}

customElements.define('bingo-number-board', BingoNumberBoard);
