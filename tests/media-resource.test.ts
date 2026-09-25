import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('public page has opt-in controls and a source-tree relative local MP4', () => {
  const html = readFileSync(path.join(root, 'src/public.html'), 'utf8');
  assert.match(html, /<video\b[^>]*\bcontrols\b[^>]*>/i);
  assert.doesNotMatch(html, /\bautoplay\b/i);
  const source = html.match(/<source\b[^>]*src="([^"]+)"[^>]*type="video\/mp4"/i);
  assert.ok(source, 'MP4 source with explicit MIME type');
  assert.equal(source[1], '../assets/sample.mp4');
  assert.ok(statSync(path.resolve(root, 'src', source[1])).size > 0);
});
