import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

// Operator Tongo trigger with private playback progress. Presentation only: pressing dispatches an intent.
export class BingoTongoControl extends LitElement {
  static properties = { disabled: { type: Boolean }, progress: { attribute: false }, error: { attribute: false } };
  static styles = css`
    :host { display: grid; gap: var(--bingo-space-small); justify-items: start; margin-top: var(--bingo-space-section); }
    p { margin: 0; }
    .error { color: var(--bingo-color-danger); font-weight: var(--bingo-font-emphasis); }
    progress { width: 100%; accent-color: var(--bingo-color-accent); }
  `;
  constructor() { super(); this.disabled = true; this.progress = null; this.error = null; }
  get button() { return this.shadowRoot.querySelector('bingo-button').button; }
  play() {
    if (this.disabled || this.progress !== null) return;
    this.dispatchEvent(new CustomEvent('tongo-play', { bubbles: true, composed: true }));
  }
  render() {
    const playing = this.progress !== null;
    return html`<p>Si una reclamación de línea o bingo comprobada fuera de la app no es válida,
        celébralo en la pantalla pública. No cambia la partida.</p>
      <bingo-button ?disabled=${this.disabled || playing} @click=${() => this.play()}>Tongo</bingo-button>
      ${playing ? html`<label for="tongo-progress">Tongo en la pantalla pública</label>
        <progress id="tongo-progress" max="100" .value=${Math.round(this.progress * 100)}></progress>` : ''}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ''}`;
  }
}

customElements.define('bingo-tongo-control', BingoTongoControl);
