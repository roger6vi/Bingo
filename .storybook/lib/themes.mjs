import { html } from 'lit';
import { DEFAULT_THEME, THEME_LABELS } from '../../src/theme-controller.mjs';

/* global __BINGO_THEMES__ */
// Injected by main.mjs from the token pipeline (scripts/token-contract.mjs sourcePaths.themes).
export const THEMES = __BINGO_THEMES__;
export const SIDE_BY_SIDE = 'side-by-side';

export const themeLabel = (id) => THEME_LABELS[id]
  ?? id.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');

export const themeToolbarItems = [
  ...THEMES.map((id) => ({ value: id, title: themeLabel(id), right: id === DEFAULT_THEME ? 'default' : undefined })),
  { value: SIDE_BY_SIDE, title: 'All themes, side by side' },
];

// Mirrors the app: the committed theme id lands on <html data-theme>. "Side by side" repeats the story
// once per theme; generated theme rules are attribute selectors, so each column resolves its own tokens.
export function withTheme(story, context) {
  const selected = context.globals.theme;
  const sideBySide = selected === SIDE_BY_SIDE && context.parameters.sideBySide !== false;
  document.documentElement.dataset.theme = THEMES.includes(selected) ? selected : DEFAULT_THEME;
  // Docs blocks paint their own white canvas; give inline stories the themed one instead.
  if (!sideBySide) return context.viewMode === 'docs' ? html`<div class="sb-docs-canvas">${story()}</div>` : story();
  return html`<div class="sb-themes" style=${`--sb-theme-count: ${THEMES.length}`}>
    ${THEMES.map((id) => html`<div class="sb-themes__cell" data-theme=${id}>
      <p class="sb-caption">${themeLabel(id)}</p>${story()}
    </div>`)}
  </div>`;
}
