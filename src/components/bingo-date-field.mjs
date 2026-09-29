import { css, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { BingoField, busyIndicator, fieldStyles } from './bingo-field.mjs';

// Calendar date field (YYYY-MM-DD value). The native picker button stays clickable but invisible,
// under a token-colored calendar icon, so it reads correctly in every theme.
const calendarIcon = html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path fill-rule="evenodd" d="M4 1h2v2h4V1h2v2h3v12H1V3h3zM3 7v6h10V7zm1 1h2v2H4zm3 0h2v2H7zm3 0h2v2h-2z"/></svg>`;

export class BingoDateField extends BingoField {
  static properties = { ...BingoField.properties, min: { type: String }, max: { type: String } };
  static styles = [fieldStyles, css`
    .control::-webkit-datetime-edit { padding: 0; }
    .control::-webkit-calendar-picker-indicator {
      position: absolute; inset-block: 0; inset-inline-end: 0; width: calc(var(--bingo-space-inset-inline) * 2 + 1rem);
      height: auto; margin: 0; padding: 0; opacity: 0; cursor: pointer;
    }
    .control:disabled::-webkit-calendar-picker-indicator { cursor: not-allowed; }
  `];

  constructor() { super(); this.min = null; this.max = null; }

  renderAdornment() {
    return html`${this.pending ? busyIndicator : nothing}${calendarIcon}`;
  }

  renderControl() {
    return html`<input id="control" class="control" type="date"
      .value=${live(this.value)}
      name=${this.name || nothing} min=${this.min ?? nothing} max=${this.max ?? nothing}
      ?required=${this.required} ?disabled=${this.disabled}
      aria-invalid=${this.error ? 'true' : 'false'} aria-busy=${this.pending ? 'true' : nothing}
      aria-describedby=${this.describedBy()}
      @input=${this.onInput} @change=${this.onChange} @keydown=${this.onKeydown}>`;
  }
}

customElements.define('bingo-date-field', BingoDateField);
