import { html } from 'lit';
import './bingo-app-shell.mjs';
import './bingo-panel.mjs';
import './bingo-status.mjs';
import './bingo-event-list.mjs';
import { manyEvents } from '../../.storybook/lib/fixtures.mjs';

// The operator window's full-viewport frame. It pins itself to the window (position: fixed), so the
// document never scrolls; `Screens/Operator` shows it with the real page inside.
const shell = ({ status, rows }) => html`<bingo-app-shell lang="es" class="operator-app">
  <header slot="header" class="app-header" style="grid-template-columns: auto minmax(0, 1fr)">
    <div class="app-brand"><span class="app-mark" aria-hidden="true">90</span><h1>Consola del operador</h1></div>
    <bingo-status class="active-event-banner" message="Evento activo: Bingo solidario de primavera"></bingo-status>
  </header>
  <main class="app-main">
    <bingo-panel heading="Eventos" compact fill>
      <bingo-event-list loaded .events=${manyEvents(rows)}></bingo-event-list>
    </bingo-panel>
  </main>
  ${status ? html`<footer slot="status" class="app-status">
    <bingo-status message="Fase: Cantando números"></bingo-status>
    <bingo-status message="Evento listo"></bingo-status>
  </footer>` : ''}
</bingo-app-shell>`;

export default {
  title: 'Components/App shell',
  component: 'bingo-app-shell',
  args: { status: true, rows: 3 },
  argTypes: {
    status: { control: 'boolean', description: 'Slot a status bar (slot="status"); without one the row collapses.' },
    rows: { control: { type: 'number', min: 0, max: 200 }, description: 'Story-only: events in the list.' },
  },
  parameters: { layout: 'fullscreen', sideBySide: false, docs: { story: { inline: false, height: '24rem' } } },
  render: shell,
};

export const Default = {};

export const WithoutStatus = { name: 'Without status bar', args: { status: false } };

export const Overflowing = { name: 'Overflowing · content scrolls inside', args: { rows: 40 } };
