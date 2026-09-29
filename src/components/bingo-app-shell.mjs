import { LitElement, css, html } from 'lit';

// Full-viewport application frame: a header row (brand and tabs), the content row, and an optional
// status bar. The frame is pinned to the window, so the document itself never scrolls; content that
// does not fit scrolls inside its own panel.
export class BingoAppShell extends LitElement {
  static properties = { hasStatus: { state: true } };
  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; grid-template-rows: auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr);
      overflow: hidden;
      color: var(--bingo-color-text); background: var(--bingo-color-canvas);
    }
    ::slotted(*) { min-width: 0; min-height: 0; }
    .status[hidden] { display: none; }
  `;
  constructor() { super(); this.hasStatus = false; }
  statusChanged(event) { this.hasStatus = event.target.assignedElements().length > 0; }
  render() {
    return html`<slot name="header"></slot><slot></slot>
      <div class="status" ?hidden=${!this.hasStatus}><slot name="status" @slotchange=${this.statusChanged}></slot></div>`;
  }
}

customElements.define('bingo-app-shell', BingoAppShell);
