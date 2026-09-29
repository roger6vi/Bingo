import assert from 'node:assert/strict';
import test from 'node:test';
import { CUE_REGISTRY, createMilestoneTracker, wiredCue } from '../src/cue-registry.mjs';
import { GAME_PHASES } from '../src/game-phase.ts';

const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
const snap = (phase: string, lastTransitionAt: string | null) => ({ calledNumbers: [1], phase, lastTransitionAt });

test('wired cues are keyed by committed phases; Tongo stays a documented, unwired entry', () => {
  for (const milestone of ['line_declared', 'bingo_declared', 'finished']) {
    assert.ok((GAME_PHASES as readonly string[]).includes(milestone), milestone);
    assert.equal(wiredCue(milestone), CUE_REGISTRY[milestone]);
  }
  assert.equal(CUE_REGISTRY.tongo_declared.wired, false);
  for (const milestone of ['tongo_declared', 'drawing', 'checking_line', 'toString', '__proto__']) {
    assert.equal(wiredCue(milestone), null, milestone);
  }
  assert.ok(Object.isFrozen(CUE_REGISTRY) && Object.isFrozen(CUE_REGISTRY.line_declared));
});

test('the first snapshot is a baseline, so a committed milestone never replays on startup or reload', () => {
  const tracker = createMilestoneTracker();
  assert.equal(tracker.observe(snap('line_declared', at(1))), null);
  assert.equal(tracker.observe(snap('line_declared', at(1))), null, 'repeated renders of one snapshot');
  assert.equal(tracker.observe(null), null);
  assert.equal(tracker.observe(snap('bingo_declared', at(2))), null, 'new baseline after an event switch');
});

test('each newly committed milestone transition cues once', () => {
  const tracker = createMilestoneTracker();
  assert.equal(tracker.observe(snap('drawing', null)), null);
  assert.equal(tracker.observe(snap('checking_line', at(1))), null);
  assert.equal(tracker.observe(snap('line_declared', at(2))), 'line_declared');
  assert.equal(tracker.observe(snap('line_declared', at(2))), null);
  assert.equal(tracker.observe(snap('checking_bingo', at(3))), null);
  assert.equal(tracker.observe(snap('bingo_declared', at(4))), 'bingo_declared');
  assert.equal(tracker.observe(snap('finished', at(5))), 'finished');
});

test('a corrected and re-declared line cues again only with a new committed transition', () => {
  const tracker = createMilestoneTracker();
  tracker.observe(snap('line_declared', at(1)));
  assert.equal(tracker.observe(snap('drawing', at(2))), null);
  assert.equal(tracker.observe(snap('line_declared', at(3))), 'line_declared');
});

test('a read snapshot is only a baseline, so an externally committed milestone never plays on reload', () => {
  const tracker = createMilestoneTracker();
  tracker.observe(snap('drawing', null));
  assert.equal(tracker.observe(snap('line_declared', at(2)), { baseline: true }), null);
  assert.equal(tracker.observe(snap('line_declared', at(2))), null, 'the read milestone is now the baseline');
  assert.equal(tracker.observe(snap('bingo_declared', at(4))), 'bingo_declared', 'later acknowledged transitions still cue');
});
