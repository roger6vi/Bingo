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
  ['line_declared', 'declare_bingo_directly', 'bingo_declared'],
  ['checking_bingo', 'declare_bingo', 'bingo_declared'],
  ['checking_bingo', 'reject_bingo_claim', 'line_declared'],
  ['bingo_declared', 'finish', 'finished'],
  ['bingo_declared', 'correct_bingo_declaration', 'line_declared'],
  // The post-bingo line-award reset (#112): an audited self-loop, because the schema's invariant is that every
  // audit kind is a legal transition intent from its own phase, and a reset deliberately does not move the phase.
  ['bingo_declared', 'reset_line_award', 'bingo_declared'],
];
const phases: readonly GamePhase[] = [
  'drawing', 'checking_line', 'line_declared',
  'checking_bingo', 'bingo_declared', 'finished',
];

// #32 slice 4 (S12/S16): the phase cannot reach finished on its own. A declared Bingo moves on by exactly two
// decisions, and only the explicit finish intent ends the game; from finished there is no way out at all, so the
// one-way door is structural rather than a convention the callers are trusted to respect.
test('finished is reachable only by the explicit finish intent and has no way out', () => {
  const intents: readonly PhaseTransitionIntent[] = [
    'begin_line_check', 'declare_line_directly', 'declare_line', 'reject_line_claim', 'begin_bingo_check',
    'correct_line_declaration', 'declare_bingo_directly', 'declare_bingo', 'reject_bingo_claim', 'finish',
    'correct_bingo_declaration', 'reset_line_award',
  ];
  const accepted: string[] = [];
  for (const intent of intents) {
    try { transitionPhase({ phase: 'bingo_declared' }, intent); accepted.push(intent); } catch { /* refused */ }
  }
  assert.deepEqual(accepted.sort(), ['correct_bingo_declaration', 'finish', 'reset_line_award'],
    'a declared Bingo offers exactly three decisions, and only finish ends the game');
  assert.deepEqual(transitionPhase({ phase: 'bingo_declared' }, 'finish'), { phase: 'finished' });
  for (const intent of intents) {
    assert.throws(() => transitionPhase({ phase: 'finished' }, intent), /Invalid phase transition/,
      `finished must refuse ${intent}: the door does not swing back`);
  }
});

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

test('direct bingo only leaves line_declared; legacy checking_bingo graph is retained', () => {
  for (const phase of phases) {
    const state = Object.freeze({ phase });
    if (phase === 'line_declared') continue;
    assert.throws(() => transitionPhase(state, 'declare_bingo_directly'), /invalid phase transition/i);
  }
  const legacy = transitionPhase({ phase: 'line_declared' }, 'begin_bingo_check');
  assert.deepEqual(transitionPhase(legacy, 'declare_bingo'), { phase: 'bingo_declared' });
  assert.deepEqual(transitionPhase(legacy, 'reject_bingo_claim'), { phase: 'line_declared' });
});

test('direct bingo blocks every draw and never finishes automatically', () => {
  const declared = transitionPhase({ phase: 'line_declared' }, 'declare_bingo_directly');
  assert.equal(declared.phase, 'bingo_declared');
  assert.throws(() => assertDrawAllowed(declared), /draw.*not allowed/i);
  assert.throws(() => drawManual({ calledNumbers: [], phase: declared.phase }, 1), /not allowed|phase/i);
  assert.equal(transitionPhase(declared, 'correct_bingo_declaration').phase, 'line_declared');
  assert.equal(transitionPhase(declared, 'finish').phase, 'finished');
});
