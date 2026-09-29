import { LitElement, css, html, nothing } from 'lit';
import { busyIndicator, busyStyles } from './bingo-field.mjs';

// The action row that ends a form: an optional status (slot="status") at the start, then the
// secondary actions (default slot) and the primary action (slot="primary") last, at the end.
// `sticky` keeps the row visible at the bottom of a scrolling form; `pending` marks it busy.
export class BingoFormActions extends LitElement {
  static properties = { sticky: { type: Boolean, reflect: true }, pending: { type: Boolean, reflect: true } };
  static styles = [busyStyles, css`
    :host {
      display: flex; flex-wrap: wrap; align-items: center;
      gap: var(--bingo-space-small) var(--bingo-space-inset-inline);
      padding-block-start: var(--bingo-space-inset-inline);
      border-top: var(--bingo-border-width-default) solid var(--bingo-color-border);
    }
    :host([hidden]) { display: none; }
    :host([sticky]) {
      position: sticky; bottom: 0; z-index: 1;
      padding-block: var(--bingo-space-inset-inline);
      background: var(--bingo-color-canvas);
    }
    .status {
      display: flex; flex: 1 1 12rem; align-items: center; gap: var(--bingo-space-small); min-width: 0;
      font-size: calc(var(--bingo-font-size) * 0.875);
    }
    .buttons { display: flex; flex-wrap: wrap; gap: var(--bingo-space-small); margin-inline-start: auto; }
    ::slotted(bingo-button) { flex: none; }
  `];

  constructor() {
    super();
    this.sticky = false; this.pending = false;
    this.internals = this.attachInternals();
    this.internals.role = 'group';
  }

  updated(changed) {
    if (changed.has('pending')) this.internals.ariaBusy = String(this.pending);
  }

  render() {
    return html`<div class="status">${this.pending ? busyIndicator : nothing}<slot name="status"></slot></div>
      <div class="buttons"><slot></slot><slot name="primary"></slot></div>`;
  }
}

customElements.define('bingo-form-actions', BingoFormActions);
