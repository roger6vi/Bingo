// The app's global stylesheet (body, layout and form defaults) plus every generated theme, so new
// themes from the token pipeline are styled without editing this file.
import '../src/screen.css';
import './preview.css';
import { DEFAULT_THEME } from '../src/theme-controller.mjs';
import { themeToolbarItems, withTheme } from './lib/themes.mjs';

import.meta.glob('../src/generated/*.css', { eager: true });

// screen.css hides <body> until a theme is applied; docs-only pages render no story to apply one.
document.documentElement.dataset.theme ||= DEFAULT_THEME;

// Operator laptops and the public reference screen (issue #76).
const VIEWPORTS = {
  operator1280: { name: 'Operator laptop · 1280×720', styles: { width: '1280px', height: '720px' }, type: 'desktop' },
  operator1366: { name: 'Operator laptop · 1366×768', styles: { width: '1366px', height: '768px' }, type: 'desktop' },
  public1920: { name: 'Public reference · 1920×1080', styles: { width: '1920px', height: '1080px' }, type: 'desktop' },
};

/** @type {import('@storybook/web-components-vite').Preview} */
export default {
  tags: ['autodocs'],
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Theme applied as <html data-theme>',
      toolbar: { title: 'Theme', icon: 'paintbrush', items: themeToolbarItems, dynamicTitle: true },
    },
  },
  initialGlobals: { theme: DEFAULT_THEME },
  parameters: {
    layout: 'padded',
    viewport: { options: VIEWPORTS },
    // The theme owns the canvas colour; a second background switcher would only disagree with it.
    backgrounds: { disable: true },
    controls: { expanded: true, sort: 'requiredFirst' },
    a11y: { test: 'error' },
    options: {
      // Alphabetical inside each component puts "All states" first; screen stories group by tab prefix.
      storySort: { method: 'alphabetical', order: ['Introduction', 'Foundations', 'Components', 'Screens', ['Operator', ['Eventos', 'Configuración', 'Bingo'], 'Public display']] },
    },
  },
};
