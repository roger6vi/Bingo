import { html } from 'lit';
import './bingo-operator-summary.mjs';
import { frame, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

const summary = (count) => html`<bingo-operator-summary lang="es" .latest=${count ? draws(count).at(-1) : null}
  .count=${count} .remaining=${90 - count}></bingo-operator-summary>`;

export default {
  title: 'Components/Operator summary',
  component: 'bingo-operator-summary',
  args: { latest: draws(21).at(-1), count: 21, remaining: 69 },
  argTypes: {
    latest: { control: { type: 'number', min: 1, max: 90 }, description: 'Last confirmed call, or `null`.' },
    count: { control: { type: 'number', min: 0, max: 90 } },
    remaining: { control: { type: 'number', min: 0, max: 90 } },
  },
  // Sized like the Bingo tab's side rail, where it sits above the last-calls strip.
  render: ({ latest, count, remaining }) => frame(html`<bingo-operator-summary lang="es" .latest=${latest ?? null} .count=${count}
    .remaining=${remaining}></bingo-operator-summary>`, '18rem'),
};

export const MidGame = { name: 'Populated · mid-game' };

export const NoDraws = { name: 'Empty · no draws yet', args: { latest: null, count: 0, remaining: 90 } };

export const Finished = { name: 'All 90 called', args: { latest: draws(90).at(-1), count: 90, remaining: 0 } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['No draws', summary(0)],
    ['Mid-game', summary(21)],
    ['Finished', summary(90)],
  ]),
};
