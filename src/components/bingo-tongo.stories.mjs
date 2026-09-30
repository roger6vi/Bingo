import { html } from 'lit';
import './bingo-tongo.mjs';
import './bingo-number-board.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

// In the app the overlay is position: fixed over the whole public window. A transformed stage becomes its
// containing block here, so each story (and each side-by-side theme) shows it over its own board.
const stage = ({ active }) => html`<div style="position: relative; transform: translateZ(0); overflow: hidden; min-height: 18rem">
  <bingo-number-board style="max-width: 32rem" .calledNumbers=${draws(21)} .loaded=${true}></bingo-number-board>
  <bingo-tongo lang="es" .active=${active}></bingo-tongo>
</div>`;

export default {
  title: 'Components/Tongo overlay',
  component: 'bingo-tongo',
  args: { active: true },
  argTypes: {
    active: { control: 'boolean', description: 'Shows the overlay; the board underneath is never touched. Main clears it after the acknowledged duration (~3 s).' },
  },
  parameters: { docs: { description: { component: 'Transient public overlay after a claim rejected outside the app. Motion is dropped under `prefers-reduced-motion`.' } } },
  render: stage,
};

export const Playing = {};

export const Idle = {
  name: 'Idle · board only',
  parameters: { docs: { description: { story: 'Only the empty, visually hidden live region is rendered.' } } },
  args: { active: false },
};

export const Announces = {
  name: 'Announces once',
  parameters: { docs: { description: { story: 'The play function starts the overlay; the polite live region reads it once.' } } },
  args: { active: false },
  play: async ({ canvasElement }) => {
    const element = canvasElement.querySelector('bingo-tongo');
    element.active = true;
    await element.updateComplete;
  },
};

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Idle', stage({ active: false }), 'Board unchanged'],
    ['Playing', stage({ active: true }), 'Over the same board'],
  ]),
};
