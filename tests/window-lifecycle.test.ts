import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowLifecycle } from '../src/window-lifecycle.ts';
import { planPublicWindow } from '../src/window-plan.ts';
import { createPublicWindowMover } from '../src/window-placement.ts';

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const secondary = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } };

test('starts operator-only; opening and closing public does not end the operator lifecycle', () => {
  let displays = [primary, secondary];
  const created: object[] = [];
  const lifecycle = createWindowLifecycle({
    displays: () => displays, primaryId: () => primary.id, planPublic: planPublicWindow,
    createPublic: () => { const window = {}; created.push(window); return window; },
    movePublic: () => { throw new Error('unexpected move'); },
    notify: () => {},
  });
  assert.equal(created.length, 0);
  const first = lifecycle.openPublic();
  assert.equal(lifecycle.openPublic(), first);
  lifecycle.publicClosed(first);
  displays = [primary];
  assert.notEqual(lifecycle.openPublic(), first);
  assert.equal(created.length, 2);
  assert.equal(lifecycle.moveToSecondary(), false);
});

test('disconnect relocates the same window into preview and suggests pausing, without automatic return', () => {
  let displays = [primary, secondary];
  const moves: Array<{ window: object; fullscreen: boolean; displayId: number }> = [];
  const statuses: boolean[] = [];
  const window = {};
  const lifecycle = createWindowLifecycle({
    displays: () => displays, primaryId: () => primary.id, planPublic: planPublicWindow,
    createPublic: () => window,
    movePublic: (target, plan) => moves.push({ window: target, fullscreen: plan.fullscreen, displayId: plan.displayId }),
    notify: (pauseSuggested) => statuses.push(pauseSuggested),
  });
  lifecycle.openPublic();
  displays = [primary];
  lifecycle.displaysChanged();
  assert.deepEqual(moves, [{ window, fullscreen: false, displayId: primary.id }]);
  assert.deepEqual(statuses, [false, true]);
  displays = [primary, secondary];
  lifecycle.displaysChanged();
  assert.equal(moves.length, 1);
  lifecycle.moveToSecondary();
  assert.deepEqual(moves[1], { window, fullscreen: true, displayId: secondary.id });
  assert.deepEqual(statuses, [false, true, false]);
});

test('display metrics update the selected display bounds without changing placement or pause status', () => {
  let displays = [primary, secondary];
  const moves: Array<{ bounds: object; fullscreen: boolean }> = [];
  const statuses: boolean[] = [];
  const lifecycle = createWindowLifecycle({
    displays: () => displays, primaryId: () => primary.id, planPublic: planPublicWindow,
    createPublic: () => ({}),
    movePublic: (_window, plan) => moves.push({ bounds: plan.bounds, fullscreen: plan.fullscreen }),
    notify: (pauseSuggested) => statuses.push(pauseSuggested),
  });
  lifecycle.openPublic();
  const resized = { ...secondary, bounds: { x: 1440, y: 0, width: 1280, height: 720 } };
  displays = [primary, resized];
  lifecycle.displaysChanged();
  assert.deepEqual(moves, [{ bounds: resized.bounds, fullscreen: true }]);
  assert.deepEqual(statuses, [false]);
  lifecycle.displaysChanged();
  assert.equal(moves.length, 1);
});

test('primary work-area metrics refresh an existing preview without suggesting pause', () => {
  let displays = [primary];
  const moves: object[] = [];
  const statuses: boolean[] = [];
  const lifecycle = createWindowLifecycle({
    displays: () => displays, primaryId: () => primary.id, planPublic: planPublicWindow,
    createPublic: () => ({}), movePublic: (_window, plan) => moves.push(plan),
    notify: (pauseSuggested) => statuses.push(pauseSuggested),
  });
  lifecycle.openPublic();
  displays = [{ ...primary, workArea: { x: 0, y: 50, width: 800, height: 600 } }, secondary];
  lifecycle.displaysChanged();
  assert.deepEqual(moves, [planPublicWindow([displays[0]], primary.id)]);
  assert.deepEqual(statuses, [false]);
});

test('late fullscreen exit applies the latest secondary request, not the obsolete preview', () => {
  const bounds: object[] = [];
  const fullscreen: boolean[] = [];
  let currentFullscreen = true;
  let leave: (() => void) | undefined;
  const window = {
    isDestroyed: () => false,
    isFullScreen: () => currentFullscreen,
    once: (_event: 'leave-full-screen', callback: () => void) => { leave = callback; },
    setFullScreen: (value: boolean) => { fullscreen.push(value); },
    setBounds: (value: object) => { bounds.push(value); },
    focus: () => {},
  };
  const move = createPublicWindowMover();
  const preview = planPublicWindow([primary], primary.id);
  const secondaryPlan = planPublicWindow([primary, secondary], primary.id);
  move(window, preview);
  move(window, secondaryPlan);
  currentFullscreen = false;
  assert.ok(leave);
  leave();
  assert.deepEqual(bounds, [secondaryPlan.bounds]);
  assert.deepEqual(fullscreen, [false, true]);
});

test('multiple preview requests during fullscreen exit apply only the newest bounds', () => {
  const bounds: object[] = [];
  let leave: (() => void) | undefined;
  const window = {
    isDestroyed: () => false, isFullScreen: () => true,
    once: (_event: 'leave-full-screen', callback: () => void) => { leave = callback; },
    setFullScreen: (_value: boolean) => {}, setBounds: (value: object) => { bounds.push(value); },
    focus: () => {},
  };
  const move = createPublicWindowMover();
  move(window, planPublicWindow([primary], primary.id));
  const updated = planPublicWindow([{ ...primary, workArea: { x: 0, y: 0, width: 800, height: 600 } }], primary.id);
  move(window, updated);
  assert.ok(leave);
  leave();
  assert.deepEqual(bounds, [updated.bounds]);
});

test('closing after disconnect clears active reference and does not resurrect a public window', () => {
  let displays = [primary, secondary];
  let created = 0;
  const lifecycle = createWindowLifecycle({
    displays: () => displays, primaryId: () => primary.id, planPublic: planPublicWindow,
    createPublic: () => ({ id: ++created }), movePublic: () => {}, notify: () => {},
  });
  const first = lifecycle.openPublic();
  lifecycle.publicClosed(first);
  displays = [primary];
  lifecycle.displaysChanged();
  assert.equal(created, 1);
  assert.equal(lifecycle.moveToSecondary(), false);
});
