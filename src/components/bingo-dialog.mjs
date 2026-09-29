import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

export class BingoDialog extends LitElement {
  // Each action's button dispatches its signal; Escape always dispatches 'dismiss'.
  static properties = { label: { type: String }, actions: { attribute: false } };
  static styles = css`
    dialog {
      max-width: min(90vw, 40rem); padding: var(--bingo-space-layout);
      color: var(--bingo-color-text); background: var(--bingo-color-surface-raised);
      border: var(--bingo-border-width-strong) solid var(--bingo-color-border-strong); border-radius: var(--bingo-radius-surface);
      box-shadow: var(--bingo-elevation-raised) var(--bingo-elevation-raised) 0 var(--bingo-color-shadow);
    }
    dialog::backdrop { background: var(--bingo-color-overlay); opacity: var(--bingo-opacity-scrim); }
    .actions { display: flex; gap: var(--bingo-space-section); margin-top: var(--bingo-space-section); }
    h2 { font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body); }
  `;
  constructor() {
    super();
    this.label = '';
    this.opener = null;
    this.actions = [{ action: 'cancel', label: 'Cancelar', signal: 'dismiss' }, { action: 'confirm', label: 'Confirmar', signal: 'confirm' }];
  }
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
        ${this.actions.map(({ action, label, signal }) => html`<bingo-button data-action=${action}
          @click=${() => this.finish(signal)}>${label}</bingo-button>`)}
      </div>
    </dialog>`;
  }
}

customElements.define('bingo-dialog', BingoDialog);
