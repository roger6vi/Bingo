import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

export class BingoDialog extends LitElement {
  static properties = { label: { type: String } };
  static styles = css`
    dialog {
      max-width: min(90vw, 40rem); padding: var(--bingo-space-layout);
      color: var(--bingo-color-text); background: var(--bingo-color-surface);
      border: 2px solid var(--bingo-color-border); border-radius: var(--bingo-radius-surface);
    }
    dialog::backdrop { background: var(--bingo-color-canvas); opacity: 0.8; }
    .actions { display: flex; gap: var(--bingo-space-section); margin-top: var(--bingo-space-section); }
    h2 { font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body); }
  `;
  constructor() { super(); this.label = ''; this.opener = null; }
  async show() {
    this.opener = document.activeElement;
    await this.updateComplete;
    this.shadowRoot.querySelector('dialog').showModal();
  }
  finish(signal) {
    this.shadowRoot.querySelector('dialog').close();
    this.dispatchEvent(new Event(signal));
    if (this.opener?.isConnected) this.opener.focus();
  }
  cancel(event) { event.preventDefault(); this.finish('dismiss'); }
  render() {
    return html`<dialog aria-labelledby="dialog-heading" @cancel=${this.cancel}>
      <h2 id="dialog-heading">${this.label}</h2><slot></slot>
      <div class="actions">
        <bingo-button data-action="cancel" @click=${() => this.finish('dismiss')}>Cancel</bingo-button>
        <bingo-button data-action="confirm" @click=${() => this.finish('confirm')}>Confirm</bingo-button>
      </div>
    </dialog>`;
  }
}

customElements.define('bingo-dialog', BingoDialog);
