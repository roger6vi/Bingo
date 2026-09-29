import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test('operator cues follow acknowledged snapshots with bundled sounds and never autoplay', () => {
  assert.match(read('src/operator-ui.mjs'), /cues\.observe\(state\.snapshot\)/);
  assert.match(read('src/cue-ui.mjs'), /sources = CUE_SOURCES/);
  const html = read('src/operator.html');
  assert.doesNotMatch(html, /\b(?:autoplay|<audio)\b/i);
  // The rail's volume slider now drives the cues and is enabled; mute and test are shared buttons.
  assert.match(html, /<label for="public-volume" class="visually-hidden">Volumen de avisos<\/label>/);
  assert.match(html, /<bingo-button id="cue-mute">Silenciar<\/bingo-button>\s*<input id="public-volume" type="range" min="0" max="100" step="5" value="60" aria-describedby="volume-note">\s*<bingo-button id="cue-test">Probar<\/bingo-button>/);
});

test('the public window stays visual-only, so reopening it can never duplicate a cue', () => {
  for (const file of ['src/public-ui.mjs', 'src/public.html', 'src/public-controller.mjs']) {
    assert.doesNotMatch(read(file), /cue-|\.wav\b/i, file);
  }
});
