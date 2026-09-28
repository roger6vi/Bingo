import { LitElement, css, html } from 'lit';

class BingoPanel extends LitElement {
  static properties = { heading: { type: String } };
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
    h2 {
      margin: 0 0 var(--bingo-space-section);
      font: var(--bingo-font-emphasis) var(--bingo-font-size)/var(--bingo-font-line) var(--bingo-font-body);
      letter-spacing: var(--bingo-font-tracking);
      text-transform: uppercase;
    }
  `;
  constructor() { super(); this.heading = ''; }
  render() {
    return html`<section aria-labelledby="panel-heading"><h2 id="panel-heading">${this.heading}</h2><slot></slot></section>`;
  }
}

customElements.define('bingo-panel', BingoPanel);
