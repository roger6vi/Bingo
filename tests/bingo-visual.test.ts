// Headless interaction tests for the UI-C visual capture tool (BG-07). Virtual pages only: never Electron,
// and no screenshot is written — the page fake records the requested path. The real evidence comes from an
// authorized run; these tests pin the interaction order and that captures stay inside the artifacts dir.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import * as visual from '../verification/bingo-visual.mjs';

function fakePage(name: string, log: string[]) {
  const record = (label: string) => { log.push(`${name}:${label}`); };
  return {
    waitForFunction: async () => record('waitForFunction'),
    click: async (selector: string) => record(`click:${selector}`),
    locator: (selector: string) => ({
      count: async () => { record(`count:${selector}`); return 1; },
      click: async () => record(`click:${selector}`),
      hover: async () => record(`hover:${selector}`),
      scrollIntoViewIfNeeded: async () => record(`reveal:${selector}`),
    }),
    evaluate: async () => record('evaluate'),
    waitForTimeout: async () => record('waitForTimeout'),
    mouse: { wheel: async (_x: number, y: number) => record(`wheel:${y}`) },
    screenshot: async ({ path: file }: { path: string }) => record(`shot:${path.basename(file)}`),
  };
}

test('the capture plan names every surface the UI-C pass needs', () => {
  assert.deepEqual(visual.CAPTURES,
    ['operator-events-tab', 'operator-bingo-rail', 'operator-bingo-rail-bottom', 'public-award']);
});

test('a capture writes only inside the artifacts directory', async () => {
  const log: string[] = [];
  const dir = path.join(process.cwd(), 'verification', 'artifacts', 'test-tmp');
  const file = await visual.capture(fakePage('operator', log) as never, 'sample', dir);
  assert.equal(file, path.join(dir, 'sample.png'), 'the artifact keeps the artifacts directory and the .png suffix');
  assert.deepEqual(log, ['operator:shot:sample.png'], 'the live page is asked to screenshot exactly that file');
});

test('the steps capture each rail view in order and open the public window last', async () => {
  const log: string[] = [];
  const operator = fakePage('operator', log);
  const publicPage = fakePage('public', log);
  const app = { firstWindow: async () => operator, waitForEvent: async () => publicPage };
  const shots: string[] = [];
  await visual.visualSteps({ app } as never, { shot: (async (_page: unknown, name: string) => { shots.push(name); }) as never });
  assert.deepEqual(shots, [...visual.CAPTURES], 'every planned surface is captured, in order');
  assert.deepEqual(log, [
    'operator:waitForFunction',
    'operator:click:#tab-bingo',
    'operator:waitForFunction',
    'operator:count:#claim-tiebreak',
    'operator:reveal:#rail-claims-heading',
    'operator:hover:#claim-tiebreak',
    'operator:wheel:1200',
    'operator:waitForTimeout',
    'operator:click:#open-public button',
    'public:waitForFunction',
  ], 'the rail is revealed before its captures and the public window opens only after both rail views');
});
