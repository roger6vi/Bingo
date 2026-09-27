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
  for (const color of ['#fff', 'rgb(1, 2, 3)', 'red']) rejectCss(`color: ${color};`, /raw color/i);
});
