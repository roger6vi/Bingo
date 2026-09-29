// Shared presentation helpers for stories. Styling lives in ../preview.css and only uses semantic tokens.
import { html } from 'lit';

/**
 * A dense, labelled state matrix: one row per state, the label in a narrow gutter.
 * @param {Array<[string, unknown] | [string, unknown, string]>} rows [label, content, note?]
 */
export const stateMatrix = (rows) => html`<div class="sb-matrix">
  ${rows.map(([label, content, note]) => html`
    <div class="sb-matrix__label"><span>${label}</span>${note ? html`<small>${note}</small>` : ''}</div>
    <div class="sb-matrix__cell">${content}</div>`)}
</div>`;

/** A constrained-width frame, for components that normally live inside a panel column. */
export const frame = (content, width = '32rem') => html`<div class="sb-frame" style=${`--sb-frame-width: ${width}`}>${content}</div>`;

/** Controls for Storybook's Controls panel, kept consistent between stories. */
export const numberList = { control: 'object', description: 'Called numbers in draw order (1–90).' };

/**
 * Forces a pseudo-class (hover, focus-visible, active…) on everything inside, including shadow DOM,
 * via storybook-addon-pseudo-states' rewritten `:host(.pseudo-<state>-all)` rules. Lets one story show
 * several interaction states at once; single-state stories use `parameters.pseudo` instead.
 */
export const forceState = (state, content) => html`<span class=${`pseudo-${state}-all`} style="display: contents">${content}</span>`;
