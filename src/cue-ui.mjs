// Operator sound-cue controls. Cues play once, from the operator window only, so opening or reopening
// the public window can never duplicate or replay them.
import { createCuePlayer, describeCueStatus } from './cue-player.mjs';
import { createMilestoneTracker } from './cue-registry.mjs';
import { CUE_SOURCES } from './cue-sources.mjs';

export function bindCueControls({ mute, volume, test, status }, { sources = CUE_SOURCES, createAudio, storage, schedule, cancel }) {
  const tracker = createMilestoneTracker();
  const player = createCuePlayer({ sources, createAudio, storage, schedule, cancel, onChange: (state) => {
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
    // Call with every acknowledged snapshot (or null when none is loaded) and the controller's
    // acknowledgement details; a re-read snapshot only moves the baseline.
    observe(snapshot, acknowledgement) {
      const milestone = tracker.observe(snapshot, acknowledgement);
      if (milestone !== null) void player.play(milestone);
    },
    // Wraps the operator's Tongo request so no cue overlaps the public presentation window.
    async playTongo(request) {
      player.hold();
      let result;
      try { result = await request(); }
      catch (error) { player.release(); throw error; }
      if (result?.ok === true) player.hold(result.presentation.durationMs);
      else player.release();
      return result;
    },
  };
}
