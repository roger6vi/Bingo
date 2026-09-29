import { html } from 'lit';
import './bingo-event-list.mjs';
import { forceState, frame, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { EVENTS, LONG_EVENT } from '../../.storybook/lib/fixtures.mjs';

const list = ({ events, loaded, disabled }) => html`<bingo-event-list lang="es" .events=${events} .loaded=${loaded}
  .disabled=${disabled}></bingo-event-list>`;

export default {
  title: 'Components/Event list',
  component: 'bingo-event-list',
  args: { events: EVENTS, loaded: true, disabled: false },
  argTypes: {
    events: { control: 'object', description: '`{ id, name, date, place, active }[]`; the active one is marked.' },
    loaded: { control: 'boolean', description: 'The empty state is only claimed after a committed read.' },
    disabled: { control: 'boolean', description: 'Blocks selection while a request is pending.' },
    onEventSelect: { action: 'event-select', table: { category: 'events' } },
  },
  render: (args) => frame(html`<div @event-select=${(event) => args.onEventSelect?.(event.detail)}>${list(args)}</div>`, '48rem'),
};

export const Populated = {};

export const NotLoaded = { name: 'Not loaded', args: { events: [], loaded: false } };

export const Empty = { name: 'Empty · no events', args: { events: [] } };

export const Pending = { name: 'Pending · activating', args: { disabled: true } };

export const LongContent = { name: 'Long names', args: { events: [LONG_EVENT, ...EVENTS.slice(1).map((event) => ({ ...event, active: false }))] } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Not loaded', list({ events: [], loaded: false, disabled: false })],
    ['Empty', list({ events: [], loaded: true, disabled: false })],
    ['Populated', list({ events: EVENTS.slice(0, 2), loaded: true, disabled: false })],
    ['Hover', forceState('hover', list({ events: EVENTS.slice(0, 2), loaded: true, disabled: false }))],
    ['Pending', list({ events: EVENTS.slice(0, 2), loaded: true, disabled: true }), 'Selection locked'],
  ]),
};
