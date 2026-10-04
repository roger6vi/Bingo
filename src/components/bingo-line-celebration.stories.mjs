import { html } from 'lit';
import './bingo-line-celebration.mjs';
import './bingo-number-board.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';
import { describeLineAward } from '../public-controller.mjs';

// Facts are formatted by the public page's own pure formatter from committed-award samples; no IPC is involved.
const CASH = describeLineAward({ winnerCount: 1, shareCents: 15000, remainderCents: 0, lot: '', lotResolution: 'not_required' });
const SHARED = describeLineAward({ winnerCount: 3, shareCents: 3333, remainderCents: 1, lot: 'Cesta de Navidad', lotResolution: 'pending' });

// In the app the overlay is position: fixed over the whole public window. A transformed stage becomes its
// containing block here, so each story (and each side-by-side theme) shows it over its own board.
const stage = ({ active, facts }) => html`<div style="position: relative; transform: translateZ(0); overflow: hidden; min-height: 18rem">
  <bingo-number-board style="max-width: 32rem" .calledNumbers=${draws(21)} .loaded=${true}></bingo-number-board>
  <bingo-line-celebration lang="es" .active=${active} .facts=${facts}></bingo-line-celebration>
</div>`;

export default {
  title: 'Components/Line celebration',
  component: 'bingo-line-celebration',
  args: { active: true, facts: CASH },
  argTypes: {
    active: { control: 'boolean', description: 'Shows the overlay over the untouched board. In the app main decides when it ends; this control is a Storybook-only demo.' },
    facts: { control: 'text', description: 'Committed award description shown under «¡Línea!» and read out by the live region.' },
  },
  parameters: { docs: { description: { component: 'Transient public overlay for the first line. It only renders the committed facts it is given; timing and replay belong to the main process. Motion is dropped under `prefers-reduced-motion`.' } } },
  render: stage,
};

export const Cash = {
  name: 'Cash prize · one winner',
};

export const SharedWithLot = {
  name: 'Shared cash and pending lot',
  parameters: { docs: { description: { story: 'Three winners, an unassigned cent and a lot still to be settled, as the public page words them.' } } },
  args: { facts: SHARED },
};

export const Idle = {
  name: 'Idle · board only',
  parameters: { docs: { description: { story: 'Only the empty, visually hidden live region is rendered.' } } },
  args: { active: false },
};

export const Announces = {
  name: 'Announces once',
  parameters: { docs: { description: { story: 'The play function starts the overlay; the polite live region reads «¡Línea!» and the facts once.' } } },
  args: { active: false },
  play: async ({ canvasElement }) => {
    const element = canvasElement.querySelector('bingo-line-celebration');
    element.active = true;
    await element.updateComplete;
  },
};

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Idle', stage({ active: false, facts: CASH }), 'Board unchanged'],
    ['One winner', stage({ active: true, facts: CASH }), 'Over the same board'],
    ['Shared with lot', stage({ active: true, facts: SHARED }), 'Facts wrap inside the card'],
  ]),
};
