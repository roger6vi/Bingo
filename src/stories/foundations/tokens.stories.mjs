import { html, render } from 'lit';
// Every theme has the same semantic keys (scripts/token-contract.mjs enforces it), so the default one names them.
import semantic from '../../../tokens/semantic/jules.json';
import { THEMES, themeLabel } from '../../../.storybook/lib/themes.mjs';

// Semantic tokens as every theme resolves them. Names come from the token source, so new tokens and
// new themes show up here without edits; values are read back from the generated CSS at runtime.
const variable = (path) => `--bingo-${path.join('-')}`;
const group = (name) => Object.keys(semantic[name]).map((key) => ({ key, name: variable([name, key]) }));

// Fill each value cell with the value the browser resolved for its theme column.
function resolveValues(root) {
  requestAnimationFrame(() => {
    for (const cell of root.querySelectorAll('[data-token]')) {
      cell.textContent = getComputedStyle(cell).getPropertyValue(cell.dataset.token).trim() || '—';
    }
  });
}

const themeColumns = (content) => {
  const root = document.createElement('div');
  root.className = 'sb-themes';
  root.style.setProperty('--sb-theme-count', THEMES.length);
  for (const theme of THEMES) {
    const cell = document.createElement('div');
    cell.className = 'sb-themes__cell';
    cell.dataset.theme = theme;
    root.append(cell);
    // Each column is its own render target so its data-theme scopes the tokens inside it.
    render(html`<p class="sb-caption">${themeLabel(theme)}</p>${content(theme)}`, cell);
  }
  resolveValues(root);
  return root;
};

export default {
  title: 'Foundations/Tokens',
  tags: ['!autodocs'],
  parameters: { layout: 'fullscreen', sideBySide: false, controls: { disable: true } },
};

export const Colors = {
  render: () => themeColumns(() => html`<div class="sb-swatches">${group('color').map(({ key, name }) => html`
    <div class="sb-swatch">
      <div class="sb-swatch__chip" style=${`background: var(${name})`}></div>
      <div class="sb-swatch__meta"><strong>${key}</strong><code>${name}</code><code data-token=${name}></code></div>
    </div>`)}</div>`),
};

export const SpacingAndShape = {
  name: 'Spacing, shape & motion',
  render: () => themeColumns(() => html`<table class="sb-token-table">
    <thead><tr><th scope="col">Token</th><th scope="col">Value</th><th scope="col">Sample</th></tr></thead>
    <tbody>
      ${group('space').map(({ name }) => html`<tr><td><code>${name}</code></td><td><code data-token=${name}></code></td>
        <td><div style=${`width: min(var(${name}), 12rem); height: 0.75rem; background: var(--bingo-color-accent)`}></div></td></tr>`)}
      ${group('radius').map(({ name }) => html`<tr><td><code>${name}</code></td><td><code data-token=${name}></code></td>
        <td><div style=${`width: 3rem; height: 2rem; border: 2px solid var(--bingo-color-border); border-radius: var(${name})`}></div></td></tr>`)}
      ${group('border-width').map(({ name }) => html`<tr><td><code>${name}</code></td><td><code data-token=${name}></code></td>
        <td><div style=${`width: 3rem; height: 0; border-top: var(${name}) solid var(--bingo-color-border-strong)`}></div></td></tr>`)}
      ${group('elevation').map(({ name }) => html`<tr><td><code>${name}</code></td><td><code data-token=${name}></code></td>
        <td><div style=${`width: 3rem; height: 2rem; background: var(--bingo-color-surface); border: 1px solid var(--bingo-color-border);
          box-shadow: var(${name}) var(${name}) 0 var(--bingo-color-shadow)`}></div></td></tr>`)}
      ${['motion', 'opacity', 'layer'].flatMap(group).map(({ name }) => html`<tr><td><code>${name}</code></td>
        <td><code data-token=${name}></code></td><td></td></tr>`)}
    </tbody>
  </table>`),
};

export const Typography = {
  render: () => themeColumns(() => html`<table class="sb-token-table">
    <thead><tr><th scope="col">Token</th><th scope="col">Value</th></tr></thead>
    <tbody>${group('font').map(({ name }) => html`<tr><td><code>${name}</code></td><td><code data-token=${name}></code></td></tr>`)}</tbody>
  </table>
  <div class="sb-section" style="margin-top: 1.5rem">
    <p class="sb-caption">Body · --bingo-font-size / --bingo-font-line</p>
    <p style="margin: 0">Evento activo: Bingo solidario de primavera — 2026-10-03, Casal del barrio</p>
  </div>
  <div class="sb-section">
    <p class="sb-caption">Emphasis · --bingo-font-emphasis</p>
    <p style="margin: 0; font-weight: var(--bingo-font-emphasis)">Current phase: Drawing</p>
  </div>
  <div class="sb-section">
    <p class="sb-caption">Display · --bingo-font-display (viewport-relative)</p>
    <p style="margin: 0; font: var(--bingo-font-emphasis) var(--bingo-font-display)/var(--bingo-font-tight) var(--bingo-font-body)">42</p>
  </div>`),
};
