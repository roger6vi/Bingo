import { publicDefaults, publicScreen } from '../../../.storybook/lib/screens.mjs';
import { ACTIVE_EVENT, LONG_EVENT, draws } from '../../../.storybook/lib/fixtures.mjs';

// src/public.html with in-memory state. The operator's Configuración simulator frames these stories.
export default {
  title: 'Screens/Public display',
  tags: ['!autodocs'],
  parameters: { layout: 'fullscreen', sideBySide: false },
  args: publicDefaults,
  argTypes: {
    meta: { control: 'object', description: 'Committed event `{ name, date, place }`, or `null` for the generic heading.' },
    calledNumbers: { control: 'object', description: 'Committed draw order.' },
    phase: { control: 'select', options: [null, 'drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished'] },
    loaded: { control: 'boolean' },
    stale: { control: 'boolean' },
    error: { control: 'text' },
    tongo: { control: 'boolean', description: 'Transient Tongo overlay over the unchanged board (~3 s in the app).' },
  },
  render: (args) => publicScreen(args),
};

export const MidGame = { name: 'Mid-game', args: { calledNumbers: draws(34) } };

export const Waiting = { name: 'Waiting for state', args: { meta: null, loaded: false, phase: null } };

export const NoDraws = { name: 'Ready · no draws yet' };

export const CheckingLine = { name: 'Checking line', args: { calledNumbers: draws(17), phase: 'checking_line' } };

export const Finished = { name: 'All 90 called', args: { calledNumbers: draws(90), phase: 'finished' } };

export const Stale = {
  name: 'Stale · delivery failed',
  args: { calledNumbers: draws(34), stale: true, error: 'Could not receive the latest event update.' },
};

export const LongEventName = { name: 'Long event name', args: { meta: LONG_EVENT, calledNumbers: draws(52) } };

export const DraftPreview = {
  name: 'Draft preview (simulator)',
  args: { meta: { ...ACTIVE_EVENT, name: 'Bingo solidario de otoño', place: 'Parroquia de San Miguel' }, calledNumbers: draws(34) },
};

export const Tongo = { name: 'Tongo · invalid claim', args: { calledNumbers: draws(34), tongo: true } };
