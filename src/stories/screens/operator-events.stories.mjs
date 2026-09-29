import { operatorMeta } from '../../../.storybook/lib/screens.mjs';
import { EVENTS } from '../../../.storybook/lib/fixtures.mjs';

// src/operator.html, Eventos tab, with in-memory state. Tabs are live; nothing is persisted.
export default {
  title: 'Screens/Operator/Eventos',
  id: 'screens-operator-events',
  tags: ['!autodocs'],
  ...operatorMeta('events'),
};

export const Populated = {};

export const FirstRun = { name: 'Empty · first run', args: { events: { list: [] } } };

export const Activating = { name: 'Pending · activating', args: { events: { pending: 'select' } } };

export const Stale = {
  name: 'Stale · activation failed',
  args: {
    events: { list: EVENTS.map((event) => ({ ...event, active: false })), stale: true,
      error: 'No se pudo activar el evento. Inténtalo de nuevo.' },
  },
};

export const NotLoaded = {
  name: 'Error · not loaded',
  args: { events: { list: [], loaded: false, error: 'No se pudo conectar con los eventos.' } },
};
