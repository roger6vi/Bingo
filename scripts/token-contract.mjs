import { readFileSync } from 'node:fs';

export const semanticVariable = (key) => `--bingo-${key.replaceAll('.', '-')}`;

export const sourcePaths = {
  reference: 'tokens/reference.json',
  themes: ['pixel-classic', 'high-contrast'],
};

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
const length = '(?:0|[+-]?(?:\\d*\\.)?\\d+(?:px|em|rem|vh|vw|%))';
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

export function validateTokenContracts({ reference, themes, css, ...layers }) {
  if (Object.keys(layers).length) throw new Error('Component or extra token layer forbidden');
  const refs = flatten(reference);
  for (const [key, token] of Object.entries(refs)) {
    if (typeof token.$value === 'string' && /^\{.*\}$/.test(token.$value)) throw new Error(`Reference must be raw: ${key}`);
  }
  const classic = flatten(themes['pixel-classic'], '', {}, true);
  const contrast = flatten(themes['high-contrast'], '', {}, true);
  const keys = Object.keys(classic).sort();
  if (keys.length === 0 || keys.join('|') !== Object.keys(contrast).sort().join('|')) {
    throw new Error('Semantic keys differ between themes');
  }
  let differences = 0;
  for (const key of keys) {
    const first = classic[key];
    const second = contrast[key];
    if (first.$type !== second.$type) throw new Error(`Semantic type mismatch: ${key}`);
    for (const token of [first, second]) {
      const alias = typeof token.$value === 'string' && /^\{([a-z][\w-]*(?:\.[a-z][\w-]*)+)\}$/.exec(token.$value);
      if (!alias) throw new Error(`Semantic value must be a reference alias: ${key}`);
      if (!refs[alias[1]] || refs[alias[1]].$type !== token.$type) {
        throw new Error(`Invalid reference or type: ${key} -> ${alias[1]}`);
      }
    }
    if (first.$value !== second.$value) differences++;
  }
  if (!differences) throw new Error('Themes must differ intentionally');
  if (/--bingo-reference-[\w-]+/.test(css)) throw new Error('Screen consumes reference variable');
  for (const [, name] of css.matchAll(/--bingo-([\w-]+)/gi)) {
    if (componentSegment.test(name)) {
      throw new Error(`Component alias forbidden: --bingo-${name}`);
    }
  }
  validateScreenColors(css);
  return { keys, referenceKeys: Object.keys(refs).sort(), differences };
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
  console.log(`Validated ${result.referenceKeys.length} reference and ${result.keys.length} semantic tokens in two themes`);
}
