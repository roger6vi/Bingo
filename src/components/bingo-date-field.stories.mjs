import { html } from 'lit';
import './bingo-date-field.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

const field = ({ label, value, error, required, disabled, pending }) => html`<bingo-date-field lang="es"
  .label=${label} .value=${value} .error=${error} ?required=${required} ?disabled=${disabled}
  ?pending=${pending}></bingo-date-field>`;

const base = { label: 'Fecha', value: '2026-10-03', error: '', required: true, disabled: false, pending: false };

export default {
  title: 'Components/Date field',
  component: 'bingo-date-field',
  args: base,
  argTypes: {
    label: { control: 'text' },
    value: { control: 'text', description: '`YYYY-MM-DD`.' },
    error: { control: 'text', description: 'Announced error; marks the control invalid.' },
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
    pending: { control: 'boolean' },
  },
  render: (args) => frame(field(args), '18rem'),
};

export const Filled = {};

export const EmptyField = { name: 'Empty', args: { value: '' } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const ErrorState = { name: 'Error', args: { value: '', error: 'Elige la fecha del evento.' } };

export const Pending = { name: 'Pending · saving', args: { pending: true } };

export const Disabled = { args: { disabled: true } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Empty', frame(field({ ...base, value: '' }), '18rem')],
    ['Filled', frame(field(base), '18rem'), 'Token-coloured calendar icon'],
    ['Hover', frame(forceState('hover', field(base)), '18rem')],
    ['Focus visible', frame(forceState('focus-visible', field(base)), '18rem')],
    ['Error', frame(field({ ...base, value: '', error: 'Elige la fecha del evento.' }), '18rem')],
    ['Pending', frame(field({ ...base, pending: true }), '18rem')],
    ['Disabled', frame(field({ ...base, disabled: true }), '18rem')],
  ]),
};
