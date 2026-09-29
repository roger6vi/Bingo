// Operator sound-cue controls. Cues play once, from the operator window only, so opening or reopening
// the public window can never duplicate or replay them.
import { createCuePlayer, describeCueStatus } from './cue-player.mjs';
import { createMilestoneTracker } from './cue-registry.mjs';
import { CUE_SOURCES } from './cue-sources.mjs';

export function bindCueControls({ mute, volume, test, status }, { sources = CUE_SOURCES, createAudio, storage }) {
  const tracker = createMilestoneTracker();
  const player = createCuePlayer({ sources, createAudio, storage, onChange: (state) => {
    mute.checked = state.muted;
    volume.value = String(Math.round(state.volume * 100));
    volume.setAttribute('aria-valuetext', `${Math.round(state.volume * 100)}%`);
    Object.assign(status, describeCueStatus(state.status));
    // Idle costs no rail space; any real cue, test, or mute report reveals the line.
    status.hidden = state.status.kind === 'idle';
  } });
  mute.addEventListener('change', () => player.setMuted(mute.checked));
  volume.addEventListener('input', () => player.setVolume(Number(volume.value) / 100));
  // An explicit operator request, so the level can be checked before the event starts.
  test.addEventListener('click', () => { void player.play('line_declared', { preview: true }); });
  return {
    // Call with every acknowledged snapshot (or null when none is loaded).
    observe(snapshot) {
      const milestone = tracker.observe(snapshot);
      if (milestone !== null) void player.play(milestone);
    },
  };
}
