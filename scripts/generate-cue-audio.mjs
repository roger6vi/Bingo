// Regenerates the bundled cue sounds in assets/cues/. The tones are synthesized here, so the WAV files
// are original project assets with no third-party licence. Run: node scripts/generate-cue-audio.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RATE = 22050;
const AMPLITUDE = 0.3;
// Each cue is a short sequence of [frequency Hz, seconds] notes.
const CUES = {
  line: [[660, 0.16], [880, 0.24]],
  bingo: [[523, 0.14], [659, 0.14], [784, 0.14], [1047, 0.36]],
  final: [[784, 0.2], [659, 0.2], [523, 0.5]],
};

function wav(notes) {
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

const directory = path.resolve(import.meta.dirname, '../assets/cues');
mkdirSync(directory, { recursive: true });
for (const [name, notes] of Object.entries(CUES)) writeFileSync(path.join(directory, `${name}.wav`), wav(notes));
