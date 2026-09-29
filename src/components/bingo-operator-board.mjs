import { LitElement, css, html, nothing } from 'lit';

const NUMBERS = Array.from({ length: 90 }, (_, index) => index + 1);
const ROWS = Array.from({ length: 9 }, (_, row) => NUMBERS.slice(row * 10, row * 10 + 10));

// The operator's 1–90 board: ten numbers per row in numeric order (1–10 … 81–90). It renders only the
// committed calls it is given and never marks a number called on its own. In manual mode (not
// `readonly`) activating an uncalled number dispatches `number-select`; the caller draws it through the
// validated IPC and the board changes only when the acknowledged snapshot arrives. `pending` marks the
// request in flight, `stale` a history that may be out of date, `disabled` a board that cannot draw.
export class BingoOperatorBoard extends LitElement {
  static properties = {
    calledNumbers: { attribute: false },
    loaded: { type: Boolean, reflect: true },
    readonly: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    pending: { type: Boolean, reflect: true },
    pendingNumber: { type: Number },
    stale: { type: Boolean, reflect: true },
    active: { state: true },
    announcement: { state: true },
  };
  static styles = css`
    :host {
      display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 0.625rem;
      min-width: 0; min-height: 0; color: var(--bingo-color-text); background: var(--bingo-color-surface);
    }
    .bar {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.375rem 1rem;
      min-height: 1.75rem; font-size: 0.8125rem; color: var(--bingo-color-muted);
    }
    .legend { display: flex; flex-wrap: wrap; gap: 0.25rem 0.875rem; margin: 0; padding: 0; list-style: none; }
    .legend li { display: inline-flex; align-items: center; gap: 0.375rem; }
    .swatch {
      display: inline-block; width: 0.875rem; height: 0.875rem; box-sizing: border-box;
      border: 1px solid var(--bingo-color-border); border-radius: 0.1875rem; background: var(--bingo-color-surface);
    }
    .swatch.called { border-color: var(--bingo-color-accent); background: var(--bingo-color-accent); }
    .swatch.latest { border-color: var(--bingo-color-accent); background: var(--bingo-color-accent); outline: 2px solid var(--bingo-color-text); outline-offset: 1px; }
    .state {
      padding: 0.125rem 0.625rem; border: 1px solid var(--bingo-color-border); border-radius: 999px;
      color: var(--bingo-color-text); background: var(--bingo-color-surface); font-weight: var(--bingo-font-emphasis); white-space: nowrap;
    }
    .state.warning { color: var(--bingo-color-danger); border-color: var(--bingo-color-danger); }

    .stage { container-type: size; display: grid; place-items: center; min-width: 0; min-height: 0; }
    .board {
      /* Cells keep an aspect between square and 1.6:1 and grow with the space available. */
      --board-height: min(100cqh, 100cqw * 0.9);
      display: grid; grid-template-rows: repeat(9, minmax(0, 1fr)); gap: clamp(0.1875rem, 0.8cqmin, 0.5rem);
      width: min(100cqw, 100cqh * 1.78); height: var(--board-height);
      font-size: max(0.875rem, calc(var(--board-height) / 9 * 0.44));
      border-radius: var(--bingo-radius-surface);
    }
    :host([stale]) .board { outline: 2px dashed var(--bingo-color-danger); outline-offset: 0.375rem; }
    :host([pending]) .board { cursor: progress; }
    [role="row"] { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: inherit; min-height: 0; }
    [role="gridcell"] { display: grid; min-width: 0; min-height: 0; }
    .cell {
      position: relative; display: grid; place-items: center;
      min-width: 0; min-height: 0; margin: 0; padding: 0;
      font: var(--bingo-font-emphasis) 1em/1 var(--bingo-font-body); font-variant-numeric: tabular-nums;
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: 1px solid var(--bingo-color-border); border-radius: calc(var(--bingo-radius-surface) * 0.75);
      cursor: pointer;
      transition: background-color var(--bingo-motion-normal), border-color var(--bingo-motion-normal);
    }
    :host([readonly]) .cell[data-state="uncalled"] { color: var(--bingo-color-muted); }
    .cell[aria-disabled="true"] { cursor: default; }
    :host([pending]) .cell { cursor: progress; }
    .cell[data-state="uncalled"]:not([aria-disabled="true"]):hover {
      border-color: var(--bingo-color-accent);
      background: color-mix(in srgb, var(--bingo-color-accent) 14%, var(--bingo-color-surface));
    }
    .cell[data-state="called"], .cell[data-state="latest"] {
      color: var(--bingo-color-canvas); background: var(--bingo-color-accent); border-color: var(--bingo-color-accent);
    }
    .cell[data-state="latest"] {
      z-index: 1;
      outline: max(3px, 0.08em) solid var(--bingo-color-text); outline-offset: max(2px, 0.05em);
      animation: arrive calc(var(--bingo-motion-normal) * 4) ease-out;
    }
    .cell[data-state="disabled"] { color: var(--bingo-color-muted); background: var(--bingo-color-canvas); cursor: not-allowed; }
    .cell[data-pending] { border-style: dashed; border-color: var(--bingo-color-accent); border-width: 2px; }
    .badge {
      position: absolute; inset: 0.3em 0 auto; text-align: center;
      font-size: max(0.5625rem, 0.2em); letter-spacing: 0.08em; text-transform: uppercase;
    }
    .cell:focus-visible { z-index: 2; outline: 3px solid var(--bingo-color-focus); outline-offset: 2px; }
    .announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @keyframes arrive { from { transform: scale(1.12); } to { transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) {
      .cell { transition: none; }
      .cell[data-state="latest"] { animation: none; }
    }
  `;
  constructor() {
    super();
    this.calledNumbers = [];
    this.loaded = false;
    this.readonly = false;
    this.disabled = false;
    this.pending = false;
    this.pendingNumber = null;
    this.stale = false;
    this.active = 1;
    this.announcement = '';
    this.announced = undefined;
  }
  get latest() { return this.calledNumbers.at(-1) ?? null; }
  cell(number) { return this.shadowRoot?.querySelector(`[data-number="${number}"]`) ?? null; }
  willUpdate(changed) {
    // Announce each newly committed latest call, not the history present when an event first loads.
    if (changed.has('loaded') && !this.loaded) this.announced = undefined;
    if ((changed.has('calledNumbers') || changed.has('loaded')) && this.loaded) {
      const latest = this.latest;
      if (this.announced !== undefined && latest !== null && latest !== this.announced) {
        this.announcement = `Última bola cantada: ${latest}`;
      }
      this.announced = latest;
    }
    if (!this.pending) this.pendingNumber = null;
  }
  state(number, called) {
    if (number === this.latest) return 'latest';
    if (called.has(number)) return 'called';
    return this.disabled || !this.loaded ? 'disabled' : 'uncalled';
  }
  label(number, state) {
    const status = { latest: 'última bola cantada', called: 'cantado', uncalled: 'sin cantar', disabled: 'sin cantar' }[state];
    return `Número ${number}, ${number === this.pendingNumber ? 'cantándose' : status}`;
  }
  // Only an uncalled number on an enabled, idle, manual board can be called.
  callable(number) {
    return this.loaded && !this.readonly && !this.disabled && !this.pending && !this.calledNumbers.includes(number);
  }
  activate(number) {
    this.active = number;
    if (!this.callable(number)) return;
    this.pendingNumber = number;
    this.dispatchEvent(new CustomEvent('number-select', { detail: { number }, bubbles: true, composed: true }));
  }
  async onKeydown(event) {
    const number = Number(event.target.dataset?.number);
    if (!number) return;
    const column = (number - 1) % 10;
    const next = {
      ArrowRight: number + 1, ArrowLeft: number - 1, ArrowDown: number + 10, ArrowUp: number - 10,
      Home: event.ctrlKey ? 1 : number - column, End: event.ctrlKey ? 90 : number - column + 9,
      PageUp: column + 1, PageDown: 81 + column,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    if (next < 1 || next > 90) return;
    this.active = next;
    await this.updateComplete;
    this.cell(next)?.focus();
  }
  render() {
    const called = new Set(this.calledNumbers);
    const readonly = this.readonly || this.disabled || !this.loaded;
    const status = !this.loaded ? ['Esperando el evento', ''] : this.stale ? ['Puede estar desactualizado', 'warning']
      : this.pending ? ['Guardando…', ''] : this.readonly ? ['Solo lectura (modo digital)', '']
        : this.disabled ? ['No se puede cantar', ''] : ['Pulsa un número para cantarlo', ''];
    return html`<div class="bar">
        <ul class="legend" aria-hidden="true">
          <li><span class="swatch"></span>Sin cantar</li>
          <li><span class="swatch called"></span>Cantado</li>
          <li><span class="swatch latest"></span>Última</li>
        </ul>
        <span class="state ${status[1]}">${status[0]}</span>
      </div>
      <div class="stage">
        <div class="board" role="grid" aria-label="Tablero de números del 1 al 90" aria-rowcount="9" aria-colcount="10"
          aria-readonly=${readonly ? 'true' : 'false'} aria-busy=${this.pending ? 'true' : 'false'}
          @keydown=${this.onKeydown}>
          ${ROWS.map((row, rowIndex) => html`<div role="row" aria-rowindex=${rowIndex + 1}>
            ${row.map((number, columnIndex) => {
              const state = this.state(number, called);
              return html`<div role="gridcell" aria-colindex=${columnIndex + 1}>
                <button type="button" class="cell" data-number=${number} data-state=${state}
                  ?data-pending=${number === this.pendingNumber}
                  tabindex=${number === this.active ? 0 : -1}
                  aria-label=${this.label(number, state)}
                  aria-disabled=${this.callable(number) ? nothing : 'true'}
                  @click=${() => this.activate(number)}>
                  ${state === 'latest' ? html`<span class="badge" aria-hidden="true">Última</span>` : ''}${number}
                </button>
              </div>`;
            })}
          </div>`)}
        </div>
      </div>
      <span class="announcement" aria-live="polite" aria-atomic="true">${this.announcement}</span>`;
  }
}

customElements.define('bingo-operator-board', BingoOperatorBoard);
