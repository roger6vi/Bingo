import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
const builder = JSON.parse(read('electron-builder.json'));
const { scripts } = JSON.parse(read('package.json'));
const workflow = read('.github/workflows/macos-package.yml');

test('package contains only the built app, inside an asar', () => {
  assert.deepEqual(builder.files, ['package.json', 'dist/**/*', '!dist/**/*.map', '!node_modules/**/*']);
  assert.equal(builder.asar, true);
  assert.equal(builder.directories.output, 'release');
  assert.match(read('.gitignore'), /^release\/$/m);
});

test('packaged app name fixes the user-data directory to "Bingo"', () => {
  assert.equal(builder.productName, 'Bingo');
  assert.deepEqual(builder.extraMetadata, { productName: 'Bingo' });
  assert.equal(builder.appId, 'com.roger6vi.bingo');
});

test('macOS builds dmg and zip for both architectures with a hardened runtime', () => {
  const { mac } = builder;
  assert.deepEqual(mac.target, ['dmg', 'zip'].map((target) => ({ target, arch: ['arm64', 'x64'] })));
  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.notarize, true);
  assert.equal(mac.minimumSystemVersion, '12.0');
  assert.equal(mac.identity, undefined, 'signing identity comes from the signed script environment');
});

test('packaging scripts build first; unsigned is ad-hoc, signed refuses to skip signing', () => {
  for (const name of ['package:dir', 'package:mac', 'package:mac:signed']) {
    assert.match(scripts[name], /^npm run build && electron-builder .*--publish never/);
  }
  assert.match(scripts['package:mac'], /--mac .*-c\.mac\.identity=- -c\.mac\.notarize=false$/);
  assert.match(scripts['package:mac:signed'], /--mac .*-c\.forceCodeSigning=true$/);
  assert.doesNotMatch(scripts['package:mac:signed'], /identity|notarize=false/);
  assert.equal(scripts['test:package'], 'node verification/packaged-smoke.mjs');
});

test('macOS workflow packages unsigned, smokes the package, and uploads it without secrets', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, /runs-on: macos-15/);
  const steps = ['npm ci', 'npm test', 'npm run package:mac', 'npm run test:build', 'codesign --verify',
    'npm run test:package', 'actions/upload-artifact'].map((step) => workflow.indexOf(step));
  assert.ok(steps.every((index, i) => index > 0 && (i === 0 || index > steps[i - 1])), 'steps in order');
  assert.match(workflow, /run: npm run package:mac\n {6}env:\n(?: {8}#.*\n)* {8}CSC_FOR_PULL_REQUEST: 'true'\n/);
  assert.doesNotMatch(workflow, /secrets\.|CSC_(?!FOR_PULL_REQUEST)|APPLE_/);
});
