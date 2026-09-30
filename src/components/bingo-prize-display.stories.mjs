import { html } from 'lit';
import './bingo-prize-display.mjs';
import { stateMatrix } from '../../.storybook/lib/kit.mjs';

const prize = (amount, lot = '') => ({ amount, lot });

export default {
  title: 'Components/Prize display',
  component: 'bingo-prize-display',
  args: { prizes: { line: prize(100), bingo: prize(1500, 'Cesta de productos locales') } },
  argTypes: {
    prizes: { control: 'object', description: 'Committed `{ line, bingo }` prizes (`{ amount, lot }` each), or `null`.' },
  },
  render: ({ prizes }) => html`<bingo-prize-display lang="es" style="max-width: 24rem" .prizes=${prizes}></bingo-prize-display>`,
};

export const Committed = { name: 'Committed · amount and lot' };

export const Unavailable = { name: 'Unavailable · no committed prizes', args: { prizes: null } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Unavailable', html`<bingo-prize-display lang="es"></bingo-prize-display>`, 'null'],
    ['No prize', html`<bingo-prize-display lang="es" .prizes=${{ line: prize(0), bingo: prize(0) }}></bingo-prize-display>`],
    ['Lot only', html`<bingo-prize-display lang="es" .prizes=${{ line: prize(0, 'Jamón'), bingo: prize(0, 'Cesta') }}></bingo-prize-display>`],
    ['Amount only', html`<bingo-prize-display lang="es" .prizes=${{ line: prize(50), bingo: prize(12500) }}></bingo-prize-display>`],
  ]),
};
