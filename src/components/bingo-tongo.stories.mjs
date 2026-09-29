import { html } from 'lit';
import './bingo-tongo.mjs';
import './bingo-number-board.mjs';

// The overlay is fixed to the viewport over the public board, so docs render each story in its own frame.
export default {
  title: 'Components/Tongo',
  component: 'bingo-tongo',
  args: { active: true },
  argTypes: {
    active: { control: 'boolean', description: 'Shows the overlay; the live region announces it once when it appears.' },
  },
  parameters: { sideBySide: false, docs: { story: { inline: false, height: '28rem' } } },
  render: ({ active }) => html`<bingo-number-board loaded .calledNumbers=${[7, 23, 42, 68, 90]}></bingo-number-board>
    <bingo-tongo lang="es" ?active=${active}></bingo-tongo>`,
};

export const Playing = { name: 'Playing over the board' };

export const Idle = { name: 'Idle · board unchanged', args: { active: false } };
