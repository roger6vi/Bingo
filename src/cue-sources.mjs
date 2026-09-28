// Bundled cue sounds. Vite emits each file beside the page and rewrites these URLs in the build.
export const CUE_SOURCES = Object.freeze({
  line: new URL('../assets/cues/line.wav', import.meta.url).href,
  bingo: new URL('../assets/cues/bingo.wav', import.meta.url).href,
  final: new URL('../assets/cues/final.wav', import.meta.url).href,
});
