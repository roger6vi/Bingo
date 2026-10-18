import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadPreload(result: Promise<unknown> = Promise.resolve({ canonicalId: 'award-30' })) {
  const calls: Array<{ operation: string; channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let bridge: any;
  const sandbox = {
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            assert.equal(name, 'desktop');
            assert.equal(bridge, undefined);
            bridge = value;
          },
        },
        ipcRenderer: {
          invoke(channel: string, ...args: unknown[]) {
            calls.push({ operation: 'invoke', channel, args });
            return result;
          },
          send(channel: string, ...args: unknown[]) {
            calls.push({ operation: 'send', channel, args });
          },
          on(channel: string, listener: (...args: unknown[]) => void) {
            calls.push({ operation: 'on', channel, args: [listener] });
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)!.add(listener);
          },
          removeListener(channel: string, listener: (...args: unknown[]) => void) {
            calls.push({ operation: 'removeListener', channel, args: [listener] });
            listeners.get(channel)?.delete(listener);
          },
        },
      };
    },
    exports: {},
  };
  const source = readFileSync(new URL('../src/preload.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(compiled.outputText, context, { filename: 'preload.cjs' });
  assert.ok(bridge);
  assert.deepEqual(calls, [], 'loading preload must not invoke, send, or subscribe');
  return {
    bridge, calls, listeners, result, context,
    emit(channel: string, event: unknown, award: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(event, award);
    },
  };
}

const cases: Array<[string, string, unknown[]]> = [
  ['beginBingoSetup', 'bingo:begin', []],
  ['readBingoSetup', 'bingo:read', []],
  ['cancelBingoSetup', 'bingo:cancel', ['session-30', 'event-canonical']],
  ['confirmBingo', 'bingo:confirm', ['session-30', 3]],
  ['readLegacyBingoCheck', 'bingo:legacy-check:read', []],
  ['cancelLegacyBingoCheck', 'bingo:legacy-check:cancel', ['event-canonical', 17, '2026-02-03T04:05:06Z']],
  ['retryBingoPresentation', 'bingo:retry-presentation', ['award-canonical']],
  ['repeatBingoPresentation', 'bingo:repeat-presentation', ['award-canonical']],
  ['readBingoLot', 'bingo:lot:read', []],
  ['drawBingoLot', 'bingo:lot:draw', [{ eventId: 'event-canonical', auditSequence: 9, presentationId: 'award-canonical' }]],
  ['presentBingoLot', 'bingo:lot:present', [{ eventId: 'event-canonical', auditSequence: 9, winnerCount: 5, lot: 'Hamper',
    presentation: { id: 'award-canonical', status: 'completed' },
    fact: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 3, colorId: 'blue' } }]],
];

for (const [method, channel, args] of cases) {
  test(`${method} forwards exact arguments and returns the invoke promise unchanged`, async () => {
    const { bridge, calls, result } = loadPreload();
    assert.equal(typeof bridge[method], 'function', `${method} must exist`);
    assert.equal(bridge[method](...args), result);
    assert.deepEqual(calls, [{ operation: 'invoke', channel, args }]);
    await result;
    assert.equal(calls.length, 1, 'no automatic retry or follow-up read');
  });
}

test('a rejected Bingo invoke promise is returned unchanged without retry', async () => {
  const failure = new Error('main rejected Bingo confirmation');
  const rejected = Promise.reject(failure);
  const { bridge, calls } = loadPreload(rejected);
  const returned = bridge.confirmBingo('session-30', 2);
  assert.equal(returned, rejected);
  await assert.rejects(returned, (error) => error === failure);
  assert.deepEqual(calls, [{ operation: 'invoke', channel: 'bingo:confirm', args: ['session-30', 2] }]);
});

test('the actual exposed bridge is frozen, including Bingo properties', () => {
  const { bridge, context } = loadPreload();
  assert.equal(Object.isFrozen(bridge), true);
  for (const [method] of cases) {
    const descriptor = Object.getOwnPropertyDescriptor(bridge, method);
    assert.ok(descriptor, `${method} must exist on the frozen bridge`);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
  }
  Object.assign(context, { desktop: bridge });
  assert.throws(() => vm.runInContext("'use strict'; desktop.beginBingoSetup = null;", context),
    (error: any) => error.name === 'TypeError');
});

test('Bingo subscriptions forward only the unchanged award and clean up independently', () => {
  const { bridge, calls, listeners, emit } = loadPreload();
  assert.equal(typeof bridge.onBingoPresentation, 'function');
  const first: unknown[][] = [];
  const second: unknown[][] = [];
  const line: unknown[][] = [];
  const unsubscribeFirst = bridge.onBingoPresentation((...args: unknown[]) => first.push(args));
  const unsubscribeSecond = bridge.onBingoPresentation((...args: unknown[]) => second.push(args));
  const unsubscribeLine = bridge.onLinePresentation((...args: unknown[]) => line.push(args));
  assert.deepEqual(calls.map(({ operation, channel }) => [operation, channel]), [
    ['on', 'bingo:presentation'], ['on', 'bingo:presentation'], ['on', 'line:presentation'],
  ]);
  const firstListener = calls[0].args[0];
  const secondListener = calls[1].args[0];
  assert.notEqual(firstListener, secondListener);
  const award = { id: 'award-canonical', winnerCount: 3 };
  const electronEvent = { sender: 'private-electron-event' };
  emit('bingo:presentation', electronEvent, award);
  emit('bingo:presentation', electronEvent, null);
  assert.deepEqual(first, [[award], [null]]);
  assert.deepEqual(second, [[award], [null]]);
  assert.equal(first[0][0], award);
  assert.equal(second[0][0], award);
  assert.deepEqual(line, []);
  unsubscribeFirst();
  assert.deepEqual(calls[3], {
    operation: 'removeListener', channel: 'bingo:presentation', args: [firstListener],
  });
  assert.equal(listeners.get('bingo:presentation')!.has(secondListener as any), true);
  emit('line:presentation', electronEvent, award);
  assert.deepEqual(line, [[award]]);
  assert.equal(second.length, 2, 'Line events must not reach Bingo subscribers');
  emit('bingo:presentation', electronEvent, award);
  assert.equal(first.length, 2);
  assert.deepEqual(second, [[award], [null], [award]]);
  unsubscribeSecond();
  assert.deepEqual(calls[4], {
    operation: 'removeListener', channel: 'bingo:presentation', args: [secondListener],
  });
  assert.equal(listeners.get('line:presentation')!.size, 1);
  unsubscribeLine();
  assert.equal(listeners.get('bingo:presentation')!.size, 0);
  assert.equal(calls.every(({ operation }) => operation === 'on' || operation === 'removeListener'), true);
});

test('representative existing Line, lot, theme, event and public-status behavior is preserved', () => {
  const { bridge, calls, result, emit } = loadPreload();
  assert.equal(bridge.confirmLine('session', 'event', 2), result);
  const identity = { eventId: 'event', auditSequence: 4, presentationId: 'line-award' };
  assert.equal(bridge.drawLineLot(identity), result);
  const bingoIdentity = { eventId: 'event', auditSequence: 6, presentationId: 'bingo-award' };
  const bingoSnapshot = { ...bingoIdentity, winnerCount: 5, lot: 'Hamper',
    presentation: { id: 'bingo-award', status: 'completed' },
    fact: { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: 3, colorId: 'blue' } };
  assert.equal(bridge.readBingoLot(), result);
  assert.equal(bridge.drawBingoLot(bingoIdentity), result);
  assert.equal(bridge.presentBingoLot(bingoSnapshot), result);
  assert.equal(bridge.getTheme(), result);
  assert.equal(bridge.getCurrentEvent(), result);
  assert.deepEqual(calls, [
    { operation: 'invoke', channel: 'line:confirm', args: ['session', 'event', 2] },
    { operation: 'invoke', channel: 'line:lot:draw', args: [identity] },
    { operation: 'invoke', channel: 'bingo:lot:read', args: [] },
    { operation: 'invoke', channel: 'bingo:lot:draw', args: [bingoIdentity] },
    { operation: 'invoke', channel: 'bingo:lot:present', args: [bingoSnapshot] },
    { operation: 'invoke', channel: 'theme:get', args: [] },
    { operation: 'invoke', channel: 'event:get', args: [] },
  ]);
  const statuses: unknown[][] = [];
  const unsubscribe = bridge.onPublicStatus((...args: unknown[]) => statuses.push(args));
  emit('public-status', {}, true);
  assert.deepEqual(statuses, [[true]]);
  unsubscribe();
  assert.equal(calls.at(-1)!.args[0], calls.at(-2)!.args[0]);
  assert.equal(calls.at(-1)!.channel, 'public-status');
});
