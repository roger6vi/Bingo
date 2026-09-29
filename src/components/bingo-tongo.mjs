import { LitElement, css, html } from 'lit';

// Public Tongo overlay. One composition themed only by semantic tokens; the board stays in the DOM
// underneath and reappears unchanged when `active` clears.
class BingoTongo extends LitElement {
  static properties = { active: { type: Boolean, reflect: true } };
  static styles = css`
    :host {
      position: fixed; inset: 0; z-index: var(--bingo-layer-overlay);
      display: grid; place-items: center; pointer-events: none;
    }
    .scrim {
      position: absolute; inset: 0; background: var(--bingo-color-overlay); opacity: var(--bingo-opacity-scrim);
      animation: fade var(--bingo-motion-normal) var(--bingo-motion-easing) both;
    }
    .card {
      position: relative; display: grid; justify-items: center; gap: var(--bingo-space-section);
      max-width: min(90vw, var(--bingo-space-wide)); padding: var(--bingo-space-layout);
      border: var(--bingo-border-width-strong) solid var(--bingo-color-error);
      border-radius: var(--bingo-radius-surface);
      box-shadow: var(--bingo-elevation-raised) var(--bingo-elevation-raised) 0 var(--bingo-color-shadow);
      background: var(--bingo-color-surface); color: var(--bingo-color-text);
      text-align: center;
      animation: pop var(--bingo-motion-slow) var(--bingo-motion-easing) both;
    }
    .word {
      margin: 0; color: var(--bingo-color-error);
      font: var(--bingo-font-emphasis) var(--bingo-font-display)/var(--bingo-font-tight) var(--bingo-font-body);
      letter-spacing: var(--bingo-font-tracking); text-transform: uppercase;
      animation: shake var(--bingo-motion-slow) var(--bingo-motion-easing) infinite alternate;
    }
    .note {
      margin: 0;
      font: var(--bingo-font-emphasis) var(--bingo-font-size-large)/var(--bingo-font-line) var(--bingo-font-body);
    }
    .announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @keyframes fade { from { opacity: 0; } }
    @keyframes pop { from { transform: scale(0.4) rotate(-6deg); opacity: 0; } }
    @keyframes shake { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
    @media (prefers-reduced-motion: reduce) { .scrim, .card, .word { animation: none; } }
  `;
  constructor() { super(); this.active = false; }
  render() {
    // The live region always exists, so the overlay is announced once when it appears.
    const announcement = html`<span class="announcement" role="status" aria-live="polite" aria-atomic="true">${
      this.active ? '¡Tongo! Reclamación no válida. El juego continúa.' : ''}</span>`;
    if (!this.active) return announcement;
    return html`<div class="scrim"></div>
      <div class="card" aria-hidden="true"><p class="word">¡Tongo!</p>
        <p class="note">Reclamación no válida · el juego continúa</p></div>${announcement}`;
  }
}

customElements.define('bingo-tongo', BingoTongo);
