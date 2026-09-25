import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSampleState } from '../src/sample-state.ts';

type FileIO = Parameters<typeof createSampleState>[1];

function memoryFiles() {
  const files = new Map<string, string>();
  const io: FileIO = {
    readFileSync: (file) => {
      const value = files.get(file);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    writeFileSync: (file, value) => { files.set(file, value); },
    renameSync: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error('missing temporary file');
      files.set(to, value);
      files.delete(from);
    },
    unlinkSync: (file) => { files.delete(file); },
  };
  return { files, io };
}

const file = '/userData/sample-state.json';

test('sample count recovers from disk in a fresh Node process', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-sample-state-'));
  try {
    const stateFile = join(directory, 'sample-state.json');
    assert.equal(createSampleState(stateFile, fs).increment().count, 1);

    const child = `
      import * as fs from 'node:fs';
      const { createSampleState } = await import(process.argv[2]);
      const store = createSampleState(process.argv[1], fs);
      process.stdout.write(JSON.stringify({ restored: store.read().count, updated: store.increment().count }));
    `;
    const output = execFileSync(process.execPath, [
      '--input-type=module', '--eval', child, stateFile,
      new URL('../src/sample-state.ts', import.meta.url).href,
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { restored: 1, updated: 2 });
    assert.equal(createSampleState(stateFile, fs).read().count, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing state defaults to zero; changing it survives a new store instance', () => {
  const { files, io } = memoryFiles();
  const first = createSampleState(file, io);
  assert.equal(first.read().count, 0);
  assert.equal(first.increment().count, 1);
  assert.equal(files.has(file), true);
  assert.equal(createSampleState(file, io).read().count, 1);
  assert.equal(createSampleState(file, io).increment().count, 2);
});

test('corrupt or unsupported files recover to a safe default instead of crashing', () => {
  const { files, io } = memoryFiles();
  for (const bad of ['{', '{"count":-1}', '{"count":"3"}', '{"count":1.5}', '{"count":1,"version":9}']) {
    files.set(file, bad);
    assert.equal(createSampleState(file, io).read().count, 0);
  }
  assert.equal(createSampleState(file, io).increment().count, 1);
});

test('failed rename leaves previous state intact and removes only its temporary file', () => {
  const { files, io } = memoryFiles();
  files.set(file, '{"version":1,"count":4}');
  assert.throws(() => createSampleState(file, { ...io, renameSync: () => { throw new Error('rename denied'); } }).increment(), /rename denied/);
  assert.deepEqual([...files.entries()], [[file, '{"version":1,"count":4}']]);
});

test('read errors other than a missing file and failed writes are surfaced', () => {
  const { io } = memoryFiles();
  assert.throws(() => createSampleState(file, { ...io, readFileSync: () => { throw new Error('permission denied'); } }).read(), /permission denied/);
  assert.throws(() => createSampleState(file, { ...io, writeFileSync: () => { throw new Error('disk full'); } }).increment(), /disk full/);
});
