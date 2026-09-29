import { html } from 'lit';
import './bingo-text-field.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { LONG_EVENT } from '../../.storybook/lib/fixtures.mjs';

const field = ({ label, value, hint, error, required, disabled, pending }) => html`<bingo-text-field lang="es"
  .label=${label} .value=${value} .hint=${hint} .error=${error} ?required=${required} ?disabled=${disabled}
  ?pending=${pending} maxlength="120"></bingo-text-field>`;

const base = { label: 'Nombre', value: 'Bingo solidario de primavera', hint: '', error: '', required: true, disabled: false, pending: false };

export default {
  title: 'Components/Text field',
  component: 'bingo-text-field',
  args: base,
  argTypes: {
    label: { control: 'text' },
    value: { control: 'text' },
    hint: { control: 'text', description: 'Help text, linked with aria-describedby.' },
    error: { control: 'text', description: 'Announced error; marks the control invalid (never colour alone).' },
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
    pending: { control: 'boolean', description: 'Saving: a busy indicator appears once the wait is noticeable.' },
  },
  render: (args) => frame(field(args), '24rem'),
};

export const Filled = {};

export const EmptyField = { name: 'Empty', args: { value: '' } };

export const Hint = { args: { label: 'Lugar', value: 'Casal del barrio', hint: 'Se muestra en la pantalla pública.' } };

export const Hover = { parameters: { pseudo: { hover: true } } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const ErrorState = { name: 'Error', args: { label: 'Lugar', value: '', error: 'Escribe el lugar del evento.' } };

export const Pending = { name: 'Pending · saving', args: { pending: true } };

export const Disabled = { args: { disabled: true } };

export const LongValue = { name: 'Long value', args: { value: LONG_EVENT.name } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Empty', frame(field({ ...base, value: '' }), '24rem')],
    ['Filled', frame(field(base), '24rem')],
    ['Hover', frame(forceState('hover', field(base)), '24rem')],
    ['Focus visible', frame(forceState('focus-visible', field(base)), '24rem'), 'Keyboard'],
    ['Hint', frame(field({ ...base, hint: 'Se muestra en la pantalla pública.' }), '24rem')],
    ['Error', frame(field({ ...base, value: '', error: 'Escribe el nombre del evento.' }), '24rem'), 'Icon + message'],
    ['Pending', frame(field({ ...base, pending: true }), '24rem')],
    ['Disabled', frame(field({ ...base, disabled: true }), '24rem'), 'Dashed border'],
  ]),
};
