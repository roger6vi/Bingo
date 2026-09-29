// Plays milestone cues from bundled local files at the operator's mute/volume setting. The setting is
// a local preference, not event state. A missing or failing file is reported and never blocks the game.
import { wiredCue } from './cue-registry.mjs';

export const CUE_SETTINGS_KEY = 'bingo.cueAudio';
export const DEFAULT_CUE_SETTINGS = Object.freeze({ muted: false, volume: 0.6 });

const validVolume = (volume) => typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 1;

export function readCueSettings(storage) {
  try {
    const value = JSON.parse(storage.getItem(CUE_SETTINGS_KEY) ?? 'null');
    if (value !== null && typeof value === 'object' && typeof value.muted === 'boolean' && validVolume(value.volume)) {
      return { muted: value.muted, volume: value.volume };
    }
  } catch { /* Unreadable storage or JSON falls back to the defaults. */ }
  return { ...DEFAULT_CUE_SETTINGS };
}

export function describeCueStatus({ kind, milestone, preview = false }) {
  const label = wiredCue(milestone)?.label;
  const cue = preview ? 'Test cue' : 'Cue';
  if (kind === 'played') return { message: `${cue} played: ${label}`, tone: 'info' };
  if (kind === 'muted') return { message: `${cue} muted: ${label}`, tone: 'info' };
  if (kind === 'failed') return { message: `${cue} sound unavailable (${label}). The game continues.`, tone: 'warning' };
  if (kind === 'held') return { message: `${cue} waits for Tongo to finish: ${label}`, tone: 'info' };
  return { message: 'Sound cues ready. Nothing plays at startup or on reload.', tone: 'info' };
}

export function createCuePlayer({ sources, createAudio, storage, onChange, schedule = setTimeout, cancel = clearTimeout }) {
  let settings = readCueSettings(storage);
  let status = { kind: 'idle', milestone: null };
  let current = null;
  // Only the latest request may report; stopping also retires any pending play().
  let sequence = 0;
  // While the public Tongo presentation runs, no cue sounds: the latest request waits for it to end.
  let holding = false;
  let holdTimer = null;
  let deferred = null;

  const emit = () => onChange({ ...settings, status: { ...status } });
  function save() {
    try { storage.setItem(CUE_SETTINGS_KEY, JSON.stringify(settings)); }
    catch { /* The setting still applies for this session. */ }
  }
  function stop() {
    sequence++;
    const audio = current;
    current = null;
    try { audio?.pause(); } catch { /* Already unusable. */ }
  }

  async function play(milestone, { preview = false } = {}) {
    const cue = wiredCue(milestone);
    if (cue === null) return;
    stop();
    if (holding) {
      deferred = { milestone, preview };
      status = { kind: 'held', milestone, preview };
      emit();
      return;
    }
    const mine = sequence;
    if (settings.muted || settings.volume === 0) {
      status = { kind: 'muted', milestone, preview };
      emit();
      return;
    }
    let audio = null;
    try {
      if (typeof sources[cue.id] !== 'string') throw new Error(`No sound for cue ${cue.id}`);
      audio = createAudio(sources[cue.id]);
      current = audio;
      audio.volume = settings.volume;
      await audio.play();
      if (mine !== sequence) return;
      status = { kind: 'played', milestone, preview };
    } catch {
      if (mine !== sequence) return;
      if (current === audio) current = null;
      status = { kind: 'failed', milestone, preview };
    }
    emit();
  }

  function update(next) {
    settings = next;
    if (settings.muted) stop();
    else if (current !== null) current.volume = settings.volume;
    save();
    emit();
  }

  function release() {
    if (holdTimer !== null) cancel(holdTimer);
    holdTimer = null;
    if (!holding) return;
    holding = false;
    const next = deferred;
    deferred = null;
    if (next !== null) void play(next.milestone, { preview: next.preview });
  }

  // Tongo coordination. `hold()` silences the current cue as soon as a Tongo request starts; pass the
  // confirmed duration to keep the hold for exactly the presentation window, or call `release()` if
  // the request failed. The one most recent cue requested meanwhile plays once the window closes.
  function hold(durationMs) {
    if (!holding) stop();
    holding = true;
    if (holdTimer !== null) cancel(holdTimer);
    holdTimer = null;
    if (Number.isFinite(durationMs) && durationMs >= 0) holdTimer = schedule(release, durationMs);
  }

  emit();
  return {
    play,
    stop,
    hold,
    release,
    holding: () => holding,
    settings: () => ({ ...settings }),
    setMuted(muted) { if (typeof muted === 'boolean') update({ ...settings, muted }); },
    setVolume(volume) { if (validVolume(volume)) update({ ...settings, volume }); },
  };
}
