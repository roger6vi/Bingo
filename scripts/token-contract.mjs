import { readFileSync } from 'node:fs';

export const semanticVariable = (key) => `--bingo-${key.replaceAll('.', '-')}`;

export const sourcePaths = {
  reference: 'tokens/reference.json',
  themes: ['pixel-classic', 'high-contrast'],
  // The default theme also carries the reference variables and the :root fallback.
  defaultTheme: 'pixel-classic',
};

// Declared text/background pairs, checked in every theme. Minimums follow WCAG 2.2:
// text AA 4.5:1 (AAA 7:1 in high-contrast), non-text UI 3:1 (4.5:1 in high-contrast).
// A translucent background is composited over color.canvas, a translucent foreground over its background.
export const contrastMinimums = { text: 4.5, ui: 3 };
export const strictContrastMinimums = { 'high-contrast': { text: 7, ui: 4.5 } };
const textPairs = [
  ['text', 'canvas'], ['text', 'surface'], ['text', 'surface-raised'], ['text', 'surface-sunken'],
  ['muted', 'canvas'], ['muted', 'surface'],
  ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['on-accent', 'accent-active'],
  ['info', 'surface'], ['success', 'surface'], ['warning', 'surface'], ['error', 'surface'], ['error', 'canvas'],
  ['call-uncalled', 'call-uncalled-surface'], ['call-called', 'call-called-surface'], ['call-latest', 'call-latest-surface'],
  ['on-celebration', 'celebration'], ['prize', 'surface'],
  ...Array.from({ length: 8 }, (_, index) => ['on-tie', `tie-${index + 1}`]),
];
const uiPairs = [
  ['focus', 'canvas'], ['focus', 'surface'], ['border-strong', 'canvas'], ['border-strong', 'surface'],
  ['accent', 'surface'], ['accent', 'call-called-surface'],
];
export const contrastPairs = [
  ...textPairs.map(([foreground, background]) => ({ foreground: `color.${foreground}`, background: `color.${background}`, role: 'text' })),
  ...uiPairs.map(([foreground, background]) => ({ foreground: `color.${foreground}`, background: `color.${background}`, role: 'ui' })),
];

// Forbid complete hyphen-delimited component names in semantic paths and
// consumed --bingo-* variables, without rejecting words such as color.accent.
const componentNames = ['button', 'panel', 'dialog', 'status', 'number', 'icon', 'shell',
  'board', 'controls', 'checking-state', 'prize-banner', 'event-summary', 'component'];
const componentSegment = new RegExp(`(?:^|-)(?:${componentNames.join('|')})(?=-|$)`, 'i');

function flatten(tree, prefix = '', result = {}, semantic = false) {
  for (const [name, value] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (semantic ? componentSegment.test(name) : /component/i.test(name)) {
      throw new Error(`Component token forbidden: ${key}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid token: ${key}`);
    if ('$value' in value || '$type' in value) {
      if (!('$value' in value && typeof value.$type === 'string')) throw new Error(`Incomplete token: ${key}`);
      result[key] = value;
    } else flatten(value, key, result, semantic);
  }
  return result;
}

// Accept only semantic color variables in visual color slots. Non-color border and
// shadow grammar is deliberately small: unknown syntax fails rather than letting
// named colors, gradients or functional colors through a keyword denylist.
const semanticColor = /var\(--bingo-color-[a-z][\w-]*\)/g;
// Lengths may also be semantic dimension variables (never color or reference variables).
const length = '(?:0|[+-]?(?:\\d*\\.)?\\d+(?:px|em|rem|vh|vw|%)|var\\(--bingo-(?:space|border-width|elevation)-[a-z][\\w-]*\\))';
const borderParts = new RegExp(`^(?:(?:${length}|none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)\\s*)*$`, 'i');
const shadowParts = new RegExp(`^(?:(?:${length}|inset)\\s*)+$`, 'i');

function validShadowLayers(value) {
  return value.split(',').every((layer) => {
    const colors = [...layer.matchAll(semanticColor)];
    return colors.length === 1 && shadowParts.test(layer.replace(semanticColor, '').trim());
  });
}

function validateScreenColors(css) {
  // The declaration scanner does not normalize CSS escapes; refuse them rather
  // than allowing escaped identifiers to bypass the semantic color contract.
  if (css.includes('\\')) throw new Error('Unsupported CSS escape in screen');
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]*)/gm);
  for (const [, property, rawValue] of declarations) {
    const name = property.toLowerCase();
    if (name.startsWith('--bingo-color-')) throw new Error(`Screen cannot override semantic color variable: ${property}`);
    const shorthand = /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|outline|column-rule)$/.test(name);
    const shadow = /^(?:box-shadow|text-shadow)$/.test(name);
    const filter = /^(?:-webkit-)?(?:backdrop-)?filter$/.test(name);
    const image = /^(?:background-image|border-image(?:-source)?|mask(?:-image)?)$/.test(name);
    const color = name === 'color' || name === 'background' || name === 'fill' || name === 'stroke' ||
      name === 'text-decoration' || /(?:^|-)color$/.test(name);
    if (!shorthand && !shadow && !filter && !image && !color) continue;
    const value = rawValue.trim();
    const variables = [...value.matchAll(semanticColor)];
    const rest = value.replace(semanticColor, '').trim();
    let valid = filter ? value === 'none' : shadow ? validShadowLayers(value) : variables.length > 0 && (
      shorthand ? variables.length === 1 && borderParts.test(rest) :
      // color lists (e.g. border-color) allow up to four semantic slots.
      /^(?:border.*-color|scrollbar-color)$/.test(name) ? variables.length <= 4 && rest === '' :
      variables.length === 1 && rest === ''
    );
    if (image && value === 'none') valid = true;
    if (!valid) throw new Error(`Screen contains raw color or unsupported color syntax: ${property}: ${value}`);
  }
}

function parseColor(value, key) {
  const match = typeof value === 'string' && /^#([\da-f]{6})([\da-f]{2})?$/i.exec(value);
  if (!match) throw new Error(`Contrast color must be #rrggbb or #rrggbbaa: ${key}`);
  const channels = match[1].match(/../g).map((hex) => parseInt(hex, 16) / 255);
  return { rgb: channels, alpha: match[2] ? parseInt(match[2], 16) / 255 : 1 };
}

const over = (top, bottom) => top.rgb.map((channel, index) => channel * top.alpha + bottom[index] * (1 - top.alpha));
const luminance = (rgb) => rgb
  .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);

export function contrastRatio(foreground, background, canvas) {
  const base = canvas.alpha === 1 ? canvas.rgb : null;
  if (!base) throw new Error('color.canvas must be opaque');
  const back = over(background, base);
  const [light, dark] = [luminance(over(foreground, back)), luminance(back)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function validateContrast(theme, semantic, refs) {
  const resolve = (key) => {
    const token = semantic[key];
    if (!token || token.$type !== 'color') throw new Error(`Contrast pair references missing color: ${theme} ${key}`);
    const target = token.$value.slice(1, -1);
    return parseColor(refs[target].$value, target);
  };
  const minimums = { ...contrastMinimums, ...strictContrastMinimums[theme] };
  const canvas = resolve('color.canvas');
  for (const { foreground, background, role } of contrastPairs) {
    const ratio = contrastRatio(resolve(foreground), resolve(background), canvas);
    if (ratio < minimums[role]) {
      throw new Error(`Contrast ${ratio.toFixed(2)}:1 below ${minimums[role]}:1 in ${theme}: ${foreground} on ${background}`);
    }
  }
}

export function validateTokenContracts({ reference, themes, css, ...layers }) {
  if (Object.keys(layers).length) throw new Error('Component or extra token layer forbidden');
  const refs = flatten(reference);
  for (const [key, token] of Object.entries(refs)) {
    if (typeof token.$value === 'string' && /^\{.*\}$/.test(token.$value)) throw new Error(`Reference must be raw: ${key}`);
  }
  const names = Object.keys(themes);
  if (names.length < 2) throw new Error('At least two themes are required');
  const semantic = Object.fromEntries(names.map((theme) => [theme, flatten(themes[theme], '', {}, true)]));
  const keys = Object.keys(semantic[names[0]]).sort();
  for (const theme of names) {
    if (keys.length === 0 || keys.join('|') !== Object.keys(semantic[theme]).sort().join('|')) {
      throw new Error(`Semantic keys differ between themes: ${theme}`);
    }
  }
  for (const key of keys) {
    for (const theme of names) {
      const token = semantic[theme][key];
      if (token.$type !== semantic[names[0]][key].$type) throw new Error(`Semantic type mismatch: ${key}`);
      const alias = typeof token.$value === 'string' && /^\{([a-z][\w-]*(?:\.[a-z][\w-]*)+)\}$/.exec(token.$value);
      if (!alias) throw new Error(`Semantic value must be a reference alias: ${key}`);
      if (!refs[alias[1]] || refs[alias[1]].$type !== token.$type) {
        throw new Error(`Invalid reference or type: ${key} -> ${alias[1]}`);
      }
    }
  }
  let differences = 0;
  for (const [index, first] of names.entries()) {
    for (const second of names.slice(index + 1)) {
      const changed = keys.filter((key) => semantic[first][key].$value !== semantic[second][key].$value).length;
      if (!changed) throw new Error(`Themes must differ intentionally: ${first} and ${second}`);
      differences += changed;
    }
  }
  for (const theme of names) validateContrast(theme, semantic[theme], refs);
  if (/--bingo-reference-[\w-]+/.test(css)) throw new Error('Screen consumes reference variable');
  for (const [, name] of css.matchAll(/--bingo-([\w-]+)/gi)) {
    if (componentSegment.test(name)) {
      throw new Error(`Component alias forbidden: --bingo-${name}`);
    }
  }
  validateScreenColors(css);
  return { keys, referenceKeys: Object.keys(refs).sort(), differences, themes: names };
}

export function loadContracts() {
  const json = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  return {
    reference: json(sourcePaths.reference),
    themes: Object.fromEntries(sourcePaths.themes.map((theme) => [theme, json(`tokens/semantic/${theme}.json`)])),
    css: readFileSync(new URL('../src/screen.css', import.meta.url), 'utf8'),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = validateTokenContracts(loadContracts());
  console.log(`Validated ${result.referenceKeys.length} reference and ${result.keys.length} semantic tokens in ${result.themes.length} themes (${result.themes.join(', ')}) with ${contrastPairs.length} contrast pairs each`);
}
