import { operatorMeta } from '../../../.storybook/lib/screens.mjs';
import { draws } from '../../../.storybook/lib/fixtures.mjs';

// src/operator.html, Bingo tab (1–90 board and side rail), with in-memory state. Tabs are live; nothing is persisted.
export default {
  title: 'Screens/Operator/Bingo',
  id: 'screens-operator-bingo',
  tags: ['!autodocs'],
  ...operatorMeta('bingo'),
};

export const MidGame = { name: 'Mid-game', args: { game: { calledNumbers: draws(34) } } };

export const Ready = { name: 'Ready · no draws' };

export const Waiting = {
  name: 'Waiting for state',
  args: { game: { loaded: false, phase: null }, events: { loaded: false, list: [], pending: 'load' } },
};

export const Digital = { name: 'Mid-game · digital mode', args: { game: { calledNumbers: draws(34), mode: 'digital' } } };

export const Pending = { name: 'Draw pending', args: { game: { calledNumbers: draws(34), pending: true, pendingNumber: draws(35).at(-1) } } };

export const CheckingLine = { name: 'Checking line', args: { game: { calledNumbers: draws(17), phase: 'checking_line' } } };

export const Stale = {
  name: 'Stale · draw failed',
  args: { game: { calledNumbers: draws(34), stale: true, error: 'Could not connect to the event. Reload and try again.' } },
};

export const Finished = { name: 'All 90 called', args: { game: { calledNumbers: draws(90), phase: 'finished' } } };

export const DisplayLost = { name: 'Display disconnected', args: { game: { calledNumbers: draws(34) }, publicWarning: true } };

export const TongoPlaying = {
  name: 'Tongo playing · live actions locked',
  args: { game: { calledNumbers: draws(34) }, tongo: { progress: 0.4 } },
};

export const TongoRefused = {
  name: 'Tongo refused · no public window',
  args: { game: { calledNumbers: draws(34) }, tongo: { error: 'Open the public window, then try Tongo again.' } },
};

export const TongoPending = {
  name: 'Tongo pending · request in flight',
  args: { game: { calledNumbers: draws(34) }, tongo: { pending: true } },
};

export const TongoAfterLine = {
  name: 'Line declared · Tongo available',
  args: { game: { calledNumbers: draws(40), phase: 'line_declared' } },
};

export const TongoBusy = {
  name: 'Tongo refused · already playing',
  args: { game: { calledNumbers: draws(34) }, tongo: { error: 'Tongo is already playing on the public window.' } },
};
