import { html } from 'lit';
import './bingo-operator-board.mjs';
import { forceState, numberList, stateMatrix } from '../../.storybook/lib/kit.mjs';
import { draws } from '../../.storybook/lib/fixtures.mjs';

// The board sizes itself from its container, as in the Bingo tab's dominant zone.
const board = ({ calledNumbers, loaded, readonly, disabled, pending, pendingNumber, stale }, height = '26rem') => html`<div
  lang="es" style=${`height: ${height}; min-width: 0`}>
  <bingo-operator-board style="height: 100%" .calledNumbers=${calledNumbers} ?loaded=${loaded} ?readonly=${readonly}
    ?disabled=${disabled} ?pending=${pending} .pendingNumber=${pendingNumber ?? null} ?stale=${stale}></bingo-operator-board>
</div>`;

const base = { calledNumbers: draws(21), loaded: true, readonly: false, disabled: false, pending: false, pendingNumber: null, stale: false };

export default {
  title: 'Components/Operator board',
  component: 'bingo-operator-board',
  args: base,
  argTypes: {
    calledNumbers: numberList,
    loaded: { control: 'boolean', description: 'Committed state has been read; until then every cell is disabled.' },
    readonly: { control: 'boolean', description: 'Digital mode: the board shows calls but cannot call.' },
    disabled: { control: 'boolean', description: 'The operator cannot draw (e.g. an event switch in flight).' },
    pending: { control: 'boolean', description: 'A manual call is in flight; the board stays inert.' },
    pendingNumber: { control: { type: 'number', min: 1, max: 90 }, description: 'The number being called while `pending`.' },
    stale: { control: 'boolean', description: 'History may be out of date; the last committed calls stay visible.' },
    onNumberSelect: { action: 'number-select', table: { category: 'events' } },
  },
  render: (args) => html`<div @number-select=${(event) => args.onNumberSelect?.(event.detail)}>${board(args)}</div>`,
};

export const MidGame = { name: 'Manual · mid-game' };

export const Waiting = { name: 'Waiting for state', args: { calledNumbers: [], loaded: false } };

export const Empty = { name: 'Empty · no draws yet', args: { calledNumbers: [] } };

export const Hover = { parameters: { pseudo: { hover: true } } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const Pending = { name: 'Pending · call in flight', args: { pending: true, pendingNumber: 5 } };

export const Readonly = { name: 'Read-only · digital mode', args: { readonly: true } };

export const Disabled = { args: { disabled: true } };

export const Stale = { name: 'Stale history', args: { stale: true } };

export const Full = { name: 'All 90 called', args: { calledNumbers: draws(90) } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix([
    ['Waiting', board({ ...base, calledNumbers: [], loaded: false }, '16rem')],
    ['Manual', board(base, '16rem'), 'Latest outlined'],
    ['Hover', forceState('hover', board(base, '16rem'))],
    ['Pending', board({ ...base, pending: true, pendingNumber: 5 }, '16rem'), 'Dashed cell'],
    ['Read-only', board({ ...base, readonly: true }, '16rem'), 'Digital mode'],
    ['Disabled', board({ ...base, disabled: true }, '16rem')],
    ['Stale', board({ ...base, stale: true }, '16rem'), 'Dashed outline'],
  ]),
};
