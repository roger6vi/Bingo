import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

// Operator Tongo trigger with private playback progress. Presentation only: pressing dispatches an intent.
// It takes one claims-grid cell and never changes height: progress overlays the button's lower edge.
export class BingoTongoControl extends LitElement {
  static properties = { disabled: { type: Boolean }, progress: { attribute: false } };
  static styles = css`
    :host { display: block; position: relative; }
    bingo-button::part(button) { font-weight: var(--bingo-font-emphasis); }
    progress {
      position: absolute; inset-inline: var(--bingo-space-small); bottom: var(--bingo-space-small);
      width: auto; height: var(--bingo-space-small); margin: 0; accent-color: var(--bingo-color-accent);
      /* Drop the native rounded bar so the corners follow radius.control like every other control. */
      appearance: none; border: 0; border-radius: var(--bingo-radius-control); background: var(--bingo-color-surface);
    }
    progress::-webkit-progress-bar { border-radius: var(--bingo-radius-control); background: var(--bingo-color-surface); }
    progress::-webkit-progress-value { border-radius: var(--bingo-radius-control); background: var(--bingo-color-accent); }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  constructor() { super(); this.disabled = true; this.progress = null; }
  get button() { return this.shadowRoot.querySelector('bingo-button').button; }
  play() {
    if (this.disabled || this.progress !== null) return;
    this.dispatchEvent(new CustomEvent('tongo-play', { bubbles: true, composed: true }));
  }
  render() {
    const playing = this.progress !== null;
    return html`<bingo-button block ?disabled=${this.disabled || playing} @click=${() => this.play()}>Tongo</bingo-button>
      ${playing ? html`<label class="visually-hidden" for="tongo-progress">Tongo en la pantalla pública</label>
        <progress id="tongo-progress" max="100" .value=${Math.round(this.progress * 100)}></progress>`
        : html`<p class="visually-hidden">Muestra el Tongo en la pantalla pública tras una reclamación no válida
          comprobada fuera de la app. No cambia la partida.</p>`}`;
  }
}

customElements.define('bingo-tongo-control', BingoTongoControl);
