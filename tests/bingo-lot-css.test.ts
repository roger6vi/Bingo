import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Structural pin for BG-07 G2: #bingo-lot-playback must reuse the existing #line-lot-playback styles
// (owner decision: "Estilo paridad con Línea"), without styling #bingo-award.
//
// Honest limitation: the web-test-runner config stubs './screen.css' for public-ui loads
// (web-test-runner.config.mjs, public-ui-screen-css plugin), so browser suites cannot assert real
// styles. This structural pin is the verification surface, alongside `npm run test:tokens` and
// `npm run build` staying green.

const css = readFileSync(new URL('../src/screen.css', import.meta.url), 'utf8')
  // Comments carry no declarations; strip them before rule extraction.
  .replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  declarations: string[];
}

function rules(): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((s) => s.trim()).filter(Boolean),
    declarations: match[2].split(';')
      .map((d) => d.trim())
      .filter((d) => d.includes(':')),
  }));
}

const declarationsFor = (id: string, all: Rule[]): string[] =>
  all.filter((rule) => rule.selectors.some((s) => s.includes(`#${id}`)))
    .flatMap((rule) => rule.declarations)
    .sort();

test('#bingo-lot-playback is styled with exactly the #line-lot-playback declarations', () => {
  const all = rules();
  const line = declarationsFor('line-lot-playback', all);
  assert.ok(line.length > 0, '#line-lot-playback must be styled');
  assert.deepEqual(
    declarationsFor('bingo-lot-playback', all),
    line,
    'the bingo lot playback must reuse the line lot playback styles',
  );
});

test('#line-lot-playback declarations are unchanged from before this unit', () => {
  // Exact guard snapshot of the pre-BG-07-G2 rules (screen.css lines 271-285), sorted.
  const expected = [
    'animation: line-lot-emphasis var(--bingo-motion-slow) var(--bingo-motion-easing) 2 both',
    'animation: none',
    'background: var(--bingo-color-surface-raised)',
    'border: var(--bingo-border-width-strong) solid var(--bingo-color-prize)',
    'border-radius: 0',
    'color: var(--bingo-color-text)',
    'display: none',
    'font-weight: var(--bingo-font-emphasis)',
    'margin: var(--bingo-space-small) 0 0',
    'min-width: 0',
    'overflow-wrap: anywhere',
    'padding: var(--bingo-space-inset-compact)',
    'transition: none',
  ].sort();
  assert.deepEqual(declarationsFor('line-lot-playback', rules()), expected);
});

test('only the bingo lot playback gains parity: every #line-lot-playback rule covers #bingo-lot-playback and #bingo-award stays unstyled', () => {
  const all = rules();
  for (const rule of all) {
    if (rule.selectors.some((s) => s.includes('#line-lot-playback'))) {
      assert.ok(
        rule.selectors.some((s) => s.includes('#bingo-lot-playback')),
        `selector list lacks bingo parity: ${rule.selectors.join(', ')}`,
      );
    }
  }
  assert.ok(
    !all.some((rule) => rule.selectors.some((s) => s.includes('#bingo-award'))),
    '#bingo-award must remain unstyled (separate implicit decision)',
  );
});
