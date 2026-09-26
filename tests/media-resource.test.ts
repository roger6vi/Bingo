import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('public page keeps manual playback and imports local media via Vite URL', () => {
  const html = readFileSync(path.join(root, 'src/public.html'), 'utf8');
  const entry = readFileSync(path.join(root, 'src/public-ui.mjs'), 'utf8');
  assert.match(html, /<video\b[^>]*\bcontrols\b[^>]*preload="none"/i);
  assert.doesNotMatch(html, /\bautoplay\b/i);
  assert.match(html, /<source\b[^>]*id="sample-video-source"[^>]*type="video\/mp4"/i);
  assert.match(entry, /import sampleVideoUrl from '\.\.\/assets\/sample\.mp4\?url';/);
  assert.match(entry, /sampleSource\.src = sampleVideoUrl/);
  assert.ok(statSync(path.join(root, 'assets/sample.mp4')).size > 0);
});
