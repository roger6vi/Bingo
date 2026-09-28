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
  assert.equal(applyTheme(root, 'high-contrast'), true);
  for (const value of ['dark', 'url(x)', '../x.css', null, 'constructor', 'toString']) {
    assert.equal(applyTheme(root, value), false);
  }
  assert.equal(root.dataset.theme, 'high-contrast');
  const hidden = { dataset: {} as Record<string, string> };
  revealAfter(hidden, 10, (callback: () => void) => callback());
  assert.equal(hidden.dataset.theme, 'pixel-classic');
  revealAfter(root, 10, (callback: () => void) => callback());
  assert.equal(root.dataset.theme, 'high-contrast');
});

test('selection changes the displayed theme only after a committed acknowledgement', async () => {
  const requests: string[] = [];
  let reply: unknown = { ok: true, theme: 'high-contrast' };
  const f = fixture({
    getTheme: async () => ({ ok: true, theme: 'pixel-classic' }),
    setTheme: async (theme) => { requests.push(theme); return reply; },
  });
  assert.deepEqual(f.last(), { theme: null, pending: false, error: null });
  await f.controller.start();
  assert.deepEqual(f.last(), { theme: 'pixel-classic', pending: false, error: null });
  await f.controller.select('high-contrast');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: null });
  reply = { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' };
  await f.controller.select('pixel-classic');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: 'Could not save the theme. Try again.' });
  reply = { ok: true, theme: 'body{}' };
  await f.controller.select('pixel-classic');
  assert.deepEqual(f.last(), { theme: 'high-contrast', pending: false, error: 'Invalid theme update.' });
  await f.controller.select('javascript:alert(1)');
  assert.deepEqual(requests, ['high-contrast', 'pixel-classic', 'pixel-classic']);
});

test('connection failure keeps the last committed theme', async () => {
  const f = fixture({ getTheme: async () => { throw new Error('gone'); }, setTheme: async () => ({}) });
  await f.controller.start();
  assert.deepEqual(f.last(), { theme: null, pending: false, error: 'Could not connect to theme settings. Try again.' });
});
