import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming/create';
import reference from '../tokens/reference.json';
import light from '../tokens/semantic/light.json';

// Manager chrome uses the Light theme's semantic colours, resolved to their reference values, so the
// tool reads as part of the product and follows token changes without edits here.
const color = Object.fromEntries(Object.entries(light.color).map(([name, token]) => {
  const alias = /^\{color\.([\w-]+)\}$/.exec(token.$value);
  return [name, alias ? reference.color[alias[1]].$value : token.$value];
}));

addons.setConfig({
  theme: create({
    base: 'light',
    brandTitle: 'Bingo UI',
    brandTarget: '_self',
    fontBase: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontCode: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    colorPrimary: color.accent,
    colorSecondary: color.accent,
    appBg: color.canvas,
    appContentBg: color.surface,
    appPreviewBg: color.canvas,
    appBorderColor: color.border,
    appBorderRadius: 4,
    textColor: color.text,
    textMutedColor: color.muted,
    textInverseColor: color['on-accent'],
    barBg: color.surface,
    barTextColor: color.muted,
    barSelectedColor: color.accent,
    barHoverColor: color.accent,
    inputBg: color.surface,
    inputBorder: color.border,
    inputTextColor: color.text,
    inputBorderRadius: 3,
  }),
  // Denser than Storybook's defaults: a narrower sidebar and a shorter addon panel leave the canvas
  // room for 16:9 screens on a 1280×720 laptop.
  layout: { navSize: 256, bottomPanelHeight: 220 },
  sidebar: { showRoots: true },
  toolbar: { zoom: { hidden: false } },
});
