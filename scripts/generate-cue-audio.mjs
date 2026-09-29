// Regenerates the bundled cue sounds in assets/cues/. The tones are synthesized here, so the WAV files
// are original project assets with no third-party licence. Run: node scripts/generate-cue-audio.mjs
// The generation logic is also exported so tests can recompute the exact bytes in memory and compare
// them against the committed assets, without writing anything to disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RATE = 22050;
const AMPLITUDE = 0.3;
// Each cue is a short sequence of [frequency Hz, seconds] notes.
export const CUES = {
  line: [[660, 0.16], [880, 0.24]],
  bingo: [[523, 0.14], [659, 0.14], [784, 0.14], [1047, 0.36]],
  final: [[784, 0.2], [659, 0.2], [523, 0.5]],
};

export function wav(notes) {
  const samples = [];
  for (const [frequency, seconds] of notes) {
    const length = Math.round(seconds * RATE);
    const fade = Math.round(0.01 * RATE);
    for (let index = 0; index < length; index++) {
      const envelope = Math.min(1, index / fade, (length - index) / fade);
      samples.push(Math.round(AMPLITUDE * envelope * Math.sin(2 * Math.PI * frequency * index / RATE) * 32767));
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Recomputes every cue's WAV bytes in memory; deterministic given fixed CUES/RATE/AMPLITUDE.
export function generateCueBuffers() {
  return Object.fromEntries(Object.entries(CUES).map(([name, notes]) => [name, wav(notes)]));
}

// Only write to disk when this file runs as the CLI entrypoint, never when imported by tests, so
// importing this module for its pure functions leaves no generated repository mutations.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const directory = path.resolve(import.meta.dirname, '../assets/cues');
  mkdirSync(directory, { recursive: true });
  for (const [name, buffer] of Object.entries(generateCueBuffers())) writeFileSync(path.join(directory, `${name}.wav`), buffer);
}
