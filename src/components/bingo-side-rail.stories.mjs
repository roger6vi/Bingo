import { html } from 'lit';
import './bingo-side-rail.mjs';
import './bingo-button.mjs';
import './bingo-operator-summary.mjs';
import './bingo-call-history.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

// Sections stack and scroll inside the rail; slot="footer" stays pinned to the bottom.
const rail = ({ label, sections, height }) => html`<div lang="es" style=${`height: ${height}; width: 20rem`}>
  <bingo-side-rail style="height: 100%" .label=${label}>
    <section>
      <bingo-operator-summary .latest=${draws(21).at(-1)} .count=${21} .remaining=${69}></bingo-operator-summary>
      <bingo-call-history limit="8" .calledNumbers=${draws(21)}></bingo-call-history>
    </section>
    ${Array.from({ length: sections }, (_, index) => html`<section><bingo-button block>Acción ${index + 1}</bingo-button></section>`)}
    <section slot="footer"><bingo-button block>Abrir pantalla pública</bingo-button></section>
  </bingo-side-rail>
</div>`;

export default {
  title: 'Components/Side rail',
  component: 'bingo-side-rail',
  args: { label: 'Controles de la partida', sections: 2, height: '26rem' },
  argTypes: {
    label: { control: 'text', description: 'Accessible name of the <aside>.' },
    sections: { control: { type: 'number', min: 0, max: 20 }, description: 'Story-only: extra sections.' },
    height: { control: 'text', description: 'Story-only: container height.' },
  },
  render: rail,
};

export const Default = {};

export const Overflowing = {
  name: 'Overflowing · body scrolls, footer pinned',
  args: { sections: 12, height: '20rem' },
};
