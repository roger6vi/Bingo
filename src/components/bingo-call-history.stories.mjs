import { html } from 'lit';
import './bingo-call-history.mjs';
import { frame, numberList, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

export default {
  title: 'Components/Call history',
  component: 'bingo-call-history',
  args: { calledNumbers: draws(21), limit: 0 },
  argTypes: {
    calledNumbers: numberList,
    limit: { control: { type: 'number', min: 0, max: 90 }, description: '`> 0` shows only the last calls as a compact strip (side rail).' },
  },
  render: ({ calledNumbers, limit }) => html`<bingo-call-history lang="es" .calledNumbers=${calledNumbers}
    .limit=${limit}></bingo-call-history>`,
};

export const Populated = {};

export const Empty = { name: 'Empty · no draws yet', args: { calledNumbers: [] } };

export const FirstDraw = { name: 'First draw', args: { calledNumbers: draws(1) } };

export const Full = { name: 'All 90 called', args: { calledNumbers: draws(90) } };

export const Strip = {
  name: 'Strip · last 8 (side rail)',
  args: { limit: 8 },
  render: ({ calledNumbers, limit }) => frame(html`<bingo-call-history lang="es" .calledNumbers=${calledNumbers}
    .limit=${limit}></bingo-call-history>`, '18rem'),
};

export const AllStates = {
  name: 'All states',
  render: () => html`<div lang="es">${stateMatrix([
    ['Empty', html`<bingo-call-history></bingo-call-history>`],
    ['First draw', html`<bingo-call-history .calledNumbers=${draws(1)}></bingo-call-history>`],
    ['Populated', html`<bingo-call-history .calledNumbers=${draws(21)}></bingo-call-history>`, 'Latest outlined'],
    ['Strip', frame(html`<bingo-call-history limit="8" .calledNumbers=${draws(21)}></bingo-call-history>`, '18rem'), 'Last 8, latest highlighted'],
  ])}</div>`,
};
