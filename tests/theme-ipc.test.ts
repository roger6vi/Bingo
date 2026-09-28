import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { registerThemeIpc, THEME_CHANNELS } from '../src/theme-ipc.ts';
import type { ThemeId } from '../src/theme.ts';

type Handler = (event: { sender: object; senderFrame: object | null }, ...args: unknown[]) => unknown;

function fixture(initial: ThemeId | 'unreadable' = 'high-contrast') {
  const sender = {}, frame = { url: 'file:///app/operator.html' };
  const handlers = new Map<string, Handler>();
  const notified: ThemeId[] = [];
  let stored = initial;
  let failSave = false;
  const store = {
    load(): ThemeId {
      if (stored === 'unreadable') throw new Error('secret read detail');
      return stored;
    },
    save(theme: ThemeId): ThemeId {
      if (failSave) throw new Error('secret write detail');
      stored = theme;
      return theme;
    },
  };
  const theme = registerThemeIpc({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
    store, createOperatorGuard(sender, () => frame, frame.url), (committed) => notified.push(committed));
  const invoke = (channel: string, args: unknown[] = [], from: object = sender, fromFrame: object | null = frame) =>
    handlers.get(channel)!({ sender: from, senderFrame: fromFrame }, ...args);
  return { theme, invoke, notified, stored: () => stored, failSave: () => { failSave = true; } };
}

const invalid = { ok: false, code: 'invalid_request', message: 'Invalid theme request.' };

test('get returns the committed theme; unreadable storage falls back to the default without writing', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(THEME_CHANNELS.get), { ok: true, theme: 'high-contrast' });
  assert.deepEqual(f.invoke(THEME_CHANNELS.get, ['extra']), invalid);
  const broken = fixture('unreadable');
  assert.deepEqual(broken.invoke(THEME_CHANNELS.get), { ok: true, theme: 'pixel-classic' });
  assert.equal(broken.stored(), 'unreadable');
});

test('set acknowledges and publishes only committed allow-listed themes', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(THEME_CHANNELS.set, ['pixel-classic']), { ok: true, theme: 'pixel-classic' });
  assert.deepEqual(f.notified, ['pixel-classic']);
  assert.equal(f.theme.current(), 'pixel-classic');
  for (const args of [[], ['dark'], ['body{}'], ['file:///tmp/x.css'], ['pixel-classic', 'x'], [{}]]) {
    assert.deepEqual(f.invoke(THEME_CHANNELS.set, args), invalid);
  }
  assert.deepEqual(f.notified, ['pixel-classic']);
  assert.equal(f.stored(), 'pixel-classic');
});

test('write failure preserves the last committed theme and does not publish', () => {
  const f = fixture();
  f.failSave();
  const result = f.invoke(THEME_CHANNELS.set, ['pixel-classic']);
  assert.deepEqual(result, { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(f.notified, []);
  assert.deepEqual(f.invoke(THEME_CHANNELS.get), { ok: true, theme: 'high-contrast' });
});

test('only the operator main frame at its page URL may read or set the theme', () => {
  const f = fixture();
  assert.throws(() => f.invoke(THEME_CHANNELS.set, ['pixel-classic'], {}), /Unauthorized/);
  assert.throws(() => f.invoke(THEME_CHANNELS.get, [], undefined, {}), /Unauthorized/);
  assert.throws(() => f.invoke(THEME_CHANNELS.set, ['pixel-classic'], undefined, null), /Unauthorized/);
  assert.equal(f.stored(), 'high-contrast');
});
