import { html } from 'lit';
import './bingo-panel.mjs';
import './bingo-status.mjs';
import './bingo-button.mjs';
import './bingo-event-list.mjs';
import { frame } from '../../.storybook/lib/kit.mjs';
import { manyEvents } from '../../.storybook/lib/fixtures.mjs';

export default {
  title: 'Components/Panel',
  component: 'bingo-panel',
  args: { heading: 'Current event', compact: false, fill: false },
  argTypes: {
    heading: { control: 'text', description: 'Uppercase panel heading (labels the section).' },
    compact: { control: 'boolean', description: 'Dense operator variant: thin border and a header bar with an `actions` slot.' },
    fill: { control: 'boolean', description: 'Takes the grid cell\'s full height and scrolls the body.' },
  },
  render: ({ heading, compact, fill }) => frame(html`<bingo-panel .heading=${heading} ?compact=${compact} ?fill=${fill}>
    <bingo-status message="Event ready"></bingo-status>
    <p>Panels group one task. Content is slotted and keeps the app's light-DOM styles.</p>
    <bingo-button>Reload event</bingo-button>
  </bingo-panel>`),
};

export const Default = {};

export const Empty = { render: ({ heading }) => frame(html`<bingo-panel .heading=${heading}></bingo-panel>`) };

export const Compact = {
  name: 'Compact · with actions',
  render: () => frame(html`<bingo-panel lang="es" heading="Eventos" compact>
    <bingo-button slot="actions">Recargar eventos</bingo-button>
    <bingo-status message="4 eventos"></bingo-status>
  </bingo-panel>`),
};

export const Fill = {
  name: 'Compact · fill (scrolls inside)',
  parameters: { docs: { description: { story: 'In a fixed-height grid cell the body scrolls; the header stays put.' } } },
  render: () => html`<div lang="es" style="display: grid; height: 16rem; max-width: 32rem">
    <bingo-panel heading="Eventos" compact fill>
      <bingo-event-list loaded .events=${manyEvents(12)}></bingo-event-list>
    </bingo-panel>
  </div>`,
};

export const LongHeading = { name: 'Long heading', args: { heading: 'Sample media preview (not event state)' } };

export const SideBySide = {
  name: 'Two-column layout',
  parameters: { docs: { description: { story: 'Panels in the operator grid stretch to equal height.' } } },
  render: () => html`<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem">
    <bingo-panel lang="es" heading="Eventos" compact><p>4 eventos</p></bingo-panel>
    <bingo-panel lang="es" heading="Nuevo evento" compact><p>Nombre, lugar y fecha.</p><bingo-button variant="primary">Crear evento</bingo-button></bingo-panel>
  </div>`,
};
