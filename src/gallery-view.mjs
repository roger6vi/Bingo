import { html, render } from 'lit';
import './components/bingo-panel.mjs';
import './components/bingo-button.mjs';
import './components/bingo-status.mjs';
import './components/bingo-number.mjs';
import './components/bingo-number-board.mjs';
import './components/bingo-operator-summary.mjs';
import './components/bingo-draw-controls.mjs';
import './components/bingo-event-list.mjs';
import { THEME_LABELS } from './theme-controller.mjs';

// Development-only inspection page: static fixtures, no preload bridge or IPC, never packaged. It shows the
// real components under each registered theme; production screens keep their own tests.
export const GALLERY_STATES = ['normal', 'disabled', 'pending', 'error', 'stale', 'focus', 'checking', 'celebration'];

// Semantic tokens only; a constructable sheet is allowed by the pages' style-src 'self' CSP.
const styles = new CSSStyleSheet();
styles.replaceSync(`
  .gallery-theme {
    color: var(--bingo-color-text); background: var(--bingo-color-canvas); font-family: var(--bingo-font-body);
    border: var(--bingo-border-width-strong) solid var(--bingo-color-border);
  }
  .gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: var(--bingo-space-section); }
  .gallery-specimen { margin: 0 0 var(--bingo-space-section); }
  .gallery-specimen figcaption { color: var(--bingo-color-muted); font-size: var(--bingo-font-size-small); }
  .gallery-focus {
    display: inline-block; padding: var(--bingo-space-inset-compact) var(--bingo-space-inset-inline);
    outline: var(--bingo-border-width-focus) solid var(--bingo-color-focus); outline-offset: var(--bingo-space-small);
  }
  .gallery-celebration {
    margin: 0; padding: var(--bingo-space-layout); text-align: center;
    color: var(--bingo-color-on-celebration); background: var(--bingo-color-celebration);
    font: var(--bingo-font-emphasis) var(--bingo-font-size-large)/var(--bingo-font-tight) var(--bingo-font-body);
  }
`);

const events = [
  { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', active: true },
  { id: 'b', name: 'Fiesta', date: '2026-10-01', place: 'Sala', active: false },
];
const specimen = (state, label, content) =>
  html`<figure class="gallery-specimen" data-state=${state}>${content}<figcaption>${label}</figcaption></figure>`;

const themeSection = (theme, reduced) => html`
  <section class="gallery-theme" data-theme=${theme} aria-labelledby=${`gallery-${theme}`}>
    <h2 id=${`gallery-${theme}`}>Theme: ${THEME_LABELS[theme]}</h2>
    <p data-motion>${reduced ? 'Reduced motion: transitions are disabled.' : 'Motion enabled: transitions use motion tokens.'}</p>
    <div class="gallery-grid">
      <bingo-panel heading=${`Actions (${theme})`}>
        ${specimen('normal', 'Normal', html`<bingo-button>Draw digital number</bingo-button>`)}
        ${specimen('disabled', 'Disabled', html`<bingo-button disabled>Draw digital number</bingo-button>`)}
        ${specimen('pending', 'Pending: disabled until the save commits', html`<bingo-button disabled>Guardando…</bingo-button>`)}
        ${specimen('focus', 'Focus ring', html`<span class="gallery-focus">Focused control</span>`)}
      </bingo-panel>
      <bingo-panel heading=${`Status (${theme})`}>
        ${specimen('normal', 'Info', html`<bingo-status message="Event ready"></bingo-status>`)}
        ${specimen('checking', 'Checking', html`<bingo-status message="Current phase: Checking line"></bingo-status>`)}
        ${specimen('stale', 'Stale', html`<bingo-status tone="warning" message="Last confirmed history may be stale."></bingo-status>`)}
        ${specimen('error', 'Error', html`<bingo-status tone="error" message="Could not save the theme. Try again."></bingo-status>`)}
      </bingo-panel>
      <bingo-panel heading=${`Numbers (${theme})`}>
        ${specimen('normal', 'Empty', html`<bingo-number></bingo-number>`)}
        ${specimen('normal', 'Called, compact', html`<bingo-number .value=${42} compact></bingo-number>`)}
        ${specimen('normal', 'Latest, display size', html`<bingo-number .value=${13} latest></bingo-number>`)}
        ${specimen('normal', 'Board in draw order', html`<bingo-number-board loaded .calledNumbers=${[7, 42, 90, 13]}></bingo-number-board>`)}
        ${specimen('pending', 'Board waiting for state', html`<bingo-number-board></bingo-number-board>`)}
      </bingo-panel>
      <bingo-panel heading=${`Operator (${theme})`}>
        ${specimen('normal', 'Summary', html`<bingo-operator-summary .latest=${13} .count=${4} .remaining=${86}></bingo-operator-summary>`)}
        ${specimen('pending', 'Draw controls while a request is pending', html`<bingo-draw-controls reloadDisabled></bingo-draw-controls>`)}
        ${specimen('normal', 'Events', html`<bingo-event-list loaded .events=${events}></bingo-event-list>`)}
      </bingo-panel>
      <bingo-panel heading=${`Celebration (${theme})`}>
        ${specimen('celebration', 'Celebration tokens; the overlay is specified, not implemented',
          html`<p class="gallery-celebration">¡Bingo!</p>`)}
      </bingo-panel>
    </div>
  </section>`;

export async function renderGallery(root, themes = Object.keys(THEME_LABELS)) {
  if (!document.adoptedStyleSheets.includes(styles)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  render(html`<h1>Component and theme gallery</h1>
    <p>Development only. Static fixtures; not part of the packaged operator or public windows.</p>
    ${themes.map((theme) => themeSection(theme, reduced))}`, root);
  await Promise.all([...root.querySelectorAll('*')].map((element) => element.updateComplete).filter(Boolean));
}
