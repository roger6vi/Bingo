import { LitElement, css, html } from 'lit';

class BingoLatestDraw extends LitElement {
  static properties = { latest: { type: Number }, loaded: { type: Boolean }, announcement: { state: true } };
  static styles = css`
    :host { display: block; text-align: center; }
    .announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  constructor() { super(); this.latest = null; this.loaded = false; this.announcement = ''; }
  willUpdate(changed) {
    if (changed.has('latest') && this.latest !== null && this.latest !== changed.get('latest')) {
      this.announcement = `Latest draw: ${this.latest}`;
    }
  }
  render() {
    return html`<slot></slot>
      <span class="announcement" aria-live="polite" aria-atomic="true">${this.announcement}</span>`;
  }
}

customElements.define('bingo-latest-draw', BingoLatestDraw);
