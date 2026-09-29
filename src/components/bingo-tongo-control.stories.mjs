import { html } from 'lit';
import './bingo-tongo-control.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

// In the app the control is one cell of the Bingo rail's three-column claims row (Línea · Bingo · Tongo).
const control = ({ disabled, progress }) => html`<bingo-tongo-control lang="es" .disabled=${disabled}
  .progress=${progress}></bingo-tongo-control>`;

export default {
  title: 'Components/Tongo control',
  component: 'bingo-tongo-control',
  args: { disabled: false, progress: null },
  argTypes: {
    disabled: { control: 'boolean', description: 'Set by the owner unless a fresh, settled event is in `drawing` or `line_declared`, and while a request is pending.' },
    progress: { control: { type: 'range', min: 0, max: 1, step: 0.05 }, description: 'Private playback progress (`0…1`), or `null` when not playing. It overlays the button and never adds height.' },
  },
  render: (args) => frame(control(args), '6rem'),
};

export const Ready = {};

export const Unavailable = {
  name: 'Unavailable · not in play',
  parameters: { docs: { description: { story: 'Component default: offered only while the game is in play.' } } },
  args: { disabled: true },
};

export const Pending = { name: 'Pending · request in flight', args: { disabled: true } };

export const Playing = { name: 'Playing · private progress', args: { disabled: true, progress: 0.4 } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Ready', frame(control({ disabled: false, progress: null }), '6rem')],
    ['Hover', frame(forceState('hover', control({ disabled: false, progress: null })), '6rem')],
    ['Focus visible', frame(forceState('focus-visible', control({ disabled: false, progress: null })), '6rem'), 'Keyboard'],
    ['Unavailable', frame(control({ disabled: true, progress: null }), '6rem'), 'Outside play or pending'],
    ['Playing', frame(control({ disabled: true, progress: 0.4 }), '6rem'), 'Same size as ready'],
  ]),
};
