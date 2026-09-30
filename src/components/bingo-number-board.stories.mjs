import { html } from 'lit';
import './bingo-number-board.mjs';
import { numberList, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

export default {
  title: 'Components/Number board',
  component: 'bingo-number-board',
  args: { calledNumbers: draws(34), loaded: true },
  argTypes: {
    calledNumbers: numberList,
    loaded: { control: 'boolean', description: 'Distinguishes "Waiting for draw" from "No draws yet".' },
  },
  render: ({ calledNumbers, loaded }) => html`<bingo-number-board style="max-width: 32rem" .calledNumbers=${calledNumbers}
    .loaded=${loaded}></bingo-number-board>`,
};

export const MidGame = { name: 'Populated · mid-game' };

export const Waiting = { name: 'Waiting for state', args: { calledNumbers: [], loaded: false } };

export const Empty = { name: 'Empty · no draws yet', args: { calledNumbers: [] } };

export const FirstDraw = { name: 'First draw', args: { calledNumbers: draws(1) } };

export const NonSequential = { name: 'Non-sequential calls', args: { calledNumbers: [90, 3, 47, 1, 62] } };

export const Full = { name: 'All 90 called', args: { calledNumbers: draws(90) } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Waiting', html`<bingo-number-board></bingo-number-board>`],
    ['Empty', html`<bingo-number-board loaded></bingo-number-board>`],
    ['First draw', html`<bingo-number-board loaded .calledNumbers=${draws(1)}></bingo-number-board>`],
    ['Mid-game', html`<bingo-number-board loaded .calledNumbers=${draws(34)}></bingo-number-board>`, '34 called'],
    ['Full', html`<bingo-number-board loaded .calledNumbers=${draws(90)}></bingo-number-board>`, '90 called'],
  ]),
};
