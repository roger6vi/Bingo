import { LitElement, html } from 'lit';

class BingoShell extends LitElement {
  render() {
    return html`<slot></slot>`;
  }
}

customElements.define('bingo-shell', BingoShell);
