import { html } from 'lit';
import './bingo-dialog.mjs';
import './bingo-button.mjs';

const UNSAVED_ACTIONS = [
  { action: 'cancel', label: 'Cancelar', signal: 'dismiss' },
  { action: 'discard', label: 'Descartar cambios', signal: 'discard' },
  { action: 'save', label: 'Guardar cambios', signal: 'save' },
];

// The dialog is modal (top layer), so docs render each story in its own frame and a story opens it
// on load; "Closed" shows the trigger flow instead.
export default {
  title: 'Components/Dialog',
  component: 'bingo-dialog',
  args: {
    label: 'Hay cambios sin guardar',
    body: 'La configuración del evento tiene cambios sin guardar. ¿Qué quieres hacer con ellos?',
    actions: UNSAVED_ACTIONS,
  },
  argTypes: {
    label: { control: 'text', description: 'Dialog heading (accessible name).' },
    body: { control: 'text', description: 'Slotted content.' },
    actions: { control: 'object', description: '`{ action, label, signal }[]`; each button dispatches its signal.' },
  },
  parameters: { sideBySide: false, docs: { story: { inline: false, height: '22rem' } } },
  render: ({ label, body, actions }) => html`<bingo-dialog lang="es" .label=${label} .actions=${actions}><p>${body}</p></bingo-dialog>`,
  play: async ({ canvasElement }) => {
    await canvasElement.querySelector('bingo-dialog').show();
  },
};

export const UnsavedChanges = { name: 'Open · unsaved changes' };

export const Confirm = {
  name: 'Open · default actions',
  args: {
    label: 'Draw number 42?', body: 'The number will be committed to the event history.',
    actions: [{ action: 'cancel', label: 'Cancel', signal: 'dismiss' }, { action: 'confirm', label: 'Confirm', signal: 'confirm' }],
  },
  render: ({ label, body, actions }) => html`<bingo-dialog .label=${label} .actions=${actions}><p>${body}</p></bingo-dialog>`,
};

export const Closed = {
  name: 'Closed · open from a trigger',
  play: undefined,
  render: ({ label, body, actions }) => html`<bingo-button lang="es" @click=${(event) =>
    event.currentTarget.nextElementSibling.show()}>Salir de Configuración</bingo-button>
    <bingo-dialog lang="es" .label=${label} .actions=${actions}><p>${body}</p></bingo-dialog>`,
};
