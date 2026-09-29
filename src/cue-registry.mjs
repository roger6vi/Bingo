// Audio cues keyed by committed milestone names. A cue follows only an acknowledged snapshot that
// newly enters its milestone; it never replaces or hides anything the windows display.
export const CUE_REGISTRY = Object.freeze({
  line_declared: Object.freeze({ id: 'line', label: 'Line declared', wired: true }),
  bingo_declared: Object.freeze({ id: 'bingo', label: 'Bingo declared', wired: true }),
  finished: Object.freeze({ id: 'final', label: 'Game finished', wired: true }),
  // Tongo has no committed state yet. Wire it (and add its sound) once snapshots can carry it.
  tongo_declared: Object.freeze({ id: 'tongo', label: 'Tongo declared', wired: false }),
});

export function wiredCue(milestone) {
  const cue = Object.hasOwn(CUE_REGISTRY, milestone) ? CUE_REGISTRY[milestone] : null;
  return cue?.wired ? cue : null;
}

// The first snapshot after startup, a reload, or an event switch is only a baseline, so a milestone
// that was already committed never replays. Pass null when no snapshot is loaded.
export function createMilestoneTracker() {
  let baseline = null;
  return {
    observe(snapshot) {
      if (snapshot === null) {
        baseline = null;
        return null;
      }
      const previous = baseline;
      baseline = { phase: snapshot.phase, lastTransitionAt: snapshot.lastTransitionAt };
      if (previous === null || snapshot.lastTransitionAt === previous.lastTransitionAt) return null;
      return wiredCue(snapshot.phase) ? snapshot.phase : null;
    },
  };
}
