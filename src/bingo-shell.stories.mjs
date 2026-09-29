import { html } from 'lit';
import './bingo-shell.mjs';
import './components/bingo-panel.mjs';
import './components/bingo-status.mjs';

export default {
  title: 'Components/Shell',
  component: 'bingo-shell',
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Page frame for both windows. `screen.css` centres it and caps its width; '
      + 'pages with a public layout or the Configuración workspace let it span the full width.' } },
  },
  render: () => html`<bingo-shell><main>
    <h1>Operator console</h1>
    <bingo-panel heading="Current event"><bingo-status message="Event ready"></bingo-status></bingo-panel>
  </main></bingo-shell>`,
};

export const Default = {};
