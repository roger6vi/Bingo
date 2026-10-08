import { LitElement, css, html } from 'lit';

// Operator line-lot panel. Presentation only: it renders the supplied controller state and dispatches
// payloadless intents (line-lot-draw, line-lot-resync). It never reads, draws, selects or recomputes a winner.
const COLORS = Object.freeze({ red: 'Rojo', blue: 'Azul', green: 'Verde', yellow: 'Amarillo', purple: 'Morado', orange: 'Naranja' });
const PRESENTATION = Object.freeze({
  pending: 'pendiente', started: 'en curso', completed: 'completada', failed: 'fallida', interrupted: 'interrumpida',
});
const COPY = Object.freeze({
  unknown: 'Estado del lote desconocido.',
  loading: 'Leyendo el estado del lote…',
  pending: 'El lote aún no se puede sortear.',
  actionable: 'Lote listo para sortear.',
  resolved: 'Lote resuelto.',
  recovery: 'Resultado incierto: relee el estado del lote; no se vuelve a sortear.',
  error: 'No se pudo leer el lote: relee el estado para continuar.',
});
const RESYNC_STATES = ['actionable', 'pending', 'resolved', 'recovery', 'error'];

export class BingoLineLot extends LitElement {
  static properties = { state: { attribute: false } };
  static styles = css`
    :host { display: block; }
    [aria-busy] { display: grid; gap: var(--bingo-space-small); }
    p { margin: 0; color: var(--bingo-color-text); }
    .outcome { font-weight: var(--bingo-font-emphasis); }
    progress { width: 100%; accent-color: var(--bingo-color-accent); }
    .actions { display: flex; gap: var(--bingo-space-small); }
    button {
      font: inherit; color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border-strong); border-radius: var(--bingo-radius-control);
      padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline); cursor: pointer;
    }
    button:disabled {
      color: var(--bingo-color-disabled); background: var(--bingo-color-disabled-surface);
      border-color: var(--bingo-color-border); cursor: not-allowed; opacity: var(--bingo-opacity-disabled);
    }
    button:focus-visible { outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small); }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  constructor() { super(); this.state = null; }

  // Conservative view of the supplied state: anything absent or malformed behaves as unknown.
  get view() {
    const s = this.state;
    if (s === null || typeof s !== 'object') return { status: 'unknown', busy: false };
    const status = Object.hasOwn(COPY, s.status) ? s.status : 'unknown';
    return { ...s, status, busy: s.busy === true };
  }
  get canDraw() { const v = this.view; return v.status === 'actionable' && v.canDraw === true && !v.busy; }
  get canResync() { const v = this.view; return !v.busy && RESYNC_STATES.includes(v.status); }
  requestDraw() { if (this.canDraw) this.intent('line-lot-draw'); }
  requestResync() { if (this.canResync) this.intent('line-lot-resync'); }
  intent(name) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true })); }

  outcome(v) {
    if (v.status !== 'resolved') return null;
    const w = v.winner;
    if (v.snapshot?.fact?.resolution === 'not_required') return 'Resuelto sin sorteo: no hubo empate que desempatar.';
    if (w?.kind === 'number' && Number.isSafeInteger(w.participantNumber) && Object.hasOwn(COLORS, w.colorId)) {
      return `Ganador: participante ${w.participantNumber}, color ${COLORS[w.colorId]}.`;
    }
    return 'Ganador desconocido: resultado anterior sin número ni color registrados.';
  }
  context(v) {
    const s = v.snapshot;
    if (s === null || typeof s !== 'object') return [];
    const out = [];
    if (typeof s.lot === 'string' && s.lot !== '') out.push(`Lote: ${s.lot}`);
    if (Number.isSafeInteger(s.winnerCount)) out.push(`Ganadores: ${s.winnerCount}`);
    const p = PRESENTATION[s.presentation?.status];
    if (p) out.push(`Presentación: ${p}`);
    return out;
  }
  render() {
    const v = this.view;
    const message = typeof v.message === 'string' && v.message !== '' ? v.message : null;
    return html`<div aria-busy=${v.busy ? 'true' : 'false'}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>${v.busy ? 'Sorteo en curso…' : COPY[v.status]}</p>
        ${this.outcome(v) === null ? '' : html`<p class="outcome">${this.outcome(v)}</p>`}
        ${this.context(v).map((line) => html`<p>${line}</p>`)}
        ${message === null ? '' : html`<p>${message}</p>`}
      </div>
      ${v.busy ? html`<progress aria-label="Sorteo del lote en curso"></progress>` : ''}
      <div class="actions">
        <button type="button" data-intent="draw" ?disabled=${!this.canDraw} @click=${() => this.requestDraw()}>Sortear lote</button>
        <button type="button" data-intent="resync" ?disabled=${!this.canResync} @click=${() => this.requestResync()}>Releer estado</button>
      </div>
    </div>`;
  }
}

customElements.define('bingo-line-lot', BingoLineLot);
