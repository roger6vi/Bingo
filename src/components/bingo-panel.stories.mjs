import { html } from 'lit';
import './bingo-panel.mjs';
import './bingo-status.mjs';
import './bingo-button.mjs';
import { frame } from '../../.storybook/lib/kit.mjs';

export default {
  title: 'Components/Panel',
  component: 'bingo-panel',
  args: { heading: 'Current event' },
  argTypes: { heading: { control: 'text', description: 'Uppercase panel heading (labels the section).' } },
  render: ({ heading }) => frame(html`<bingo-panel .heading=${heading}>
    <bingo-status message="Event ready"></bingo-status>
    <p>Panels group one task. Content is slotted and keeps the app's light-DOM styles.</p>
    <bingo-button>Reload event</bingo-button>
  </bingo-panel>`),
};

export const Default = {};

export const Empty = { render: ({ heading }) => frame(html`<bingo-panel .heading=${heading}></bingo-panel>`) };

export const LongHeading = { name: 'Long heading', args: { heading: 'Sample media preview (not event state)' } };

export const SideBySide = {
  name: 'Two-column layout',
  parameters: { docs: { description: { story: 'Panels in the operator grid stretch to equal height.' } } },
  render: () => html`<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem">
    <bingo-panel heading="Eventos"><p>4 eventos</p></bingo-panel>
    <bingo-panel heading="Nuevo evento"><p>Nombre, lugar y fecha.</p><bingo-button>Crear evento</bingo-button></bingo-panel>
  </div>`,
};
