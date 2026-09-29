import StyleDictionary from 'style-dictionary';
import { transformTypes } from 'style-dictionary/enums';
import { semanticVariable, sourcePaths } from './scripts/token-contract.mjs';

const variable = (path) => semanticVariable(path.join('.'));
StyleDictionary.registerTransform({
  name: 'bingo/name',
  type: transformTypes.name,
  transform: (token) => variable(token.path),
});

// DTCG cubicBezier values are arrays; every other reference value is already CSS text.
const cssValue = ({ $type, $value }) => ($type === 'cubicBezier' ? `cubic-bezier(${$value.join(', ')})` : $value);

StyleDictionary.registerFormat({
  name: 'bingo/theme',
  format: ({ dictionary, options }) => {
    const reference = options.theme === sourcePaths.defaultTheme;
    const selectors = reference ? `:root, [data-theme="${options.theme}"]` : `[data-theme="${options.theme}"]`;
    const tokens = dictionary.allTokens.filter((token) => reference || token.path[0] === 'semantic');
    const lines = tokens.map((token) => {
      const name = variable(token.path[0] === 'semantic' ? token.path.slice(1) : token.path);
      const value = token.path[0] === 'semantic'
        ? `var(${variable(token.original.$value.slice(1, -1).split('.'))})`
        : cssValue(token.original);
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
