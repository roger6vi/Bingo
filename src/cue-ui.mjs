// Operator sound-cue controls in the Bingo rail. Cues play once, from the operator window only, so
// opening or reopening the public window can never duplicate or replay them.
import { createCuePlayer } from './cue-player.mjs';
import { createMilestoneTracker } from './cue-registry.mjs';
import { CUE_SOURCES } from './cue-sources.mjs';
import { PHASE_LABELS_ES } from './operator-copy.mjs';

export function describeCueStatusEs({ kind, milestone, preview = false }) {
  const label = PHASE_LABELS_ES[milestone];
  const cue = preview ? 'Aviso de prueba' : 'Aviso';
  if (kind === 'played') return { message: `${cue}: ${label}`, tone: 'info' };
  if (kind === 'muted') return { message: `${cue} silenciado: ${label}`, tone: 'info' };
  if (kind === 'failed') return { message: `No se pudo reproducir el aviso (${label}). La partida sigue.`, tone: 'warning' };
  return { message: 'Avisos listos. No suena nada al abrir ni al recargar.', tone: 'info' };
}

export function bindCueControls({ mute, volume, note, test, status }, { sources = CUE_SOURCES, createAudio, storage }) {
  const tracker = createMilestoneTracker();
  const player = createCuePlayer({ sources, createAudio, storage, onChange: (state) => {
    // The button names its action, and the slider's description says whether cues are muted.
    mute.textContent = state.muted ? 'Activar' : 'Silenciar';
    const percent = Math.round(state.volume * 100);
    volume.value = String(percent);
    note.textContent = state.muted ? 'Avisos silenciados' : `${percent} %`;
    Object.assign(status, describeCueStatusEs(state.status));
    // Routine cue reports stay available to assistive technology; only a warning takes visible rail space.
    status.classList.toggle('visually-hidden', status.tone !== 'warning');
  } });
  mute.addEventListener('click', () => player.setMuted(!player.settings().muted));
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
