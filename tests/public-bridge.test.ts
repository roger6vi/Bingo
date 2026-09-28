import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulatorFeed, publicBridges, SIMULATOR_MESSAGE, validEventMeta } from '../src/public-bridge.mjs';

type Listener = (message: { source: unknown; data: unknown }) => void;
function fakeWindow(parent?: object) {
  const listeners: Listener[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener) => { if (type === 'message') listeners.push(listener); },
  };
  win.parent = parent ?? win;
  return { win, dispatch: (source: unknown, data: unknown) => listeners.forEach((listener) => listener({ source, data })), listeners };
}

test('the public window uses its preload subscriptions and never listens to frame messages', () => {
  const { win, listeners } = fakeWindow();
  Object.assign(win, { publicEvent: { subscribe: () => () => {} }, publicTheme: { subscribe: () => () => {} },
    publicEventMeta: { subscribe: () => () => {} }, publicPresentation: { subscribe: () => () => {} } });
  const bridges = publicBridges(win);
  assert.deepEqual([bridges.event, bridges.theme, bridges.meta, bridges.presentation],
    [win.publicEvent, win.publicTheme, win.publicEventMeta, win.publicPresentation]);
  assert.equal(listeners.length, 0);
  assert.throws(() => publicBridges(fakeWindow().win), /Missing public display bridge/);
});

test('framed as the simulator, the page accepts only well-formed messages from its parent frame', () => {
  const parent = {};
  const { win, dispatch } = fakeWindow(parent);
  const bridges = publicBridges(win);
  const received: unknown[] = [];
  const unsubscribe = bridges.meta.subscribe((payload: unknown) => received.push(payload));
  bridges.theme.subscribe((payload: unknown) => received.push(`theme:${payload}`));
  dispatch(parent, { type: SIMULATOR_MESSAGE, channel: 'meta', payload: { name: 'N' } });
  dispatch(parent, { type: SIMULATOR_MESSAGE, channel: 'theme', payload: 'high-contrast' });
  dispatch({}, { type: SIMULATOR_MESSAGE, channel: 'meta', payload: 'other source' });
  dispatch(parent, { type: 'other', channel: 'meta', payload: 'wrong type' });
  dispatch(parent, { type: SIMULATOR_MESSAGE, channel: 'draw', payload: 'unknown channel' });
  bridges.presentation.subscribe((payload: unknown) => received.push(payload));
  dispatch(parent, { type: SIMULATOR_MESSAGE, channel: 'presentation', payload: { kind: 'tongo', id: 1, durationMs: 3000 } });
  dispatch(parent, null);
  unsubscribe();
  dispatch(parent, { type: SIMULATOR_MESSAGE, channel: 'meta', payload: 'after unsubscribe' });
  assert.deepEqual(received, [{ name: 'N' }, 'theme:high-contrast']);
});

test('the simulator feed posts cloned state in reveal order and replays it whenever the frame loads', () => {
  const posted: { data: { channel: string; payload: unknown }; target: string }[] = [];
  let onLoad = () => {};
  const frame = {
    contentWindow: { postMessage: (data: { channel: string; payload: unknown }, target: string) => posted.push({ data, target }) },
    addEventListener: (type: string, listener: () => void) => { if (type === 'load') onLoad = listener; },
  };
  const feed = createSimulatorFeed(frame);
  const meta = { name: 'Verbena', date: '2026-08-15', place: 'Plaza' };
  feed.update({ event: { ok: true, snapshot: { calledNumbers: [1], phase: 'drawing', lastTransitionAt: null } } });
  feed.update({ meta });
  meta.name = 'mutated';
  assert.deepEqual(posted.map(({ data }) => data.channel), ['event', 'meta']);
  assert.equal((posted[1].data.payload as { name: string }).name, 'Verbena');
  assert.ok(posted.every(({ data, target }) => (data as unknown as { type: string }).type === SIMULATOR_MESSAGE && target === '*'));
  posted.length = 0;
  feed.update({ theme: 'high-contrast' });
  onLoad();
  assert.deepEqual(posted.map(({ data }) => data.channel), ['theme', 'theme', 'meta', 'event']);
});

test('validEventMeta accepts only a complete committed description', () => {
  assert.equal(validEventMeta({ name: 'N', date: '2026-08-15', place: 'P' }), true);
  for (const bad of [null, 'N', { name: '', date: '2026-08-15', place: 'P' }, { name: 'N', date: '15/08/2026', place: 'P' },
    { name: 'N', date: '2026-08-15', place: 'p'.repeat(121) }, { name: 'N', date: '2026-08-15' }]) {
    assert.equal(validEventMeta(bad), false);
  }
});
