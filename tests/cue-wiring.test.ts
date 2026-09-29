import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test('operator cues follow acknowledged snapshots with bundled sounds and never autoplay', () => {
  assert.match(read('src/operator-ui.mjs'), /cues\.observe\(state\.snapshot, \{ baseline: state\.snapshotSource !== 'draw' \}\);/);
  assert.match(read('src/cue-ui.mjs'), /sources = CUE_SOURCES/);
  const html = read('src/operator.html');
  assert.doesNotMatch(html, /\b(?:autoplay|<audio)\b/i);
  assert.match(html, /<input type="checkbox" id="cue-mute"[^>]*>/);
  assert.match(html, /<input id="cue-volume" type="range" min="0" max="100" step="5"/);
  assert.match(html, /<input type="button" id="cue-test"/);
  assert.match(html, /<bingo-status id="cue-status" hidden><\/bingo-status>/);
});

test('the public window stays visual-only, so reopening it can never duplicate a cue', () => {
  for (const file of ['src/public-ui.mjs', 'src/public.html', 'src/public-controller.mjs']) {
    assert.doesNotMatch(read(file), /cue-|\.wav\b/i, file);
  }
});
