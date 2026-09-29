import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8').replaceAll('\r\n', '\n');
const workflow = read('.github/workflows/windows-package.yml');
const config = read('electron-builder.win.yml');
const smoke = read('verification/packaged-smoke.mjs');
const { scripts } = JSON.parse(read('package.json'));

test('Windows packaging lives in its own workflow on a least-privilege windows-latest job', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.equal((workflow.match(/^    runs-on: /gm) ?? []).length, 1);
  assert.match(workflow, /^    runs-on: windows-latest$/m);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /^    - run: git config --global core\.autocrlf false\n    - uses: actions\/checkout@v4$/m);
  assert.match(workflow, /^      run: npm ci$/m);
  assert.match(workflow, /- name: Test source\n      if: \$\{\{ !cancelled\(\) \}\}\n      run: npm test\n$/);
  assert.doesNotMatch(workflow, /\b(?:continue-on-error|npm publish|secrets\.)|--publish always/);
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /windows/i, 'ci.yml stays Ubuntu-only');
});

test('the workflow installs, upgrades and uninstalls against one temporary profile', () => {
  const order = ['Bingo-Setup-0.1.0-x64.exe', 'packaged-smoke.mjs $app $env:BINGO_DATA seed',
    'Bingo-Setup-0.1.1-x64.exe', 'packaged-smoke.mjs $app $env:BINGO_DATA upgraded',
    'windows-installed.ps1 -Uninstall', 'current-event.sqlite', 'Remove-Item -Recurse -Force'];
  const positions = order.map((text) => workflow.indexOf(text));
  assert.ok(positions.every((position, index) => position > (positions[index - 1] ?? -1)), 'steps in order');
  assert.match(workflow, /run: Add-Content \$env:GITHUB_ENV "BINGO_DATA=\$env:RUNNER_TEMP\\bingo-user-data"/);
  assert.match(workflow, /- name: Remove temporary profile\n      if: always\(\)/);
  assert.match(workflow, /path: release\/windows\/Bingo-Setup-\*\.exe\n\s+if-no-files-found: error/);
});

test('Windows config is a separate per-user NSIS x64 build that keeps user data', () => {
  assert.equal(scripts['package:win'],
    'npm run build && electron-builder --win nsis --x64 --config electron-builder.win.yml --publish never');
  assert.doesNotMatch(config, /^(?:mac|dmg|linux):/m, 'macOS packaging (#40) stays in its own config');
  assert.match(config, /^productName: Bingo$/m);
  assert.match(config, /^files:\n  # .*\n  - dist\/\*\*\/\*\n  - package\.json\n  - "!node_modules\/\*\*\/\*"$/m);
  assert.match(config, /^asar: true$/m);
  assert.match(config, /^    - target: nsis\n      arch: \[x64\]$/m);
  for (const setting of ['oneClick: true', 'perMachine: false', 'runAfterFinish: false', 'deleteAppDataOnUninstall: false']) {
    assert.match(config, new RegExp(`^  ${setting}$`, 'm'));
  }
});

test('every packaged launch uses an explicit temporary user-data directory', () => {
  const launches = smoke.match(/(?:electron\.launch\(\{ |spawn\()executablePath, [^\n]+/g) ?? [];
  assert.equal(launches.length, 2);
  for (const launch of launches) assert.match(launch, /`--user-data-dir=\$\{(?:profile|broken)\}`/);
  assert.match(smoke, /mkdtempSync\(path\.join\(tmpdir\(\), 'bingo-packaged-'\)\)/);
  assert.match(smoke, /rmSync\(profile, \{ recursive: true, force: true \}\)/);
});
