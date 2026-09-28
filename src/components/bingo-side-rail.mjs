import { LitElement, css, html } from 'lit';

// A labelled vertical rail beside a workspace's dominant zone. Its sections stack and scroll inside the
// rail when they do not fit; children in the "footer" slot stay pinned to the bottom.
export class BingoSideRail extends LitElement {
  static properties = { label: { type: String } };
  static styles = css`
    :host { display: block; min-width: 0; min-height: 0; }
    aside {
      display: grid; grid-template-rows: minmax(0, 1fr) auto;
      height: 100%; box-sizing: border-box; overflow: hidden;
      border: 1px solid var(--bingo-color-border);
      border-radius: var(--bingo-radius-surface);
      background: var(--bingo-color-surface);
    }
    .body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    ::slotted(*) {
      display: block;
      padding: var(--rail-inset, 0.75rem 0.875rem);
      border-top: 1px solid var(--bingo-color-border);
    }
    ::slotted(:first-child) { border-top-style: none; }
  `;
  constructor() { super(); this.label = ''; }
  render() {
    return html`<aside aria-label=${this.label}>
      <div class="body"><slot></slot></div>
      <div class="footer"><slot name="footer"></slot></div>
    </aside>`;
  }
}

customElements.define('bingo-side-rail', BingoSideRail);
