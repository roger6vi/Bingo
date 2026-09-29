import { html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { BingoField } from './bingo-field.mjs';

// Single-line text field: label, hint, announced error, required/disabled/pending, form-associated.
export class BingoTextField extends BingoField {
  static properties = {
    ...BingoField.properties,
    maxlength: { type: Number }, minlength: { type: Number },
    autocomplete: { type: String }, placeholder: { type: String },
  };

  constructor() {
    super();
    this.maxlength = null; this.minlength = null; this.autocomplete = null; this.placeholder = null;
  }

  renderControl() {
    return html`<input id="control" class="control" type="text"
      .value=${live(this.value)}
      name=${this.name || nothing}
      maxlength=${this.maxlength ?? nothing} minlength=${this.minlength ?? nothing}
      autocomplete=${this.autocomplete ?? nothing} placeholder=${this.placeholder ?? nothing}
      ?required=${this.required} ?disabled=${this.disabled}
      aria-invalid=${this.error ? 'true' : 'false'} aria-busy=${this.pending ? 'true' : nothing}
      aria-describedby=${this.describedBy()}
      @input=${this.onInput} @change=${this.onChange} @keydown=${this.onKeydown}>`;
  }
}

customElements.define('bingo-text-field', BingoTextField);
