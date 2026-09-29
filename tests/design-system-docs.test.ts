import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { semanticVariable } from '../scripts/token-contract.mjs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const docs = source('docs/design-system.md');
const catalog = docs.slice(docs.indexOf('## Component catalog'), docs.indexOf('### Specified, not implemented'));
// Each implemented entry starts with a heading naming its element(s) and lists the tokens it consumes.
const entries = catalog.split(/^### /m).slice(1).map((entry) => ({
  names: [...entry.split('\n')[0].matchAll(/`(bingo-[\w-]+)`/g)].map((match) => match[1]),
  tokens: new Set([...(/\*\*Tokens:\*\*([\s\S]*?)(?:\n- |\n\n|$)/.exec(entry)?.[1] ?? '')
    .matchAll(/`([a-z][\w-]*\.[a-z][\w-]*)`/g)].map((match) => semanticVariable(match[1]))),
}));

test('the component catalog documents every implemented component', () => {
  const components = readdirSync(new URL('../src/components/', import.meta.url))
    .map((file) => file.replace(/\.mjs$/, '')).concat('bingo-shell').sort();
  assert.deepEqual(entries.flatMap(({ names }) => names).sort(), components);
});

test('catalog token lists match the semantic variables each component consumes', () => {
  for (const { names, tokens } of entries) {
    if (names.includes('bingo-shell')) continue; // Styled by screen.css, not its own shadow DOM.
    const used = new Set(names.flatMap((name) => [...source(`src/components/${name}.mjs`)
      .matchAll(/var\((--bingo-[\w-]+)\)/g)].map((match) => match[1])));
    assert.deepEqual([...tokens].sort(), [...used].sort(), names.join(', '));
  }
});
