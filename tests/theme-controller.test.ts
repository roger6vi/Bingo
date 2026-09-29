import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTheme, createThemeController, revealAfter } from '../src/theme-controller.mjs';

function fixture(api: { getTheme(): Promise<unknown>; setTheme(theme: string): Promise<unknown> }) {
  const renders: { theme: string | null; pending: boolean; error: string | null }[] = [];
  const controller = createThemeController(api, { render: (state: typeof renders[number]) => renders.push(state) });
  return { controller, renders, last: () => renders.at(-1) };
}

test('applies only allow-listed themes to the document root', () => {
  const root = { dataset: {} as Record<string, string> };
  for (const theme of ['jules', 'light', 'high-contrast']) assert.equal(applyTheme(root, theme), true);
  for (const value of ['dark', 'url(x)', '../x.css', null, 'constructor', 'toString', 'pixel-classic']) {
    assert.equal(applyTheme(root, value), false);
  }
  assert.equal(root.dataset.theme, 'high-contrast');
  const hidden = { dataset: {} as Record<string, string> };
  revealAfter(hidden, 10, (callback: () => void) => callback());
  assert.equal(hidden.dataset.theme, 'jules');
  revealAfter(root, 10, (callback: () => void) => callback());
  assert.equal(root.dataset.theme, 'high-contrast');
});

test('selection changes the displayed theme only after a committed acknowledgement', async () => {
  const requests: string[] = [];
  let reply: unknown = { ok: true, theme: 'high-contrast' };
  const f = fixture({
    getTheme: async () => ({ ok: true, theme: 'jules' }),
    setTheme: async (theme) => { requests.push(theme); return reply; },
  });
  assert.deepEqual(f.last(), { theme: null, pending: false, error: null });
  await f.controller.start();
  assert.deepEqual(f.last(), { theme: 'jules', pending: false, error: null });
  await f.controller.select('high-contrast');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: null });
  reply = { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' };
  await f.controller.select('jules');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: 'Could not save the theme. Try again.' });
  reply = { ok: true, theme: 'body{}' };
  await f.controller.select('jules');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: 'Invalid theme update.' });
  await f.controller.select('javascript:alert(1)');
  assert.deepEqual(requests, ['high-contrast', 'jules', 'jules']);
});

test('connection failure keeps the last committed theme', async () => {
  const f = fixture({ getTheme: async () => { throw new Error('gone'); }, setTheme: async () => ({}) });
  await f.controller.start();
  assert.deepEqual(f.last(), { theme: null, pending: false, error: 'Could not connect to theme settings. Try again.' });
});

function manualTimer() {
  let fire = () => {};
  return { schedule: (callback: () => void) => { fire = callback; }, fire: () => fire() };
}

test('public window: a committed theme arriving after the fallback replaces the default', () => {
  const root = { dataset: {} as Record<string, string> };
  const timer = manualTimer();
  revealAfter(root, 2000, timer.schedule);
  timer.fire();
  assert.equal(root.dataset.theme, 'jules');
  applyTheme(root, 'high-contrast');
  assert.equal(root.dataset.theme, 'high-contrast');
});

test('operator window: a never-settling getTheme reveals the default without reporting it saved', async () => {
  const root = { dataset: {} as Record<string, string> };
  const states: { theme: string | null; pending: boolean; error: string | null }[] = [];
  let settle: (value: unknown) => void = () => {};
  const controller = createThemeController(
    { getTheme: () => new Promise((resolve) => { settle = resolve; }), setTheme: async () => ({}) },
    { render: (state: typeof states[number]) => { states.push(state); if (state.theme !== null) applyTheme(root, state.theme); } },
  );
  const started = controller.start();
  const timer = manualTimer();
  revealAfter(root, 2000, timer.schedule);
  timer.fire();
  assert.equal(root.dataset.theme, 'jules');
  assert.deepEqual(states.at(-1), { theme: null, pending: true, error: null });
  settle({ ok: true, theme: 'high-contrast' });
  await started;
  assert.equal(root.dataset.theme, 'high-contrast');
  assert.deepEqual(states.at(-1), { theme: 'high-contrast', pending: false, error: null });
});

test('start() during a pending save queues a fresh read instead of being dropped', async () => {
  let resolveSave: (value: unknown) => void = () => {};
  let reads = 0;
  const f = fixture({
    getTheme: async () => { reads += 1; return { ok: true, theme: reads === 1 ? 'jules' : 'high-contrast' }; },
    setTheme: () => new Promise((resolve) => { resolveSave = resolve; }),
  });
  await f.controller.start();
  const saving = f.controller.select('high-contrast');
  const reread = f.controller.start();
  resolveSave({ ok: true, theme: 'high-contrast' });
  await saving;
  await reread;
  assert.equal(reads, 2);
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: null });
});
