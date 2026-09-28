import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(path.resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');

// Inspect the small workflow by YAML indentation rather than matching a whole file snapshot.
const section = (source: string, key: string, indent = 0) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:`);
  assert.notEqual(start, -1, `missing ${key} section`);
  const end = lines.findIndex((line, index) => index > start && line.trim() && !line.startsWith(' '.repeat(indent + 1)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};

const steps = (source: string) => source.split(/(?=^    - )/m).filter((part) => part.startsWith('    - '));

test('PRs targeting main and pushes to main trigger CI', () => {
  const triggers = section(workflow, 'on');
  for (const event of ['pull_request', 'push']) {
    assert.match(triggers, new RegExp(`^  ${event}:\\n    branches: \\[main\\]$`, 'm'));
  }
});

test('one least-privilege Ubuntu job installs locked dependencies on Node 24', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  const jobs = section(workflow, 'jobs');
  assert.equal((jobs.match(/^  [\w-]+:$/gm) ?? []).length, 1, 'one job avoids generated CSS races');
  assert.match(jobs, /^    runs-on: ubuntu-latest$/m);
  const install = steps(jobs);
  assert.ok(install.some((step) => /^    - uses: actions\/checkout@v4$/m.test(step)));
  assert.ok(install.some((step) => /uses: actions\/setup-node@v4/.test(step) && /node-version: ['"]?24['"]?/.test(step) && /cache: npm/.test(step)));
  assert.ok(install.some((step) => /^      run: npm ci$/m.test(step)));
});

test('Linux browser dependencies precede the five sequential checks', () => {
  const jobSteps = steps(section(workflow, 'jobs'));
  const commands = jobSteps.flatMap((step) => [...step.matchAll(/^      run: (.+)$/gm)].map((match) => match[1]));
  const checks = ['npm test', 'npm run test:tokens', 'npm run build', 'npm run test:build', 'npm run test:components'];
  assert.deepEqual(commands.slice(-checks.length), checks);
  for (const check of checks) assert.equal(commands.filter((command) => command === check).length, 1, `${check} runs once`);
  assert.doesNotMatch(workflow, /\b(?:continue-on-error|windows-latest|npm publish)\b/);
  assert.ok(commands.indexOf('npm ci') < commands.indexOf(checks[0]));
  assert.ok(commands.some((command) => /playwright install-deps chromium/.test(command) && commands.indexOf(command) < commands.indexOf(checks[0])), 'install Linux Chromium libraries before checks; component script installs the browser');
});
