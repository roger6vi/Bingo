import { operatorMeta } from '../../../.storybook/lib/screens.mjs';
import { draws } from '../../../.storybook/lib/fixtures.mjs';

// src/operator.html, Bingo tab, with in-memory state. Tabs are live; nothing is persisted.
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

export const Pending = { name: 'Draw pending', args: { game: { calledNumbers: draws(34), pending: true } } };

export const Stale = {
  name: 'Stale · draw failed',
  args: { game: { calledNumbers: draws(34), stale: true, error: 'Could not connect to the event. Reload and try again.' } },
};

export const Finished = { name: 'All 90 called', args: { game: { calledNumbers: draws(90), phase: 'finished' } } };

export const DisplayLost = { name: 'Display disconnected', args: { game: { calledNumbers: draws(34) }, publicWarning: true } };
