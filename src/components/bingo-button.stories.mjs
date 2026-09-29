import { html } from 'lit';
import './bingo-button.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

export default {
  title: 'Components/Button',
  component: 'bingo-button',
  args: { label: 'Recargar evento', variant: '', block: false, disabled: false },
  argTypes: {
    label: { control: 'text', description: 'Slotted label text.' },
    variant: { control: 'inline-radio', options: ['', 'primary'], description: '`primary` marks the one main action of a form or dialog.' },
    block: { control: 'boolean', description: 'Stretches the button to fill its container.' },
    disabled: { control: 'boolean', description: 'Reflects to the inner native button.' },
  },
  render: ({ label, variant, block, disabled }) => html`<bingo-button lang="es" variant=${variant} ?block=${block}
    ?disabled=${disabled}>${label}</bingo-button>`,
};

export const Default = {};

export const Hover = { parameters: { pseudo: { hover: true } } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const Disabled = { args: { disabled: true } };

export const Primary = { args: { label: 'Guardar cambios', variant: 'primary' } };

export const PrimaryHover = { name: 'Primary · hover', args: { label: 'Guardar cambios', variant: 'primary' }, parameters: { pseudo: { hover: true } } };

export const PrimaryDisabled = { name: 'Primary · disabled', args: { label: 'Guardar cambios', variant: 'primary', disabled: true } };

export const Block = { args: { label: 'Abrir pantalla pública', block: true }, render: ({ label }) => frame(html`<bingo-button lang="es" block>${label}</bingo-button>`, '18rem') };

export const LongLabel = { name: 'Long label', args: { label: 'Mover a la pantalla secundaria' } };

export const AllStates = {
  name: 'All states',
  render: () => html`<div lang="es">${stateMatrix([
    ['Normal', html`<bingo-button>Recargar eventos</bingo-button><bingo-button>Descartar cambios</bingo-button>`],
    ['Primary', html`<bingo-button variant="primary">Guardar cambios</bingo-button><bingo-button variant="primary">Sacar bola</bingo-button>`, 'One per form'],
    ['Hover', forceState('hover', html`<bingo-button>Recargar eventos</bingo-button><bingo-button variant="primary">Guardar cambios</bingo-button>`)],
    ['Focus visible', forceState('focus-visible', html`<bingo-button>Recargar eventos</bingo-button><bingo-button variant="primary">Guardar cambios</bingo-button>`), 'Keyboard focus ring'],
    ['Disabled', html`<bingo-button disabled>Descartar cambios</bingo-button><bingo-button variant="primary" disabled>Guardar cambios</bingo-button>`, 'Not focusable'],
    ['Block', frame(html`<bingo-button block>Abrir pantalla pública</bingo-button>`, '18rem'), 'Side rail'],
    ['Long label', html`<bingo-button>Mover a la pantalla secundaria</bingo-button>`],
  ])}</div>`,
};
