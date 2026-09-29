import { css, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { BingoField, busyIndicator, fieldStyles } from './bingo-field.mjs';

// Single-choice select. Options are declared as light-DOM <option> children (kept in the page
// markup) and mirrored into the shadow <select>; the host value follows the native select.
const chevron = html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M3 5h2v2h2v2h2V7h2V5h2v2h-1v2h-1v2H9v1H7v-1H6V9H5V7H3z"/></svg>`;

export class BingoSelectField extends BingoField {
  static styles = [fieldStyles, css`
    .control { appearance: none; cursor: pointer; }
    .control:disabled { cursor: not-allowed; }
    option { color: var(--bingo-color-text); background: var(--bingo-color-surface); border-radius: var(--bingo-radius-control); }
  `];

  constructor() {
    super();
    this.observer = new MutationObserver(() => this.requestUpdate());
  }

  connectedCallback() {
    super.connectedCallback();
    this.observer.observe(this, {
      childList: true, subtree: true, characterData: true, attributeFilter: ['value', 'label', 'disabled', 'selected'],
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.observer.disconnect();
  }

  get options() {
    return [...this.querySelectorAll('option')].map((option) => ({
      value: option.value, label: option.textContent.trim(), disabled: option.disabled, selected: option.selected,
    }));
  }

  // Like a native select, an unset or unknown value falls back to the selected (or first) option.
  willUpdate() {
    const options = this.options;
    if (options.length > 0 && !options.some((option) => option.value === this.value)) {
      this.value = (options.find((option) => option.selected) ?? options[0]).value;
    }
  }

  renderAdornment() { return this.pending ? busyIndicator : chevron; }

  renderControl() {
    return html`<select id="control" class="control" .value=${live(this.value)}
      name=${this.name || nothing} ?required=${this.required} ?disabled=${this.disabled}
      aria-invalid=${this.error ? 'true' : 'false'} aria-busy=${this.pending ? 'true' : nothing}
      aria-describedby=${this.describedBy()}
      @input=${this.onInput} @change=${this.onChange}>
      ${this.options.map((option) => html`<option value=${option.value} ?disabled=${option.disabled}
        .selected=${option.value === this.value}>${option.label}</option>`)}
    </select>`;
  }
}

customElements.define('bingo-select-field', BingoSelectField);
