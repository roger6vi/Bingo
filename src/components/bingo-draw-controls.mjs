import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

// Draw controls for the side rail. `mode` is the operator's draw mode: "manual" calls the number the
// operator types (or picks on the board); "digital" draws one at random. Switching dispatches
// `mode-change`; the draws themselves are wired by the page.
export class BingoDrawControls extends LitElement {
  static properties = {
    manualDisabled: { type: Boolean }, digitalDisabled: { type: Boolean }, reloadDisabled: { type: Boolean },
    mode: { type: String, reflect: true },
  };
  static styles = css`
    :host { display: grid; gap: 0.5rem; }
    [hidden] { display: none !important; }
    .modes {
      display: grid; grid-template-columns: 1fr 1fr; margin: 0; padding: 0.1875rem; border: 0;
      border-radius: var(--bingo-radius-control); background: var(--bingo-color-canvas);
    }
    .modes label {
      position: relative; display: grid; place-items: center; min-height: 1.75rem;
      border-radius: var(--bingo-radius-control); color: var(--bingo-color-muted);
      font-weight: var(--bingo-font-emphasis); cursor: pointer;
    }
    .modes label:has(:checked) {
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      box-shadow: 0 0 0 1px var(--bingo-color-border);
    }
    .modes label:has(:focus-visible) { outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: 1px; }
    .modes input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
    .group { display: grid; gap: 0.375rem; }
    label[for] { font-size: 0.8125rem; color: var(--bingo-color-muted); }
    .manual { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
    input[type="number"] {
      min-width: 0; box-sizing: border-box; padding: 0.375rem 0.5rem; font: inherit;
      font-weight: var(--bingo-font-emphasis); font-variant-numeric: tabular-nums;
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border); border-radius: var(--bingo-radius-control);
    }
    input[type="number"]:disabled { background: var(--bingo-color-disabled-surface); }
    input[type="number"]:focus-visible { outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: 1px; }
    bingo-button::part(button) {
      min-height: 2.25rem; padding-inline: 0.5rem; white-space: nowrap;
      border-radius: var(--bingo-radius-control);
    }
    #draw-digital::part(button) { min-height: 2.75rem; font-size: 1rem; }
    #reload-event::part(button) { min-height: 1.875rem; font-size: 0.8125rem; }
  `;
  constructor() {
    super(); this.manualDisabled = true; this.digitalDisabled = true; this.reloadDisabled = false; this.mode = 'manual';
  }
  get manualInput() { return this.shadowRoot.querySelector('#manual-number'); }
  get manualButton() { return this.shadowRoot.querySelector('#draw-manual').button; }
  get digitalButton() { return this.shadowRoot.querySelector('#draw-digital').button; }
  get reloadButton() { return this.shadowRoot.querySelector('#reload-event').button; }
  modeInput(mode) { return this.shadowRoot.querySelector(`input[name="mode"][value="${mode}"]`); }
  choose(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.dispatchEvent(new CustomEvent('mode-change', { detail: { mode }, bubbles: true, composed: true }));
  }
  // Enter in the number field acts like the manual draw button.
  submitManual(event) {
    if (event.key !== 'Enter' || this.manualDisabled) return;
    event.preventDefault();
    this.manualButton.click();
  }
  render() {
    const digital = this.mode === 'digital';
    return html`<fieldset class="modes" aria-label="Modo de sorteo">
        ${[['manual', 'Manual', !digital], ['digital', 'Digital', digital]].map(([value, label, checked]) => html`<label>
          <input type="radio" name="mode" value=${value} .checked=${checked} @change=${() => this.choose(value)}>${label}</label>`)}
      </fieldset>
      <div class="group" ?hidden=${digital}>
        <label for="manual-number">Número cantado (1–90)</label>
        <div class="manual">
          <input id="manual-number" type="number" min="1" max="90" step="1" inputmode="numeric" required
            ?disabled=${this.manualDisabled} @keydown=${this.submitManual}>
          <bingo-button id="draw-manual" variant="primary" ?disabled=${this.manualDisabled}>Cantar número</bingo-button>
        </div>
      </div>
      <div class="group" ?hidden=${!digital}>
        <bingo-button id="draw-digital" variant="primary" block ?disabled=${this.digitalDisabled}>Sacar bola</bingo-button>
      </div>
      <bingo-button id="reload-event" block ?disabled=${this.reloadDisabled}>Recargar evento</bingo-button>`;
  }
}

customElements.define('bingo-draw-controls', BingoDrawControls);
