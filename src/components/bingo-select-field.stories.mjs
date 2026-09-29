import { html } from 'lit';
import './bingo-select-field.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

// Options are light-DOM children, as in the Configuración theme picker.
const field = ({ label, value, error, disabled, pending }) => html`<bingo-select-field lang="es"
  .label=${label} .value=${value} .error=${error} ?disabled=${disabled} ?pending=${pending}>
  <option value="jules">Jules</option>
  <option value="light">Claro</option>
  <option value="high-contrast">Alto contraste</option>
</bingo-select-field>`;

const base = { label: 'Tema para ambas pantallas', value: 'jules', error: '', disabled: false, pending: false };

export default {
  title: 'Components/Select field',
  component: 'bingo-select-field',
  args: base,
  argTypes: {
    label: { control: 'text' },
    value: { control: 'inline-radio', options: ['jules', 'light', 'high-contrast'] },
    error: { control: 'text' },
    disabled: { control: 'boolean' },
    pending: { control: 'boolean', description: 'Replaces the chevron with the busy indicator.' },
  },
  render: (args) => frame(field(args), '20rem'),
};

export const Default = {};

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const ErrorState = { name: 'Error', args: { error: 'No se pudo guardar el tema. Inténtalo de nuevo.' } };

export const Pending = { name: 'Pending · saving theme', args: { pending: true } };

export const Disabled = { args: { disabled: true } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Default', frame(field(base), '20rem')],
    ['Hover', frame(forceState('hover', field(base)), '20rem')],
    ['Focus visible', frame(forceState('focus-visible', field(base)), '20rem')],
    ['Error', frame(field({ ...base, error: 'No se pudo guardar el tema. Inténtalo de nuevo.' }), '20rem')],
    ['Pending', frame(field({ ...base, pending: true }), '20rem')],
    ['Disabled', frame(field({ ...base, disabled: true }), '20rem')],
  ]),
};
