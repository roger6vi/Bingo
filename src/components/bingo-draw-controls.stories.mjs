import { html } from 'lit';
import './bingo-draw-controls.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

const controls = ({ manualDisabled, digitalDisabled, reloadDisabled }) => html`<bingo-draw-controls
  .manualDisabled=${manualDisabled} .digitalDisabled=${digitalDisabled} .reloadDisabled=${reloadDisabled}></bingo-draw-controls>`;

export default {
  title: 'Components/Draw controls',
  component: 'bingo-draw-controls',
  args: { manualDisabled: false, digitalDisabled: false, reloadDisabled: false },
  argTypes: {
    manualDisabled: { control: 'boolean', description: 'Locks the manual input and its button.' },
    digitalDisabled: { control: 'boolean' },
    reloadDisabled: { control: 'boolean' },
  },
  render: (args) => frame(controls(args), '36rem'),
};

export const Ready = {};

export const Waiting = {
  name: 'Waiting for state',
  parameters: { docs: { description: { story: 'Component default: draws stay locked until committed state arrives.' } } },
  args: { manualDisabled: true, digitalDisabled: true },
};

export const Pending = {
  name: 'Pending · request in flight',
  args: { manualDisabled: true, digitalDisabled: true, reloadDisabled: true },
};

export const Finished = { name: 'All 90 called', args: { manualDisabled: true, digitalDisabled: true } };

export const ManualEntry = {
  name: 'Manual entry · focused',
  play: async ({ canvasElement }) => {
    const element = canvasElement.querySelector('bingo-draw-controls');
    await element.updateComplete;
    element.manualInput.value = '42';
  },
  parameters: { pseudo: { focusVisible: true } },
};

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Ready', controls({ manualDisabled: false, digitalDisabled: false, reloadDisabled: false })],
    ['Hover', forceState('hover', controls({ manualDisabled: false, digitalDisabled: false, reloadDisabled: false }))],
    ['Focus visible', forceState('focus-visible', controls({ manualDisabled: false, digitalDisabled: false, reloadDisabled: false })), 'Keyboard'],
    ['Waiting', controls({ manualDisabled: true, digitalDisabled: true, reloadDisabled: false }), 'Reload stays available'],
    ['Pending', controls({ manualDisabled: true, digitalDisabled: true, reloadDisabled: true }), 'Everything locked'],
  ]),
};
