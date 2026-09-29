import { html } from 'lit';
import './bingo-tongo-control.mjs';
import { frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

// One claims-grid cell in the Bingo tab's Reclamaciones rail; progress overlays the button's lower edge.
export default {
  title: 'Components/Tongo Control',
  component: 'bingo-tongo-control',
  args: { disabled: false, progress: null },
  argTypes: {
    disabled: { control: 'boolean', description: 'Off unless the committed phase is drawing or line_declared.' },
    progress: { control: { type: 'range', min: 0, max: 1, step: 0.05 }, description: 'Private playback progress (0–1); null when idle.' },
  },
  render: ({ disabled, progress }) => frame(html`<bingo-tongo-control lang="es" .disabled=${disabled}
    .progress=${progress}></bingo-tongo-control>`, '12rem'),
};

export const Ready = {};

export const Playing = { args: { progress: 0.4 } };

export const Unavailable = { args: { disabled: true } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Ready', frame(html`<bingo-tongo-control lang="es" .disabled=${false}></bingo-tongo-control>`, '12rem'), 'Dispatches tongo-play'],
    ['Playing', frame(html`<bingo-tongo-control lang="es" .disabled=${false} .progress=${0.6}></bingo-tongo-control>`, '12rem'),
      'Same height; repeat input ignored'],
    ['Unavailable', frame(html`<bingo-tongo-control lang="es" .disabled=${true}></bingo-tongo-control>`, '12rem'), 'Not playable'],
  ]),
};
