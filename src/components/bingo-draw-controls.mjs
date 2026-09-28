import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

export class BingoDrawControls extends LitElement {
  static properties = {
    manualDisabled: { type: Boolean }, digitalDisabled: { type: Boolean }, reloadDisabled: { type: Boolean },
  };
  static styles = css`
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: var(--bingo-space-small); margin-top: var(--bingo-space-section); }
    label { flex-basis: 100%; }
    input {
      width: 6ch; padding: var(--bingo-space-inset-compact); font: inherit;
      color: var(--bingo-color-text); background: var(--bingo-color-surface-sunken);
      border: var(--bingo-border-width-default) solid var(--bingo-color-border-strong);
      border-radius: var(--bingo-radius-control);
    }
    input:focus-visible {
      outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small);
    }
  `;
  constructor() {
    super(); this.manualDisabled = true; this.digitalDisabled = true; this.reloadDisabled = false;
  }
  get manualInput() { return this.shadowRoot.querySelector('input'); }
  get manualButton() { return this.shadowRoot.querySelector('#draw-manual').button; }
  get digitalButton() { return this.shadowRoot.querySelector('#draw-digital').button; }
  get reloadButton() { return this.shadowRoot.querySelector('#reload-event').button; }
  render() {
    return html`<label for="manual-number">Manual number (1–90)</label>
      <input id="manual-number" type="number" min="1" max="90" step="1" inputmode="numeric" required ?disabled=${this.manualDisabled}>
      <bingo-button id="draw-manual" ?disabled=${this.manualDisabled}>Draw manual number</bingo-button>
      <bingo-button id="draw-digital" ?disabled=${this.digitalDisabled}>Draw digital number</bingo-button>
      <bingo-button id="reload-event" ?disabled=${this.reloadDisabled}>Reload event</bingo-button>`;
  }
}

customElements.define('bingo-draw-controls', BingoDrawControls);
