import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming/create';
import reference from '../tokens/reference.json';

// Manager chrome uses the pixel-classic reference palette so the tool reads as part of the product.
const color = Object.fromEntries(Object.entries(reference.color).map(([name, token]) => [name, token.$value]));

addons.setConfig({
  theme: create({
    base: 'light',
    brandTitle: 'Bingo UI',
    brandTarget: '_self',
    fontBase: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontCode: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    colorPrimary: color.blue,
    colorSecondary: color.blue,
    appBg: color.paper,
    appContentBg: color.white,
    appPreviewBg: color.paper,
    appBorderColor: color.edge,
    appBorderRadius: 4,
    textColor: color.ink,
    textMutedColor: color.slate,
    textInverseColor: color.white,
    barBg: color.white,
    barTextColor: color.slate,
    barSelectedColor: color.blue,
    barHoverColor: color.blue,
    inputBg: color.white,
    inputBorder: color.edge,
    inputTextColor: color.ink,
    inputBorderRadius: 3,
  }),
  // Denser than Storybook's defaults: a narrower sidebar and a shorter addon panel leave the canvas
  // room for 16:9 screens on a 1280×720 laptop.
  layout: { navSize: 256, bottomPanelHeight: 220 },
  sidebar: { showRoots: true },
  toolbar: { zoom: { hidden: false } },
});
