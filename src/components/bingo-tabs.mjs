import { LitElement, css, html } from 'lit';

// WAI-ARIA tabs with automatic activation and a roving tabindex. The host is the tablist; its light-DOM
// children with role="tab" name their panel through aria-controls (usually a <bingo-tab-panel>).
// canLeave(current, next) may veto or defer a switch (e.g. unsaved edits): it returns true to switch
// now, or a promise of a boolean. While a decision is open the current tab stays selected, and a veto
// returns focus to it.
export class BingoTabs extends LitElement {
  static properties = { label: { type: String } };
  static styles = css`
    :host { display: flex; align-items: stretch; min-width: 0; }
  `;
  constructor() {
    super();
    this.label = '';
    this.canLeave = null;
    this.deciding = false;
    this.addEventListener('click', (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (this.tabs.includes(tab)) this.request(tab);
    });
    this.addEventListener('keydown', (event) => this.onKeydown(event));
  }
  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'tablist');
    this.sync();
  }
  updated(changed) {
    if (changed.has('label')) {
      if (this.label) this.setAttribute('aria-label', this.label);
      else this.removeAttribute('aria-label');
    }
  }
  get tabs() { return [...this.querySelectorAll(':scope > [role="tab"]')]; }
  get selected() { return this.tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? null; }
  panelOf(tab) { return this.getRootNode().getElementById?.(tab.getAttribute('aria-controls')) ?? null; }

  // Re-applies the current selection (or the first tab) to every tab and panel.
  sync() {
    const tabs = this.tabs;
    if (tabs.length > 0) this.apply(this.selected ?? tabs[0]);
  }
  apply(next, focus = false) {
    for (const tab of this.tabs) {
      const isSelected = tab === next;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      const panel = this.panelOf(tab);
      if (panel) panel.hidden = !isSelected;
    }
    if (focus) next.focus();
  }
  select(next, focus = false) {
    const changed = next !== this.selected;
    this.apply(next, focus);
    if (changed) this.dispatchEvent(new CustomEvent('tab-change', { detail: { id: next.id }, bubbles: true, composed: true }));
  }
  // Requests a switch to a tab (element or id) through canLeave.
  request(target, focus = false) {
    const next = typeof target === 'string' ? this.tabs.find((tab) => tab.id === target) : target;
    const current = this.selected;
    if (!next || this.deciding || next === current) return;
    const allowed = this.canLeave && current ? this.canLeave(current, next) : true;
    if (allowed === true) {
      this.select(next, focus);
      return;
    }
    this.deciding = true;
    Promise.resolve(allowed).catch(() => false).then((ok) => {
      this.deciding = false;
      if (ok === true) this.select(next, focus);
      else current.focus();
    });
  }
  onKeydown(event) {
    const tabs = this.tabs;
    const index = tabs.indexOf(event.target);
    if (index === -1) return;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    this.request(tabs[(target + tabs.length) % tabs.length], true);
  }
  render() { return html`<slot @slotchange=${() => this.sync()}></slot>`; }
}

// A tab's panel: focusable as a whole, hidden while its tab is not selected. It fills its grid cell and
// clips; the layout inside decides which region may scroll.
export class BingoTabPanel extends LitElement {
  static styles = css`
    :host { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
    :host([hidden]) { display: none; }
    :host(:focus-visible) { outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: -2px; }
  `;
  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'tabpanel');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }
  render() { return html`<slot></slot>`; }
}

customElements.define('bingo-tabs', BingoTabs);
customElements.define('bingo-tab-panel', BingoTabPanel);
