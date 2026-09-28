import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

export class BingoDrawControls extends LitElement {
  static properties = {
    manualDisabled: { type: Boolean }, digitalDisabled: { type: Boolean }, reloadDisabled: { type: Boolean },
  };
  static styles = css`
    :host { display: grid; gap: 0.5rem; }
    label { font-size: 0.8125rem; color: var(--bingo-color-muted); }
    .manual { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
    input {
      min-width: 0; box-sizing: border-box; padding: 0.375rem 0.5rem; font: inherit;
      font-weight: var(--bingo-font-emphasis); font-variant-numeric: tabular-nums;
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: 1px solid var(--bingo-color-border); border-radius: calc(var(--bingo-radius-surface) / 2);
    }
    input:disabled { background: var(--bingo-color-canvas); }
    input:focus-visible { outline: 2px solid var(--bingo-color-focus); outline-offset: 1px; }
    bingo-button::part(button) {
      min-height: 2.25rem; padding-inline: 0.5rem; white-space: nowrap;
      border-radius: calc(var(--bingo-radius-surface) / 2);
    }
    .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.5rem; }
  `;
  constructor() {
    super(); this.manualDisabled = true; this.digitalDisabled = true; this.reloadDisabled = false;
  }
  get manualInput() { return this.shadowRoot.querySelector('input'); }
  get manualButton() { return this.shadowRoot.querySelector('#draw-manual').button; }
  get digitalButton() { return this.shadowRoot.querySelector('#draw-digital').button; }
  get reloadButton() { return this.shadowRoot.querySelector('#reload-event').button; }
  // Enter in the number field acts like the manual draw button.
  submitManual(event) {
    if (event.key !== 'Enter' || this.manualDisabled) return;
    event.preventDefault();
    this.manualButton.click();
  }
  render() {
    return html`<label for="manual-number">Número manual (1–90)</label>
      <div class="manual">
        <input id="manual-number" type="number" min="1" max="90" step="1" inputmode="numeric" required
          ?disabled=${this.manualDisabled} @keydown=${this.submitManual}>
        <bingo-button id="draw-manual" variant="primary" ?disabled=${this.manualDisabled}>Cantar número</bingo-button>
      </div>
      <div class="actions">
        <bingo-button id="draw-digital" block ?disabled=${this.digitalDisabled}>Sacar bola digital</bingo-button>
        <bingo-button id="reload-event" block ?disabled=${this.reloadDisabled}>Recargar evento</bingo-button>
      </div>`;
  }
}

customElements.define('bingo-draw-controls', BingoDrawControls);
