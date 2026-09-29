import { html } from 'lit';
import './bingo-latest-draw.mjs';
import './bingo-number.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

// The public page slots its large <bingo-number> into the announcer, which only adds a polite,
// visually hidden "Latest draw: n" announcement when a new number is committed.
const latestDraw = ({ latest, loaded }) => html`<bingo-latest-draw .latest=${latest} .loaded=${loaded}>
  <bingo-number .value=${latest} .emptyLabel=${loaded ? 'No draws yet' : 'Waiting for draw'}></bingo-number>
</bingo-latest-draw>`;

export default {
  title: 'Components/Latest draw',
  component: 'bingo-latest-draw',
  args: { latest: draws(18).at(-1), loaded: true },
  argTypes: {
    latest: { control: { type: 'number', min: 1, max: 90 }, description: 'Latest committed number, or `null`.' },
    loaded: { control: 'boolean', description: 'Whether committed event state has been read.' },
  },
  render: latestDraw,
};

export const Latest = {};

export const Waiting = { name: 'Waiting for state', args: { latest: null, loaded: false } };

export const NoDraws = { name: 'Empty · no draws yet', args: { latest: null, loaded: true } };

export const Announces = {
  name: 'Announces a new draw',
  parameters: { docs: { description: { story: 'The play function commits a new number; the live region reads it once.' } } },
  args: { latest: draws(3).at(-1) },
  play: async ({ canvasElement }) => {
    const element = canvasElement.querySelector('bingo-latest-draw');
    const next = draws(4).at(-1);
    element.latest = next;
    element.querySelector('bingo-number').value = next;
    await element.updateComplete;
  },
};

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Waiting', latestDraw({ latest: null, loaded: false }), 'Before state loads'],
    ['No draws', latestDraw({ latest: null, loaded: true })],
    ['Latest', latestDraw({ latest: 90, loaded: true }), 'Display size'],
  ]),
};
