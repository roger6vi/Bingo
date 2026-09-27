import StyleDictionary from 'style-dictionary';
import { transformTypes } from 'style-dictionary/enums';
import { semanticVariable } from './scripts/token-contract.mjs';

const variable = (path) => semanticVariable(path.join('.'));
StyleDictionary.registerTransform({
  name: 'bingo/name',
  type: transformTypes.name,
  transform: (token) => variable(token.path),
});

StyleDictionary.registerFormat({
  name: 'bingo/theme',
  format: ({ dictionary, options }) => {
    const reference = options.theme === 'pixel-classic';
    const selectors = reference ? ':root, [data-theme="pixel-classic"]' : '[data-theme="high-contrast"]';
    const tokens = dictionary.allTokens.filter((token) => reference || token.path[0] === 'semantic');
    const lines = tokens.map((token) => {
      const name = variable(token.path[0] === 'semantic' ? token.path.slice(1) : token.path);
      const value = token.path[0] === 'semantic'
        ? `var(${variable(token.original.$value.slice(1, -1).split('.'))})`
        : token.original.$value;
      return `  ${name}: ${value};`;
    });
    return `${selectors} {\n${lines.join('\n')}\n}\n`;
  },
});

function prefixAliases(tree) {
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [key,
    '$value' in value ? { ...value, $value: value.$value.replace(/^\{/, '{reference.') } : prefixAliases(value),
  ]));
}

export function themeConfig(reference, semantic, theme) {
  return {
    tokens: { reference, semantic: prefixAliases(semantic) },
    platforms: {
      css: {
        transforms: ['bingo/name'],
        buildPath: 'src/generated/',
        files: [{ destination: `${theme}.css`, format: 'bingo/theme', options: { theme } }],
      },
    },
  };
}
