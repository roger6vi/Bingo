import { LitElement, css, html } from 'lit';

// A headed surface. `compact` is the dense desktop variant used by the operator: a thin border and a
// header bar with an "actions" slot. `fill` takes the grid cell's full height and scrolls the body.
class BingoPanel extends LitElement {
  static properties = {
    heading: { type: String },
    compact: { type: Boolean, reflect: true },
    fill: { type: Boolean, reflect: true },
  };
  static styles = css`
    :host { display: block; min-width: 0; }
    section {
      height: 100%; box-sizing: border-box;
      padding: var(--bingo-space-layout);
      border: var(--bingo-border-width-strong) solid var(--bingo-color-border);
      border-radius: var(--bingo-radius-surface);
      box-shadow: var(--bingo-elevation-raised) var(--bingo-elevation-raised) 0 var(--bingo-color-shadow);
      background: var(--bingo-color-surface);
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: var(--bingo-space-inset-inline); }
    h2 {
      margin: 0 0 var(--bingo-space-section);
      font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body);
      letter-spacing: var(--bingo-font-tracking);
      text-transform: uppercase;
    }
    :host([compact]) section {
      display: flex; flex-direction: column;
      padding: 0; overflow: hidden;
      border-width: 1px; box-shadow: none;
    }
    :host([compact]) header {
      flex: none; min-height: 2.5rem; box-sizing: border-box;
      padding: 0 var(--bingo-space-inset-inline) 0 0.875rem;
      border-bottom: 1px solid var(--bingo-color-border);
    }
    :host([compact]) h2 { margin: 0; font-size: 0.75rem; letter-spacing: 0.08em; color: var(--bingo-color-muted); }
    :host([compact]) .body { padding: 0.875rem; }
    /* "fill" must not rely on a bare percentage height: an ancestor grid/flex track that ends up
       auto-sized around content (rather than stretched) leaves height: 100% resolving against an
       indefinite box, so a long list grows the section instead of scrolling inside it. Chaining an
       explicit flex column from the host down to .body keeps every level self-bounded instead. */
    :host([fill]) { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    :host([fill]) section { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    :host([fill]) .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  `;
  constructor() { super(); this.heading = ''; this.compact = false; this.fill = false; }
  render() {
    return html`<section aria-labelledby="panel-heading">
      <header><h2 id="panel-heading">${this.heading}</h2>${this.compact ? html`<slot name="actions"></slot>` : ''}</header>
      <div class="body"><slot></slot></div>
    </section>`;
  }
}

customElements.define('bingo-panel', BingoPanel);
