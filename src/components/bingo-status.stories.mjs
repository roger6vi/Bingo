import { html } from 'lit';
import './bingo-status.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';

export default {
  title: 'Components/Status',
  component: 'bingo-status',
  args: { message: 'Event ready', tone: 'info' },
  argTypes: {
    message: { control: 'text' },
    tone: {
      control: 'inline-radio', options: ['info', 'warning', 'error'],
      description: '`error` uses role="alert"; the others role="status".',
    },
  },
  render: ({ message, tone }) => html`<bingo-status .message=${message} .tone=${tone}></bingo-status>`,
};

export const Info = {};

export const Pending = { args: { message: 'Loading event state' } };

export const Stale = { args: { message: 'Event history may be stale. Reload before relying on it.', tone: 'warning' } };

export const ErrorState = { name: 'Error', args: { message: 'Could not save the draw. The last confirmed history is shown.', tone: 'error' } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Default', html`<bingo-status></bingo-status>`, 'Before any message'],
    ['Info', html`<bingo-status message="Current phase: Drawing"></bingo-status>`],
    ['Pending', html`<bingo-status message="Guardando cambios"></bingo-status>`],
    ['Warning · stale', html`<bingo-status tone="warning"
      message="La lista de eventos puede estar desactualizada. Recárgala antes de continuar."></bingo-status>`],
    ['Error', html`<bingo-status tone="error" message="Could not connect to theme settings. Try again."></bingo-status>`, 'role="alert"'],
  ]),
};
