import { html } from 'lit';
import './bingo-button.mjs';
import { forceState, stateMatrix } from '../../.storybook/lib/kit.mjs';

export default {
  title: 'Components/Button',
  component: 'bingo-button',
  args: { label: 'Draw digital number', disabled: false },
  argTypes: {
    label: { control: 'text', description: 'Slotted label text.' },
    disabled: { control: 'boolean', description: 'Reflects to the inner native button.' },
  },
  render: ({ label, disabled }) => html`<bingo-button ?disabled=${disabled}>${label}</bingo-button>`,
};

export const Default = {};

export const Hover = { parameters: { pseudo: { hover: true } } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const Disabled = { args: { disabled: true } };

export const LongLabel = { name: 'Long label', args: { label: 'Move public window to secondary display' } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Normal', html`<bingo-button>Draw digital number</bingo-button><bingo-button>Reload event</bingo-button>`],
    ['Hover', forceState('hover', html`<bingo-button>Draw digital number</bingo-button>`)],
    ['Focus visible', forceState('focus-visible', html`<bingo-button>Draw digital number</bingo-button>`), 'Keyboard focus ring'],
    ['Disabled', html`<bingo-button disabled>Draw digital number</bingo-button>`, 'Not focusable'],
    ['Long label', html`<bingo-button>Move public window to secondary display</bingo-button>`],
  ]),
};
