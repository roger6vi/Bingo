import assert from 'node:assert/strict';
import test from 'node:test';
import { planOperatorWindow, planPublicWindow } from '../src/window-plan.ts';

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
const secondary = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };

test('selects a secondary display for fullscreen public output', () => {
  assert.deepEqual(planPublicWindow([primary, secondary], primary.id), {
    displayId: 2,
    bounds: secondary.bounds,
    fullscreen: true,
  });
});

test('centers a windowed preview on the primary display when alone', () => {
  assert.deepEqual(planPublicWindow([primary], primary.id), {
    displayId: 1,
    bounds: { x: 240, y: 180, width: 960, height: 540 },
    fullscreen: false,
  });
});

test('keeps a preview inside a small primary display with an offset origin', () => {
  const small = { id: 3, bounds: { x: -800, y: 40, width: 800, height: 500 } };
  assert.deepEqual(planPublicWindow([small], small.id), {
    displayId: 3,
    bounds: small.bounds,
    fullscreen: false,
  });
});

test('preview uses the primary work area instead of covering menu or dock', () => {
  const display = { ...primary, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
  assert.deepEqual(planPublicWindow([display], display.id).bounds, {
    x: 240, y: 192, width: 960, height: 540,
  });
});

test('clamps the operator to the primary work area, including offset and small displays', () => {
  assert.deepEqual(planOperatorWindow({ x: -800, y: 45, width: 800, height: 500 }), {
    x: -800, y: 45, width: 800, height: 500,
  });
  assert.deepEqual(planOperatorWindow({ x: 0, y: 25, width: 1440, height: 875 }), {
    x: 0, y: 25, width: 1024, height: 720,
  });
});

test('rejects a missing primary display instead of choosing an arbitrary screen', () => {
  assert.throws(() => planPublicWindow([secondary], primary.id), /Primary display is missing/);
});
