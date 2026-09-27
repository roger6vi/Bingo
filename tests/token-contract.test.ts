import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { semanticVariable, validateTokenContracts } from '../scripts/token-contract.mjs';
type Token = { $type: string; $value: string };
type Theme = Record<string, Record<string, Token>>;
const themeNames = ['pixel-classic', 'high-contrast'] as const;
const token = ($type = 'color', $value = '{color.ink}'): Token => ({ $type, $value });
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const sources = () => ({
  reference: load<Theme>('tokens/reference.json'),
  themes: {
    'pixel-classic': load<Theme>('tokens/semantic/pixel-classic.json'),
    'high-contrast': load<Theme>('tokens/semantic/high-contrast.json'),
  },
  css: readFileSync(new URL('../src/screen.css', import.meta.url), 'utf8'),
});
const reject = (change: (fixture: ReturnType<typeof sources>) => void, pattern: RegExp) => {
  const fixture = structuredClone(sources());
  change(fixture);
  assert.throws(() => validateTokenContracts(fixture), pattern);
};
const rejectCss = (declaration: string, pattern: RegExp) =>
  reject((f) => { f.css += `\nbody { ${declaration} }`; }, pattern);
test('repository contracts expose stable semantic keys and generated variable names', () => {
  const { keys } = validateTokenContracts(sources());
  for (const key of ['color.canvas', 'color.surface', 'color.text', 'color.muted', 'color.accent',
    'color.danger', 'color.focus', 'color.border', 'space.layout', 'font.body', 'radius.surface', 'motion.normal']) {
    assert.ok(keys.includes(key), key);
    assert.equal(semanticVariable(key), `--bingo-${key.replaceAll('.', '-')}`);
  }
});
test('missing and extra keys in either theme are rejected', () => {
  for (const theme of themeNames) {
    reject((f) => { delete f.themes[theme].color.canvas; }, /semantic keys/i);
    reject((f) => { f.themes[theme].color.unexpected = token(); }, /semantic keys/i);
  }
});
test('semantic type mismatch is rejected', () =>
  reject((f) => { f.themes['high-contrast'].color.canvas.$type = 'dimension'; }, /type/i));
test('missing, invalid and raw reference values are rejected', () => {
  reject((f) => { f.themes['pixel-classic'].color.canvas.$value = '{color.missing}'; }, /reference/i);
  reject((f) => { f.themes['pixel-classic'].color.canvas.$value = '{color.ink}'; delete f.reference.color.ink; }, /reference/i);
  reject((f) => { f.themes['pixel-classic'].color.canvas.$value = '#fff'; }, /alias/i);
});
test('component layers, semantic paths and CSS aliases are rejected', () => {
  reject((f) => { Object.assign(f, { component: {} }); }, /component/i);
  reject((f) => { f.themes['pixel-classic'].component = {}; }, /component/i);
  reject((f) => { f.themes['pixel-classic'].color['button-component'] = token(); }, /component/i);
  for (const name of ['button', 'panel', 'dialog', 'status', 'number', 'icon', 'shell',
    'board', 'controls', 'checking-state', 'prize-banner', 'event-summary', 'component']) {
    reject((f) => {
      for (const theme of themeNames) f.themes[theme][name] = { background: token() };
    }, /component/i);
    reject((f) => {
      for (const theme of themeNames) f.themes[theme].color[name] = token();
    }, /component/i);
  }
  for (const name of ['button', 'button-inline', 'button-bg']) {
    reject((f) => {
      for (const theme of themeNames) {
        const space = f.themes[theme].space;
        delete space.button;
        delete space['button-inline'];
        space[name] = token('dimension', '{space.sm}');
      }
    }, /Component token forbidden: space\./);
    rejectCss(`padding: var(--bingo-space-${name});`, /Component alias forbidden: --bingo-space-/);
  }
  for (const theme of themeNames) {
    for (const name of ['button', 'button-inline']) {
      reject((f) => { f.themes[theme].space[name] = token('dimension', '{space.sm}'); }, /Component token forbidden: space\./);
    }
  }
  for (const name of ['button-bg', 'prize-banner-accent', 'color-dialog-surface',
    'event-summary-text', 'shell-border', 'checking-state-indicator']) {
    rejectCss(`color: var(--bingo-${name});`, /component/i);
  }
  rejectCss('color: var(--bingo-component-button);', /component/i);
});
test('identical themes cannot masquerade as two visual shells', () =>
  reject((f) => { f.themes['high-contrast'] = structuredClone(f.themes['pixel-classic']); }, /differ/i));
test('screen cannot consume reference variables or literal color values', () => {
  rejectCss('color: var(--bingo-reference-ink);', /reference/i);
  const literals = ['gray', 'red', 'transparent', 'currentColor', 'CanvasText', '#abc',
    'rgb(1, 2, 3)', 'hsl(0 100% 50%)', 'hwb(0 0% 0%)', 'lab(50% 10 20)',
    'lch(50% 20 30)', 'oklab(50% 0 0)', 'oklch(50% 0.2 30)',
    'color(display-p3 1 0 0)', 'color-mix(in srgb, red, blue)'];
  for (const literal of literals) {
    for (const property of ['color', 'background', 'background-color', 'border-color', 'outline-color']) {
      rejectCss(`${property}: ${literal};`, /raw color/i);
    }
  }
  for (const declaration of [
    'border: 1px solid red;',
    'border-left: 2px dashed CanvasText;',
    'outline: 2px solid currentColor;',
    'background: linear-gradient(red, blue);',
    'background: var(--bingo-color-canvas) linear-gradient(red, blue);',
    'box-shadow: 0 1px red;',
    'text-shadow: 0 1px hwb(0 0% 0%);',
    'border: 1px solid var(--bingo-color-border) red;',
    'color: var(--bingo-color-text, red);',
    'background: var(--bingo-space-layout);',
    'border-image-source: linear-gradient(red, blue);',
    'box-shadow: 0 1px 2px;',
    'text-shadow: 1px 2px;',
  ]) rejectCss(declaration, /raw color/i);
  for (const declaration of [
    'border-radius: var(--bingo-radius-surface);',
    'transition: background-color var(--bingo-motion-normal);',
    'border: 1px solid var(--bingo-color-border);',
    'box-shadow: 0 1px var(--bingo-color-border);',
  ]) {
    const fixture = sources();
    fixture.css += `\nbody { ${declaration} }`;
    assert.doesNotThrow(() => validateTokenContracts(fixture), declaration);
  }
});

test('each shadow layer requires exactly one semantic color', () => {
  for (const property of ['box-shadow', 'text-shadow']) {
    for (const value of [
      '0 1px var(--bingo-color-border), 0 1px',
      '0 1px, 0 1px var(--bingo-color-border)',
      '0 1px var(--bingo-color-border) var(--bingo-color-text)',
      '0 1px var(--bingo-color-border), 0 1px red',
    ]) rejectCss(`${property}: ${value};`, /raw color|unsupported color syntax/i);
    const fixture = sources();
    fixture.css += `\nbody { ${property}: 0 1px var(--bingo-color-border), 0 2px var(--bingo-color-text); }`;
    assert.doesNotThrow(() => validateTokenContracts(fixture), property);
  }
});

test('filter and backdrop-filter accept only none, never color-bearing functions', () => {
  for (const property of ['filter', '-webkit-filter', 'backdrop-filter', '-webkit-backdrop-filter']) {
    for (const value of [
      'drop-shadow(0 0 1px red)',
      'drop-shadow(0 0 1px var(--bingo-color-border)) drop-shadow(0 0 1px red)',
      'blur(2px)',
      'var(--bingo-color-border)',
    ]) rejectCss(`${property}: ${value};`, /raw color|unsupported color syntax/i);
    const fixture = sources();
    fixture.css += `\nbody { ${property}: none; }`;
    assert.doesNotThrow(() => validateTokenContracts(fixture), property);
  }
});

test('screen cannot redefine generated semantic colors', () => {
  for (const value of ['red', '#fff', 'var(--other)', 'var(--bingo-color-text)']) {
    rejectCss(`--bingo-color-canvas: ${value};`, /semantic color variable|override/i);
  }
});

test('screen rejects unsupported CSS escapes', () => {
  for (const escaped of ['c\\6Flor: red;', '--bingo-c\\6Flor-canvas: red;',
    'color: var(--bingo-c\\6Flor-text);', 'color: r\\65d;']) {
    rejectCss(escaped, /unsupported css escape/i);
  }
});

test('reduced motion overrides the enabled-button transition at equal specificity', () => {
  const css = sources().css;
  const enabled = /button:not\(:disabled\)\s*\{[^}]*transition:\s*background-color\b[^}]*\}/.exec(css);
  assert.ok(enabled, 'enabled buttons have the interactive transition');
  const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(media, 'reduced-motion media block');
  assert.ok(media.index > enabled.index, 'reduced-motion override follows interactive rule');
  assert.match(media[1], /button:not\(:disabled\)\s*\{\s*transition:\s*none\s*;/,
    'equal-specificity enabled selector must disable its transition');
});

test('screen keeps enabled-only pointer, hover and transition with semantic disabled treatment', () => {
  const css = sources().css;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  for (const { selector, body } of rules) {
    const transition = /transition:\s*([^;]+)/.exec(body)?.[1].trim();
    if ((/cursor:\s*pointer/.test(body) || (transition && transition !== 'none') || /:hover/.test(selector)) &&
        /button/.test(selector)) {
      assert.match(selector, /button:not\(:disabled\)/, `interactive rule must target enabled buttons: ${selector}`);
    }
  }
  const enabled = rules.find(({ selector, body }) => selector === 'button:not(:disabled)' && /cursor:\s*pointer/.test(body));
  assert.ok(enabled, 'enabled-only pointer rule');
  assert.ok(rules.some(({ selector }) => selector === 'button:not(:disabled):hover'), 'enabled-only hover rule');
  const disabled = rules.find(({ selector }) => selector === 'button:disabled');
  assert.ok(disabled, 'explicit disabled rule');
  assert.match(disabled.body, /cursor:\s*(?:not-allowed|default)/);
  assert.match(disabled.body, /(?:color|background|border-color):\s*var\(--bingo-color-[\w-]+\)/);
  const opacity = /(?:^|;)\s*opacity:\s*(\d*\.?\d+)\s*(?:;|$)/.exec(disabled.body);
  assert.ok(opacity, 'disabled buttons need an explicit, theme-independent visual difference');
  assert.ok(Number(opacity[1]) > 0 && Number(opacity[1]) < 1, 'disabled opacity must be between 0 and 1');
});
