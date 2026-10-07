import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contrastPairs, semanticVariable, sourcePaths, validateTokenContracts } from '../scripts/token-contract.mjs';
type Token = { $type: string; $value: string };
type Theme = Record<string, Record<string, Token>>;
const defaultTheme = sourcePaths.defaultTheme;
const otherTheme = sourcePaths.themes.find((theme) => theme !== defaultTheme)!;
const themeNames = sourcePaths.themes;
const token = ($type = 'color', $value = '{color.neutral-900}'): Token => ({ $type, $value });
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const sources = () => ({
  reference: load<Theme>('tokens/reference.json'),
  themes: Object.fromEntries(themeNames.map((theme) => [theme, load<Theme>(`tokens/semantic/${theme}.json`)])),
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
  for (const key of ['color.canvas', 'color.surface', 'color.text', 'color.muted', 'color.accent', 'color.on-accent',
    'color.accent-hover', 'color.accent-active', 'color.disabled', 'color.focus', 'color.border', 'color.overlay',
    'color.info', 'color.success', 'color.warning', 'color.error', 'color.call-uncalled', 'color.call-called',
    'color.call-latest', 'color.celebration', 'color.prize', 'color.tie-1', 'color.tie-8', 'space.layout', 'font.body',
    'font.tracking', 'radius.surface', 'border-width.default', 'elevation.raised', 'motion.normal', 'motion.easing',
    'layer.modal', 'opacity.scrim', 'rendering.image']) {
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
  reject((f) => { f.themes[otherTheme].color.canvas.$type = 'dimension'; }, /type/i));
test('missing, invalid and raw reference values are rejected', () => {
  reject((f) => { f.themes[defaultTheme].color.canvas.$value = '{color.missing}'; }, /reference/i);
  reject((f) => { delete f.reference.color[f.themes[defaultTheme].color.canvas.$value.slice(7, -1)]; }, /reference/i);
  reject((f) => { f.themes[defaultTheme].color.canvas.$value = '#fff'; }, /alias/i);
});
test('component layers, semantic paths and CSS aliases are rejected', () => {
  reject((f) => { Object.assign(f, { component: {} }); }, /component/i);
  reject((f) => { f.themes[defaultTheme].component = {}; }, /component/i);
  reject((f) => { f.themes[defaultTheme].color['button-component'] = token(); }, /component/i);
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
test('identical themes cannot masquerade as two visual shells', () => {
  for (const theme of themeNames.filter((name) => name !== defaultTheme)) {
    reject((f) => { f.themes[theme] = structuredClone(f.themes[defaultTheme]); }, /differ/i);
  }
});

test('every theme keeps identical semantic keys, including a newly added theme', () => {
  reject((f) => {
    f.themes.extra = structuredClone(f.themes[defaultTheme]);
    f.themes.extra.color.canvas.$value = '{color.neutral-1000}';
    delete f.themes.extra.color.prize;
  }, /semantic keys differ between themes: extra/i);
});

test('declared contrast pairs meet their per-theme minimum ratio', () => {
  assert.ok(contrastPairs.length >= 30, 'text, status, call-state, celebration and tie pairs are declared');
  for (const role of ['text', 'ui']) assert.ok(contrastPairs.some((pair) => pair.role === role), role);
  // Collapsing text onto its own background fails in every theme.
  for (const theme of themeNames) {
    reject((f) => { f.themes[theme].color.text.$value = f.themes[theme].color.surface.$value; },
      new RegExp(`below [\\d.]+:1 in ${theme}: color\\.text on color\\.`));
  }
  // high-contrast requires AAA text: a pair that passes AA (4.5:1) but not 7:1 is rejected there only.
  const hc = 'high-contrast';
  const aaOnly = '#767676';
  reject((f) => {
    f.reference.color['aa-only'] = { $type: 'color', $value: aaOnly };
    f.reference.color['aa-only-surface'] = { $type: 'color', $value: '#ffffff' };
    f.themes[hc].color['call-called'].$value = '{color.aa-only}';
    f.themes[hc].color['call-called-surface'].$value = '{color.aa-only-surface}';
  }, /below 7:1 in high-contrast: color\.call-called on color\.call-called-surface/);
  // Translucent backgrounds are composited over the canvas rather than skipped.
  reject((f) => {
    f.reference.color.clear = { $type: 'color', $value: '#ffffff00' };
    for (const theme of themeNames) f.themes[theme].color['call-latest-surface'].$value = '{color.clear}';
    for (const theme of themeNames) f.themes[theme].color['call-latest'].$value = f.themes[theme].color.canvas.$value;
  }, /below [\d.]+:1 in [\w-]+: color\.call-latest on color\.call-latest-surface/);
  reject((f) => { f.reference.color[f.themes[defaultTheme].color.text.$value.slice(7, -1)].$value = 'navy'; }, /#rrggbb/);
});
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
    'border: var(--bingo-color-border) solid var(--bingo-color-border);',
    'border: var(--bingo-font-size) solid var(--bingo-color-border);',
    'border: var(--bingo-reference-border-width-thin) solid var(--bingo-color-border);',
  ]) rejectCss(declaration, /raw color|reference/i);
  for (const declaration of [
    'border-radius: var(--bingo-radius-surface);',
    'transition: background-color var(--bingo-motion-normal);',
    'border: 1px solid var(--bingo-color-border);',
    'box-shadow: 0 1px var(--bingo-color-border);',
    'border: var(--bingo-border-width-default) solid var(--bingo-color-border);',
    'box-shadow: var(--bingo-elevation-raised) var(--bingo-elevation-raised) 0 var(--bingo-color-shadow);',
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
  const disabled = rules.find(({ selector }) => selector.split(',').map((part) => part.trim()).includes('button:disabled'));
  assert.ok(disabled, 'explicit disabled rule');
  assert.match(disabled.body, /cursor:\s*(?:not-allowed|default)/);
  assert.match(disabled.body, /(?:color|background|border-color):\s*var\(--bingo-color-[\w-]+\)/);
  const opacity = /(?:^|;)\s*opacity:\s*var\(--bingo-opacity-disabled\)\s*(?:;|$)/.exec(disabled.body);
  assert.ok(opacity, 'disabled buttons need an explicit, theme-independent visual difference');
  // The semantic opacity must resolve to the same partial value in every theme.
  const { reference, themes } = sources();
  const values = new Set(themeNames.map((theme) => {
    const alias = themes[theme].opacity.disabled.$value.slice(1, -1).split('.');
    return Number((reference as Record<string, Record<string, { $value: unknown }>>)[alias[0]][alias[1]].$value);
  }));
  assert.equal(values.size, 1, 'disabled opacity is theme-independent');
  const [value] = values;
  assert.ok(value > 0 && value < 1, 'disabled opacity must be between 0 and 1');
});
test('public lot paragraphs are narrow, square, unclipped and animate only while visible within a bounded duration', () => {
  const css = sources().css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const lot = rules.filter(({ selector }) => /#line-(?:award|lot-playback)/.test(selector));
  assert.ok(lot.length >= 3, 'lot rules exist');
  for (const { selector, body } of lot) {
    for (const part of selector.split(',')) assert.match(part.trim(), /^\.public-side #line-(?:award|lot-playback)/, part);
    assert.doesNotMatch(body, /\b(?:height|text-overflow|position|opacity|visibility|clip(?:-path)?|content)\s*:|overflow:\s*(?:hidden|clip)|random/);
  }
  assert.ok(lot.some(({ body }) => /border-radius:\s*0\s*;/.test(body)), 'square corners');
  assert.ok(lot.some(({ selector, body }) => /#line-lot-playback\[hidden\]/.test(selector) && /display:\s*none/.test(body)), 'explicit hidden');
  const animated = lot.filter(({ body }) => /animation:\s*(?!none)\S/.test(body));
  assert.equal(animated.length, 1);
  assert.match(animated[0].selector, /#line-lot-playback:not\(\[hidden\]\)$/);
  assert.match(animated[0].body, /animation:\s*[\w-]+ var\(--bingo-motion-slow\) var\(--bingo-motion-easing\) [1-4] both/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*#line-lot-playback[^}]*animation:\s*none/);
});
