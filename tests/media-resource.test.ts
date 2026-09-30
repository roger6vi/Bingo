import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// The sample clip is a development asset, not event state: the public display no longer plays it, so
// the audience page can neither load nor autoplay media while the offline asset stays available.
test('public page ships no sample media and keeps the offline sample asset out of its entry', () => {
  const html = readFileSync(path.join(root, 'src/public.html'), 'utf8');
  const entry = readFileSync(path.join(root, 'src/public-ui.mjs'), 'utf8');
  assert.doesNotMatch(html, /<video\b|<source\b|\bautoplay\b/i);
  assert.doesNotMatch(entry, /sample\.mp4|sampleVideoUrl|sample-video-source/);
  assert.ok(statSync(path.join(root, 'assets/sample.mp4')).size > 0);
});
