import assert from 'node:assert/strict';
import test from 'node:test';
import { drawManual } from '../src/event-core.ts';
import {
  createPhaseState, transitionPhase, assertDrawAllowed,
  type GamePhase, type PhaseTransitionIntent,
} from '../src/game-phase.ts';

const legal: readonly [GamePhase, PhaseTransitionIntent, GamePhase][] = [
  ['drawing', 'begin_line_check', 'checking_line'],
  ['drawing', 'declare_line_directly', 'line_declared'],
  ['checking_line', 'declare_line', 'line_declared'],
  ['checking_line', 'reject_line_claim', 'drawing'],
  ['line_declared', 'begin_bingo_check', 'checking_bingo'],
  ['line_declared', 'correct_line_declaration', 'drawing'],
  ['checking_bingo', 'declare_bingo', 'bingo_declared'],
  ['checking_bingo', 'reject_bingo_claim', 'line_declared'],
  ['bingo_declared', 'finish', 'finished'],
  ['bingo_declared', 'correct_bingo_declaration', 'line_declared'],
];
const phases: readonly GamePhase[] = [
  'drawing', 'checking_line', 'line_declared',
  'checking_bingo', 'bingo_declared', 'finished',
];

test('initial phase and all approved transitions return distinct immutable results', () => {
  const initial = createPhaseState();
  assert.deepEqual(initial, { phase: 'drawing' });
  for (const [from, intent, to] of legal) {
    const state = Object.freeze({ phase: from });
    const result = transitionPhase(state, intent);
    assert.deepEqual(result, { phase: to });
    assert.notEqual(result, state);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(state, { phase: from });
  }
});

test('all other intent/phase combinations reject without mutating input', () => {
  for (const phase of phases) {
    const state = Object.freeze({ phase });
    for (const [, intent, expected] of legal) {
      if (legal.some(([from, candidate]) => from === phase && candidate === intent)) continue;
      assert.throws(() => transitionPhase(state, intent), /invalid phase transition/i,
        `${phase} + ${intent} must reject (including attempts toward ${expected})`);
      assert.deepEqual(state, { phase });
    }
  }
});

test('phase guard composes with draws without dropping snapshot fields', () => {
  for (const phase of ['drawing', 'line_declared'] as const) {
    const snapshot = Object.freeze({ calledNumbers: Object.freeze([3]), phase });
    assertDrawAllowed(snapshot);
    const result = drawManual(snapshot, 4);
    assert.deepEqual(result, { calledNumbers: [3, 4], phase });
    assert.deepEqual(snapshot.calledNumbers, [3]);
  }
});

test('only drawing and line_declared permit draws without changing phase', () => {
  for (const phase of phases) {
    const state = Object.freeze({ phase });
    if (phase === 'drawing' || phase === 'line_declared') {
      assert.doesNotThrow(() => assertDrawAllowed(state));
    } else {
      assert.throws(() => assertDrawAllowed(state), /draw.*not allowed/i);
    }
    assert.deepEqual(state, { phase });
  }
});
