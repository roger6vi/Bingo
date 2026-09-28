import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

// Presentation only: the active marker reflects committed state; selecting dispatches an intent.
export class BingoEventList extends LitElement {
  static properties = { events: { attribute: false }, disabled: { type: Boolean } };
  static styles = css`
    :host { display: block; }
    ul { margin: 0; padding: 0; list-style: none; }
    li {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: var(--bingo-space-small); padding: var(--bingo-space-inset-compact) 0;
      border-bottom: 1px solid var(--bingo-color-border);
    }
    li[aria-current="true"] { font-weight: var(--bingo-font-emphasis); }
    .marker { text-transform: uppercase; letter-spacing: 0.06em; }
    p { margin: 0; }
  `;
  constructor() { super(); this.events = []; this.disabled = false; }
  choose(id) {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent('event-select', { detail: { id }, bubbles: true, composed: true }));
  }
  render() {
    if (this.events.length === 0) return html`<p>Todavía no hay eventos. Crea uno para empezar.</p>`;
    return html`<ul aria-label="Eventos">${this.events.map((event) => html`
      <li aria-current=${event.active ? 'true' : 'false'}>
        <span>${event.name} — ${event.date}, ${event.place}</span>
        ${event.active ? html`<span class="marker">Evento activo</span>`
          : html`<bingo-button ?disabled=${this.disabled}
              @click=${() => this.choose(event.id)}>Activar «${event.name}»</bingo-button>`}
      </li>`)}</ul>`;
  }
}

customElements.define('bingo-event-list', BingoEventList);
