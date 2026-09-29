import { operatorMeta } from '../../../.storybook/lib/screens.mjs';
import { EVENTS, LONG_EVENT } from '../../../.storybook/lib/fixtures.mjs';

// src/operator.html, Eventos tab, with in-memory state. Controller messages are shown through operatorMessage(). Tabs are live; nothing is persisted.
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
      error: 'The event was selected, but the list could not be read. Reload the events.' },
  },
};

export const NotLoaded = {
  name: 'Error · not loaded',
  args: { events: { list: [], loaded: false, error: 'Could not connect to the events. Reload and try again.' } },
};

export const Creating = { name: 'Pending · creating', args: { events: { pending: 'create' } } };

export const LongNames = {
  name: 'Long event name',
  args: { events: { list: [LONG_EVENT, ...EVENTS.slice(1).map((event) => ({ ...event, active: false }))] } },
};
