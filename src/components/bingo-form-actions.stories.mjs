import { html } from 'lit';
import './bingo-form-actions.mjs';
import './bingo-button.mjs';
import './bingo-status.mjs';
import { frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

const actions = ({ state, dirty, pending, sticky }) => html`<bingo-form-actions lang="es" ?pending=${pending} ?sticky=${sticky}>
  <bingo-status slot="status" .message=${state} .tone=${dirty && !pending ? 'warning' : 'info'}></bingo-status>
  <bingo-button ?disabled=${!dirty || pending}>Descartar cambios</bingo-button>
  <bingo-button slot="primary" variant="primary" ?disabled=${!dirty || pending}>Guardar cambios</bingo-button>
</bingo-form-actions>`;

const clean = { state: 'Sin cambios pendientes.', dirty: false, pending: false, sticky: false };
const dirty = { ...clean, state: 'Cambios sin guardar: solo se ven en el simulador.', dirty: true };
const saving = { ...clean, state: 'Guardando cambios', dirty: true, pending: true };

export default {
  title: 'Components/Form actions',
  component: 'bingo-form-actions',
  args: dirty,
  argTypes: {
    state: { control: 'text', description: 'Slotted status (slot="status").' },
    dirty: { control: 'boolean', description: 'Story-only: enables Save and Discard.' },
    pending: { control: 'boolean', description: 'Marks the row busy (aria-busy) while saving.' },
    sticky: { control: 'boolean', description: 'Stays visible at the bottom of a scrolling form.' },
  },
  render: (args) => frame(actions(args), '28rem'),
};

export const Dirty = { name: 'Dirty · unsaved changes' };

export const Clean = { name: 'Clean · nothing to save', args: clean };

export const Pending = { name: 'Pending · saving', args: saving };

export const Sticky = {
  name: 'Sticky · in a scrolling form',
  render: (args) => html`<div lang="es" style="max-width: 28rem; height: 14rem; overflow: auto">
    ${Array.from({ length: 10 }, (_, index) => html`<p>Campo ${index + 1}</p>`)}
    ${actions({ ...args, sticky: true })}
  </div>`,
};

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Clean', frame(actions(clean), '28rem'), 'Both disabled'],
    ['Dirty', frame(actions(dirty), '28rem'), 'Warning status'],
    ['Pending', frame(actions(saving), '28rem'), 'Busy indicator'],
  ]),
};
