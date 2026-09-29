import { LitElement, css, html } from 'lit';
import './bingo-button.mjs';

// Presentation only: the active marker reflects committed state; selecting dispatches an intent.
export class BingoEventList extends LitElement {
  static properties = { events: { attribute: false }, disabled: { type: Boolean }, loaded: { type: Boolean } };
  static styles = css`
    :host { display: block; }
    ul { margin: 0; padding: 0; list-style: none; border: var(--bingo-border-width-default) solid var(--bingo-color-border); border-radius: var(--bingo-radius-control); }
    li {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 0.5rem 1rem; min-height: 2.75rem; padding: 0.375rem 0.75rem;
      border-top: var(--bingo-border-width-default) solid var(--bingo-color-border);
    }
    li:first-child { border-top-style: none; }
    li[aria-current="true"] { box-shadow: inset 3px 0 0 var(--bingo-color-accent); }
    .details { display: grid; min-width: 0; }
    .name { font-weight: var(--bingo-font-emphasis); overflow-wrap: anywhere; }
    .meta { color: var(--bingo-color-muted); font-size: 0.8125rem; }
    .marker {
      padding: 0.125rem 0.5rem; border-radius: var(--bingo-radius-control);
      color: var(--bingo-color-on-accent); background: var(--bingo-color-accent);
      font-size: 0.6875rem; font-weight: var(--bingo-font-emphasis); text-transform: uppercase; letter-spacing: var(--bingo-font-tracking);
    }
    bingo-button::part(button) { min-height: 2rem; border-radius: var(--bingo-radius-control); }
    p { margin: 0; color: var(--bingo-color-muted); }
  `;
  constructor() { super(); this.events = []; this.disabled = false; this.loaded = false; }
  choose(id) {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent('event-select', { detail: { id }, bubbles: true, composed: true }));
  }
  render() {
    // The empty state is only claimed after a committed list has been read.
    if (!this.loaded) return html`<p>Lista de eventos no disponible todavía.</p>`;
    if (this.events.length === 0) return html`<p>Todavía no hay eventos. Crea uno para empezar.</p>`;
    return html`<ul aria-label="Eventos">${this.events.map((event) => html`
      <li aria-current=${event.active ? 'true' : 'false'}>
        <span class="details"><span class="name">${event.name}</span>
          <span class="meta">${event.date} · ${event.place}</span></span>
        ${event.active ? html`<span class="marker">Evento activo</span>`
          : html`<bingo-button ?disabled=${this.disabled}
              @click=${() => this.choose(event.id)}>Activar «${event.name}»</bingo-button>`}
      </li>`)}</ul>`;
  }
}

customElements.define('bingo-event-list', BingoEventList);
