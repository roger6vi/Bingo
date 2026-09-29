import { html } from 'lit';
import './bingo-call-history.mjs';
import { numberList, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

export default {
  title: 'Components/Call history',
  component: 'bingo-call-history',
  args: { calledNumbers: draws(21) },
  argTypes: { calledNumbers: numberList },
  render: ({ calledNumbers }) => html`<bingo-call-history .calledNumbers=${calledNumbers}></bingo-call-history>`,
};

export const Populated = {};

export const Empty = { name: 'Empty · no draws yet', args: { calledNumbers: [] } };

export const FirstDraw = { name: 'First draw', args: { calledNumbers: draws(1) } };

export const Full = { name: 'All 90 called', args: { calledNumbers: draws(90) } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Empty', html`<bingo-call-history></bingo-call-history>`],
    ['First draw', html`<bingo-call-history .calledNumbers=${draws(1)}></bingo-call-history>`],
    ['Populated', html`<bingo-call-history .calledNumbers=${draws(21)}></bingo-call-history>`, 'Latest outlined'],
  ]),
};
