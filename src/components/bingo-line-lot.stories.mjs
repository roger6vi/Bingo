import { html } from 'lit';
import './bingo-line-lot.mjs';
import { frame, stateMatrix } from '../../.storybook/lib/kit.mjs';

// Presentation only: the states are controller-shaped fixtures; nothing here draws or reads a winner.
const snap = (fact, extra = {}) => ({ eventId: 'e1', auditSequence: 3, winnerCount: 6, lot: 'Cesta', presentation: { id: 'p1', status: 'completed' }, fact, ...extra });
const base = { status: 'unknown', source: null, winner: null, busy: false, canDraw: false, snapshot: null, message: null };
const pending = { origin: 'none', resolution: 'pending' };
const numbered = { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 5, colorId: 'purple' };
const states = {
  actionable: { ...base, status: 'actionable', canDraw: true, snapshot: snap(pending) },
  busy: { ...base, status: 'actionable', canDraw: true, busy: true, snapshot: snap(pending) },
  resolved: { ...base, status: 'resolved', source: 'current', winner: { kind: 'number', participantNumber: 5, colorId: 'purple' }, snapshot: snap(numbered) },
  recovery: { ...base, status: 'recovery', message: 'Estado incierto.' },
};
const panel = (state) => html`<bingo-line-lot lang="es" .state=${state}></bingo-line-lot>`;

export default {
  title: 'Components/Line lot',
  component: 'bingo-line-lot',
  args: { state: states.actionable },
  argTypes: { state: { control: 'object', description: 'Controller-shaped state. Emits payloadless `line-lot-draw` / `line-lot-resync` intents; the owner acts on them.' } },
  render: (args) => frame(panel(args.state), '10rem'),
};

export const Actionable = {};
export const Drawing = { name: 'Drawing · busy', args: { state: states.busy } };
export const Resolved = { name: 'Resolved · supplied winner', args: { state: states.resolved } };
export const Recovery = { name: 'Recovery · resync only', args: { state: states.recovery } };

export const AllStates = {
  name: 'All states',
  render: () => stateMatrix(Object.entries(states).map(([name, state]) => [name, frame(panel(state), '10rem')])),
};
