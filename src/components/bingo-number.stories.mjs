import { html } from 'lit';
import './bingo-number.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';

export default {
  title: 'Components/Number',
  component: 'bingo-number',
  args: { value: 42, compact: false, latest: false, emptyLabel: 'Waiting for draw' },
  argTypes: {
    value: { control: { type: 'number', min: 1, max: 90 }, description: 'Drawn number; `null` shows the empty label.' },
    compact: { control: 'boolean', description: 'Body-size number used in lists and boards.' },
    latest: { control: 'boolean', description: 'Latest-call colours (public display).' },
    emptyLabel: { control: 'text', description: 'Text shown while `value` is `null`.' },
  },
  render: ({ value, compact, latest, emptyLabel }) => html`<bingo-number .value=${value ?? null} .compact=${compact}
    ?latest=${latest} .emptyLabel=${emptyLabel}></bingo-number>`,
};

export const Drawn = {};

export const Latest = { args: { value: 13, latest: true } };

export const Compact = { args: { value: 7, compact: true } };

export const Waiting = { name: 'Empty · waiting for state', args: { value: null } };

export const NoDraws = { name: 'Empty · no draws yet', args: { value: null, emptyLabel: 'No draws yet' } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Drawn', html`<bingo-number .value=${1}></bingo-number><bingo-number .value=${42}></bingo-number>
      <bingo-number .value=${90}></bingo-number>`, 'Display size'],
    ['Latest', html`<bingo-number .value=${13} latest></bingo-number>`, 'Public display'],
    ['Compact', html`${[1, 7, 42, 88, 90].map((value) => html`<bingo-number .value=${value} compact></bingo-number>`)}`, 'Lists and boards'],
    ['Waiting', html`<bingo-number></bingo-number>`, 'Before state loads'],
    ['No draws', html`<bingo-number emptyLabel="No draws yet"></bingo-number>`, 'Loaded, empty'],
  ]),
};
