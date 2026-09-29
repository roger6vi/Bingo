import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTemporaryProfile, defaultUserData, launchArgs, profilePrefix } from '../verification/electron-smoke.mjs';

// Importing the smoke must not launch Electron; only its profile guard is exercised here.
const withTemp = (run: (temp: string) => void) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'bingo-smoke-guard-'));
  try { run(temp); } finally { rmSync(temp, { recursive: true, force: true }); }
};

test('the real profile path follows Electron appData + package name per platform', () => {
  const env = { XDG_CONFIG_HOME: '', APPDATA: 'C:\\Users\\op\\AppData\\Roaming' };
  assert.equal(defaultUserData({ platform: 'linux', env: {}, home: '/home/op' }), '/home/op/.config/bingo-desktop-feasibility');
  assert.equal(defaultUserData({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/op' }), '/cfg/bingo-desktop-feasibility');
  assert.equal(defaultUserData({ platform: 'darwin', env, home: '/Users/op' }),
    '/Users/op/Library/Application Support/bingo-desktop-feasibility');
  assert.equal(defaultUserData({ platform: 'win32', env, home: 'C:\\Users\\op' }), path.win32.join(env.APPDATA, 'bingo-desktop-feasibility'));
});

test('a fresh smoke directory in the temp dir is accepted and passed as --user-data-dir', () => withTemp((temp) => {
  const profile = mkdtempSync(path.join(temp, profilePrefix));
  const options = { temp, realProfile: path.join(temp, 'real') };
  // The returned/used path is canonicalized (macOS /var \u2192 /private/var), even though the input is not.
  const resolvedProfile = realpathSync(profile);
  assert.equal(assertTemporaryProfile(profile, options), resolvedProfile);
  const args = launchArgs(profile, { ...options, isRoot: false });
  assert.deepEqual(args.slice(1), [`--user-data-dir=${resolvedProfile}`]);
  assert.ok(launchArgs(profile, { ...options, isRoot: true }).includes('--no-sandbox'));
}));

test('launching without a temporary profile is refused', () => withTemp((temp) => {
  const options = { temp, realProfile: path.join(temp, 'real') };
  for (const profile of [undefined, '']) {
    assert.throws(() => launchArgs(profile as unknown as string, options), /without a temporary --user-data-dir/);
  }
  assert.throws(() => launchArgs(path.join(temp, `${profilePrefix}missing`), options), /does not exist/);
  const unprefixed = path.join(temp, 'profile');
  mkdirSync(unprefixed);
  assert.throws(() => launchArgs(unprefixed, options), /is not a bingo-smoke-\* directory/);
  const nested = path.join(temp, 'nested', `${profilePrefix}x`);
  mkdirSync(nested, { recursive: true });
  assert.throws(() => launchArgs(nested, options), /is not a bingo-smoke-\* directory/);
  // Even a prefixed temp directory is refused if it is (or contains) the real profile.
  const real = mkdtempSync(path.join(temp, profilePrefix));
  assert.throws(() => launchArgs(real, { temp, realProfile: real }), /overlaps the real profile/);
  assert.throws(() => launchArgs(real, { temp, realProfile: path.join(real, 'inner') }), /overlaps the real profile/);
}));
