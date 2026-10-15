import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BINGO_CHANNELS } from '../src/bingo-ipc.ts';
import { createOperatorGuard } from '../src/event-ipc.ts';
import { LINE_CHANNELS, registerLineIpc } from '../src/line-ipc.ts';
import { createPublicEventDelivery } from '../src/public-event-delivery.ts';
// Dynamic import lets RED assert the missing production composition, rather than fail module bootstrap.
const production = await import('../src/bingo-main-wiring.ts').catch(() => null);
const base = () => ({ eventId: 'a', calledNumbers: [7], phase: 'line_declared',
  lastTransitionAt: '2026-10-01T09:00:00.000Z', auditSequence: 3,
  bingoPrize: { amount: 20, lot: '' },
  line: { auditSequence: 2, presentationId: 'lp', lotResolution: 'not_required' } });
const award = () => ({ eventId: 'a', award: { winnerCount: 1, totalCents: 2000, shareCents: 2000,
  remainderCents: 0, lot: '', lotResolution: 'not_required' },
  presentation: { id: 'private-id', status: 'pending', startedAt: null, deadlineAt: null } });
const legacy = () => ({ eventId: 'a', phase: 'checking_bingo', auditSequence: 3,
  lastTransitionAt: '2026-10-01T09:00:00.000Z' });

// Spy store: composition/callback evidence only, not transactional persistence proof.
function harness() {
  assert.ok(production, 'the real production Bingo composition must exist');
  const calls: string[] = [];
  const handlers = new Map();
  const sender = {};
  const frame = { url: 'file:///operator.html' };
  const state = { award: null as ReturnType<typeof award> | null, line: false, tongo: false, busy: false,
    uncertain: false, resolved: false, loadFail: false, publicFail: false, privateFail: false,
    hook: undefined as (() => void) | undefined,
    publicSink: undefined as ((snapshot: unknown) => void) | undefined };
  const store = {
    load: () => { calls.push('phase'); return { calledNumbers: [7], phase: 'bingo_declared', lastTransitionAt: null }; },
    loadBingoAward: () => {
      calls.push('award');
      if (state.loadFail) throw new Error('unreadable');
      return state.award;
    },
    loadBingoDeclarationBaseline: base,
    declareBingoDirectly: () => {
      calls.push('write');
      if (state.uncertain) throw new Error('uncertain');
      return state.award = award();
    },
    confirmBingoDeclaration: () => {
      if (!state.resolved) throw new Error('unknown');
      return { state: 'declared', award: state.award = award() };
    },
    loadLegacyBingoCheck: legacy,
    cancelLegacyBingoCheck: () => { calls.push('recover'); state.award = null; },
    confirmLegacyBingoCancel: () => 'recovered',
    interruptStartedBingoPresentations: () => { calls.push('interrupt'); },
    failPendingBingoPresentations: () => { calls.push('fail-pending'); },
  };
  const privateValues: unknown[] = [];
  const wiring = production.registerBingoMainWiring({ handle: (channel, handler) => handlers.set(channel, handler) }, store, {
    authorize: createOperatorGuard(sender, () => frame, frame.url), now: () => new Date('2026-10-01T10:00:00Z'),
    otherSetupActive: () => state.line, tongoPlaying: () => state.tongo, presentationBusy: () => state.busy,
    publishCommitted: (snapshot) => {
      calls.push('public'); state.hook?.(); state.publicSink?.(snapshot);
      if (state.publicFail) throw new Error('public unavailable');
    },
    notifyBingo: (value) => {
      calls.push('private'); privateValues.push(value);
      if (state.privateFail) throw new Error('operator unavailable');
    },
  });
  const invoke = (channel: string, args: unknown[] = [], from = sender, fromFrame = frame) =>
    handlers.get(channel)({ sender: from, senderFrame: fromFrame }, ...args);
  const begin = () => {
    const result = invoke(BINGO_CHANNELS.begin);
    assert.equal(result.state, 'setup');
    return result.session.sessionId;
  };
  return { calls, handlers, state, store, privateValues, wiring, invoke, begin, sender, frame };
}

test('production registers exactly eight routes; every route uses exact operator authorization', () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()], Object.values(BINGO_CHANNELS));
  for (const channel of h.handlers.keys()) {
    assert.throws(() => h.invoke(channel, [], {}), /Unauthorized/);
    assert.throws(() => h.invoke(channel, [], h.sender, { ...h.frame }), /Unauthorized/);
    h.frame.url = 'file:///wrong.html';
    assert.throws(() => h.invoke(channel), /Unauthorized/);
    h.frame.url = 'file:///operator.html';
  }
  assert.deepEqual(h.calls, []);
});

test('shared setup, Tongo and presentation gates refuse begin; combined guard tracks processing and sessions', () => {
  const h = harness();
  const combined = production!.sharedSetupActive({ active: () => h.state.line }, h.wiring);
  for (const [flag, code] of [['line', 'setup_active'], ['tongo', 'tongo_active'], ['busy', 'presentation_busy']]) {
    h.state[flag] = true;
    assert.equal(h.invoke(BINGO_CHANNELS.begin).code, code);
    h.state[flag] = false;
  }
  assert.equal(combined(), false);
  const id = h.begin();
  assert.equal(combined(), true);
  let reentrant: unknown;
  let guarded = false;
  h.state.hook = () => { guarded = combined(); reentrant = h.invoke(BINGO_CHANNELS.begin).code; };
  h.invoke(BINGO_CHANNELS.confirm, [id, 1]);
  assert.equal(guarded, true);
  assert.equal(reentrant, 'setup_active');
  assert.equal(combined(), false);
  h.state.line = true;
  assert.equal(combined(), true);
});

test('fresh confirm refreshes phase/facts before private durable status, without playback or manual dispatch', () => {
  const h = harness();
  const id = h.begin();
  assert.equal(h.invoke(BINGO_CHANNELS.confirm, [id, 1]).state, 'declared');
  assert.deepEqual(h.calls, ['write', 'phase', 'public', 'award', 'private']);
  assert.deepEqual(h.privateValues, [award()]);
  assert.equal(h.invoke(BINGO_CHANNELS.retryPresentation, ['private-id']).code, 'presentation_refused');
  assert.equal(h.invoke(BINGO_CHANNELS.repeatPresentation, ['private-id']).code, 'presentation_refused');
  assert.deepEqual(h.calls, ['write', 'phase', 'public', 'award', 'private']);
});

test('ordinary reads do not refresh; bound uncertain read refreshes only after authoritative recovery', () => {
  const h = harness();
  assert.equal(h.invoke(BINGO_CHANNELS.read).state, 'none');
  assert.deepEqual(h.calls, ['award']);
  h.calls.length = 0;
  const id = h.begin();
  h.state.uncertain = true;
  assert.equal(h.invoke(BINGO_CHANNELS.confirm, [id, 1]).code, 'storage_failure');
  assert.deepEqual(h.calls, ['write']);
  h.state.resolved = true;
  assert.equal(h.invoke(BINGO_CHANNELS.read).state, 'declared');
  assert.deepEqual(h.calls, ['write', 'phase', 'public', 'award', 'private']);
  h.calls.length = 0;
  h.invoke(BINGO_CHANNELS.read);
  assert.deepEqual(h.calls, ['award']);
});

test('legacy recovery refreshes independently, with null private status and no celebration', () => {
  const h = harness();
  const check = legacy();
  assert.equal(h.invoke(BINGO_CHANNELS.legacyCancel,
    [check.eventId, check.auditSequence, check.lastTransitionAt]).state, 'recovered');
  assert.deepEqual(h.calls, ['recover', 'phase', 'public', 'award', 'private']);
  assert.deepEqual(h.privateValues, [null]);
});

test('public and private failures cannot undo commit or suppress the other delivery; failed award load clears status', () => {
  for (const flag of ['publicFail', 'privateFail', 'loadFail']) {
    const h = harness();
    h.state[flag] = true;
    assert.equal(h.invoke(BINGO_CHANNELS.confirm, [h.begin(), 1]).state, 'declared');
    assert.deepEqual(h.calls, ['write', 'phase', 'public', 'award', 'private']);
    assert.deepEqual(h.privateValues, [flag === 'loadFail' ? null : award()]);
  }
});

test('real Line and Bingo registrations exclude reciprocal setups, including Bingo callback processing', () => {
  const h = harness();
  const handlers = new Map();
  const line = registerLineIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    loadLineDeclarationBaseline: () => ({ ...base(), phase: 'drawing', linePrize: { amount: 10, lot: '' } }),
  }, { authorize: createOperatorGuard(h.sender, () => h.frame, h.frame.url), now: () => new Date(),
    otherSetupActive: () => h.wiring.active() });
  Object.defineProperty(h.state, 'line', { get: line.active });
  const invokeLine = (channel, args = []) => handlers.get(channel)({ sender: h.sender, senderFrame: h.frame }, ...args);
  const session = invokeLine(LINE_CHANNELS.begin).session;
  assert.equal(h.invoke(BINGO_CHANNELS.begin).code, 'setup_active');
  invokeLine(LINE_CHANNELS.cancel, [session.sessionId, session.eventId]);
  const id = h.begin();
  assert.equal(invokeLine(LINE_CHANNELS.begin).code, 'setup_active');
  let duringCallback;
  h.state.hook = () => { duringCallback = invokeLine(LINE_CHANNELS.begin).code; };
  h.invoke(BINGO_CHANNELS.confirm, [id, 1]);
  assert.equal(duringCallback, 'setup_active');
  assert.ok(invokeLine(LINE_CHANNELS.begin).session);
});

test('production refresh uses existing facts-before-state delivery and never leaks private presentation fields', () => {
  const h = harness();
  const messages: Array<[string, unknown]> = [];
  const delivery = createPublicEventDelivery(h.store, undefined, undefined, undefined, undefined, undefined,
    () => h.state.award);
  delivery.attachAfterLoad({ isDestroyed: () => false, send: (channel, payload) => messages.push([channel, payload]) });
  messages.length = 0;
  h.calls.length = 0;
  h.state.publicSink = delivery.publishCommitted;
  h.invoke(BINGO_CHANNELS.confirm, [h.begin(), 1]);
  assert.deepEqual(messages.map(([channel]) => channel), ['public:bingo-award', 'public:event-state']);
  assert.deepEqual(Object.keys(messages[0][1]).sort(),
    ['eventId', 'winnerCount', 'totalCents', 'shareCents', 'remainderCents', 'lot', 'lotResolution'].sort());
  assert.equal(JSON.stringify(messages).includes('private-id'), false);
  assert.deepEqual(h.privateValues, [award()]);
});

test('startup composition only interrupts then fails persisted Bingo presentations', () => {
  const h = harness();
  production!.recoverBingoPresentations(h.store);
  assert.deepEqual(h.calls, ['interrupt', 'fail-pending']);
  assert.equal(h.wiring.active(), false);
});

test('main uses production composition before windows and shared guards, keeping receipts and status private', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /registerBingoMainWiring\(ipcMain, store,/);
  assert.ok(main.indexOf('recoverBingoPresentations(store)') < main.indexOf('new BrowserWindow('));
  assert.match(main, /otherSetupActive: \(\) => bingo\.active\(\)/);
  assert.match(main, /otherSetupActive: line\.active/);
  assert.match(main, /sharedSetupActive\(line, bingo\)/);
  assert.match(main, /publishMeta, setupActive, presentations\.busy/);
  assert.match(main, /publishPrizes, setupActive/);
  assert.match(main, /tongo\.playing, setupActive,/);
  assert.match(main, /send\('bingo:presentation', award\)/);
  assert.match(main, /notifyBingo,/);
  assert.match(main, /PUBLIC_LINE_RECEIPT_CHANNEL,[\s\S]*presentations\.lineReceipt\(event, id\)/);
  assert.match(main, /PUBLIC_BINGO_RECEIPT_CHANNEL,[\s\S]*presentations\.bingoReceipt\(event, id\)/);
  assert.match(main, /acceptBingoReceipt\(event, id, publicUrl\)/);
  assert.doesNotMatch(main, /bingo\.begin\(|bingo\.retry\(|bingo\.repeat\(/);
  // Existing public delivery is the whitelist owner; no private award is sent through a public port here.
  const helper = readFileSync(new URL('../src/bingo-main-wiring.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /publishCommitted\(award|\.begin\(|retry:|repeat:/);
});
