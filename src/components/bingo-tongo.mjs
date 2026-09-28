import { LitElement, css, html } from 'lit';

// Public Tongo overlay. One composition themed only by semantic tokens; the board stays in the DOM
// underneath and reappears unchanged when `active` clears.
class BingoTongo extends LitElement {
  static properties = { active: { type: Boolean, reflect: true } };
  static styles = css`
    :host { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; }
    .scrim {
      position: absolute; inset: 0; background: var(--bingo-color-canvas); opacity: 0.6;
      animation: fade var(--bingo-motion-normal) ease-out both;
    }
    .card {
      position: relative; display: grid; justify-items: center; gap: var(--bingo-space-section);
      padding: var(--bingo-space-list-indent);
      border: 4px solid var(--bingo-color-accent);
      border-radius: var(--bingo-radius-surface);
      box-shadow: var(--bingo-space-small) var(--bingo-space-small) 0 var(--bingo-color-border);
      background: var(--bingo-color-surface); color: var(--bingo-color-text);
      animation: pop var(--bingo-motion-normal) ease-out both;
    }
    .word {
      margin: 0; color: var(--bingo-color-danger);
      font: var(--bingo-font-emphasis) calc(2 * var(--bingo-font-display))/var(--bingo-font-tight) var(--bingo-font-body);
      letter-spacing: 0.06em; text-transform: uppercase;
      animation: shake var(--bingo-motion-normal) ease-in-out 1s infinite alternate;
    }
    .note { margin: 0; font-weight: var(--bingo-font-emphasis); }
    .announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @keyframes fade { from { opacity: 0; } }
    @keyframes pop { from { transform: scale(0.4) rotate(-6deg); opacity: 0; } }
    @keyframes shake { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
    @media (prefers-reduced-motion: reduce) { .scrim, .card, .word { animation: none; } }
  `;
  constructor() { super(); this.active = false; }
  render() {
    // The live region always exists, so the celebration is announced once when it appears.
    const announcement = html`<span class="announcement" role="status" aria-live="polite" aria-atomic="true">${
      this.active ? '¡Tongo! Reclamación no válida. El juego continúa.' : ''}</span>`;
    if (!this.active) return announcement;
    return html`<div class="scrim"></div>
      <div class="card" aria-hidden="true"><p class="word">¡Tongo!</p>
        <p class="note">Reclamación no válida · el juego continúa</p></div>${announcement}`;
  }
}

customElements.define('bingo-tongo', BingoTongo);
