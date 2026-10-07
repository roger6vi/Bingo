// Manual line-lot smoke scenarios (verification only). Registered by line-smoke.mjs; they receive its guarded ctx and
// never import the harness, touch a profile of their own, or patch production code, timers or matchMedia.
import assert from 'node:assert/strict';
import path from 'node:path';

const COLORS = { red: 'Rojo', blue: 'Azul', green: 'Verde', yellow: 'Amarillo', purple: 'Morado', orange: 'Naranja' };
const PALETTE = Object.keys(COLORS);
const PLAYBACK_MS = 4000; // src/line-lot-playback.mjs LINE_LOT_PLAYBACK_MS (normal motion)
const TOLERANCE_MS = 600; // MutationObserver/timer scheduling slack; this is DOM-mutation timing, not paint timing
const SHOW_WITHIN_MS = 2000; // draw click -> card shown (IPC, store write, public delivery, render)

// Shared setup (the 1b path): a three-way pending `Cesta` lot after its first-line celebration completed.
async function pendingLot(ctx) {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, 'Cesta');
  const page = await ctx.openPublic(app, operator);
  await ctx.declare(operator, 3);
  const started = await ctx.waitAward('started', (award) => award.status === 'started');
  await ctx.runToCompletion(operator, started);
  const { lot, audit } = await ctx.readLot();
  assert.deepEqual([lot.lot, lot.winners, lot.lotResolution, lot.origin, lot.participant, lot.color], ['Cesta', 3, 'pending', 'none', null, null]);
  return { app, operator, page, before: { lot, audit } };
}

const suffixOf = ({ participant, color }) => `Ganador del lote: nº ${participant} · ${COLORS[color]}`;
const operatorText = (operator) => operator.locator('#line-lot').evaluate((el) => el.shadowRoot.textContent);
const permanent = (page) => page.evaluate(() => document.querySelector('#line-award').textContent);
const card = (page) => page.evaluate(() => { const el = document.querySelector('#line-lot-playback'); return { hidden: el.hidden, text: el.textContent }; });
// Records show/hide of the playback card.
const trace = (page) => page.evaluate(() => {
  const el = document.querySelector('#line-lot-playback');
  window.__lotTrace = [];
  new MutationObserver(() => window.__lotTrace.push({ t: performance.now(), hidden: el.hidden, text: el.textContent }))
    .observe(el, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
  return el.hidden;
});
const records = (page) => page.evaluate(() => window.__lotTrace);
// Emulate, then reload so the page loads under normal motion; assert it in-page before tracing or drawing.
const motion = async (page) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), false, 'normal motion is in effect');
};

// Asserts the permanent fact and the absence of any live card on a (re)attached public page.
async function quietPermanent(ctx, page, suffix, label) {
  await motion(page);
  assert.equal(await trace(page), true, `${label}: card starts hidden`);
  await page.waitForFunction((text) => document.querySelector('#line-award').textContent.includes(text), suffix);
  await ctx.pause(1500);
  assert.ok((await permanent(page)).includes(suffix), `${label}: permanent winner text`);
  assert.deepEqual(await card(page), { hidden: true, text: '' }, `${label}: no live card`);
  assert.deepEqual(await records(page), [], `${label}: no card mutation, so no replay`);
}

// A. Real operator draw -> committed fact -> public live card (4000 ms) and permanent text; no replay anywhere else.
async function liveHydrate(ctx) {
  const first = await pendingLot(ctx);
  await motion(first.page);
  assert.equal(await trace(first.page), true, 'card hidden before the draw');
  await first.operator.locator('#line-lot [data-intent="draw"]').waitFor({ state: 'visible' });
  const clickBoundary = await first.page.evaluate(() => performance.now()); // public page clock, immediately before the click
  await first.operator.locator('#line-lot [data-intent="draw"]').click();
  await first.operator.waitForFunction(() => document.querySelector('#line-lot').shadowRoot.textContent.includes('Ganador: participante'));
  const { lot: won, audit } = await ctx.readLot();
  assert.deepEqual([won.origin, won.lotResolution, won.status], ['numbered_v1', 'resolved', 'completed'], 'committed numbered fact');
  assert.ok(Number.isInteger(won.participant) && won.participant >= 1 && won.participant <= 3, `participant ${won.participant}`);
  assert.equal(won.color, PALETTE[(won.participant - 1) % 6], 'palette v1 colour of the participant');
  const suffix = suffixOf(won);
  assert.ok((await operatorText(first.operator)).includes(`Ganador: participante ${won.participant}, color ${COLORS[won.color]}.`), 'operator result text');
  await first.page.waitForFunction((text) => document.querySelector('#line-award').textContent.includes(text), suffix);
  assert.ok((await permanent(first.page)).includes(suffix), 'public permanent text matches the committed fact');
  // The card text is exactly the winner suffix; wait for the show/hide pair, then judge the measured duration.
  for (let tries = 0; ; tries++) {
    const seen = await records(first.page);
    if (seen.some((r) => r.hidden === false) && seen.at(-1).hidden === true) break;
    assert.ok(tries < 100, 'card never completed its show/hide cycle');
    await ctx.pause(100);
  }
  const seen = await records(first.page);
  const shown = seen.find((r) => r.hidden === false);
  const hidden = seen.find((r) => r.t > shown.t && r.hidden === true);
  assert.equal(shown.text, suffix, 'public card text equals the committed winner');
  const latency = Math.round(shown.t - clickBoundary);
  const duration = Math.round(hidden.t - shown.t);
  ctx.note(`live card: shown ${latency} ms after the public-clock pre-click boundary -> card mutation; visible ${duration} ms (nominal ${PLAYBACK_MS}, tolerance +${TOLERANCE_MS}/-500; DOM mutation times, not paint)`);
  assert.ok(latency >= -5 && latency <= SHOW_WITHIN_MS, `card shown ${latency} ms after the click`);
  assert.ok(duration >= PLAYBACK_MS - 500, `card hid after ${duration} ms, before ~3500`);
  assert.ok(duration <= PLAYBACK_MS + TOLERANCE_MS, `card stayed ${duration} ms, beyond 4000 + ${TOLERANCE_MS}`);
  await ctx.shoot('after-draw');

  await first.page.reload();
  await quietPermanent(ctx, first.page, suffix, 'reload');
  await first.page.close();
  const reopened = await ctx.openPublic(first.app, first.operator);
  await quietPermanent(ctx, reopened, suffix, 'reopened window');
  const { operator, app } = await ctx.restart({ app: first.app }, 'restart');
  const afterRestart = await ctx.openPublic(app, operator);
  await quietPermanent(ctx, afterRestart, suffix, 'app restart');
  await operator.waitForFunction(() => document.querySelector('#line-lot').shadowRoot.textContent.includes('Ganador: participante'));
  assert.ok((await operatorText(operator)).includes(`participante ${won.participant}, color ${COLORS[won.color]}.`), 'operator fact after restart');

  // A second draw and a re-present are refused: same fact, no new live signal, nothing else committed.
  const read = await operator.evaluate(() => window.desktop.readLineLot());
  assert.equal(read.ok, true);
  const { eventId, auditSequence, presentation } = read.snapshot;
  const again = await operator.evaluate((id) => window.desktop.drawLineLot(id), { eventId, auditSequence, presentationId: presentation.id });
  assert.deepEqual([again.ok, again.kind, again.snapshot.fact.participantNumber, again.snapshot.fact.colorId], [true, 'current', won.participant, won.color], 'second draw returns the stored fact, never a new one');
  const present = await operator.evaluate((snapshot) => window.desktop.presentLineLot(snapshot), read.snapshot);
  assert.deepEqual([present.ok, present.code], [false, 'ineligible'], 're-present is refused');
  await ctx.pause(1500);
  assert.deepEqual(await records(afterRestart), [], 'no new live signal');
  assert.deepEqual(await ctx.readLot(), { lot: won, audit }, 'lot, cash, share and audit identity unchanged');
  await ctx.shoot('final');
}

// Opens a window that is NOT the app's own, loading the shipped document with the matching preload.
async function foreign(ctx, app, kind) {
  const operator = kind === 'operator';
  const options = { preload: operator ? ctx.shipped.operatorPreload : ctx.preload, file: operator ? ctx.shipped.operatorHtml : ctx.shipped.publicHtml, sandbox: !operator };
  const [page] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ BrowserWindow }, { preload, file, sandbox }) => {
    void new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox } }).loadFile(file);
  }, options)]);
  await page.waitForFunction((name) => name in window, operator ? 'desktop' : 'publicLineReceipt');
  ctx.note(`foreign ${kind} window loaded ${path.basename(options.file)} (console/CSP output above is kept, not suppressed)`);
  return page;
}

// B. Only the real operator frame can draw/present; only the real public frame's matching receipt starts a run.
async function authorityReceipts(ctx) {
  const { app, operator } = await ctx.launch('run');
  await ctx.seed(operator, 'Cesta');
  const page = await ctx.openPublic(app, operator);
  await ctx.delayReceipt(page, 1500);
  const outsider = await foreign(ctx, app, 'public');
  await ctx.declare(operator, 3);
  const pending = await ctx.waitAward('pending', (award) => award.status === 'pending');
  await page.evaluate(() => window.publicLineReceipt.started('not-the-id'));
  await outsider.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  assert.equal((await ctx.award()).status, 'pending', 'wrong-id and foreign-window receipts are refused');
  const started = await ctx.waitAward('started by the real receipt', (award) => award.status === 'started');
  await page.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await outsider.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  const { at: _at, ...frozen } = started;
  assert.deepEqual(await ctx.award(), frozen, 'duplicate and foreign receipts change nothing');
  const { at: _done, ...done } = await ctx.runToCompletion(operator, started);
  await page.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await outsider.evaluate((id) => window.publicLineReceipt.started(id), pending.id);
  await ctx.pause(300);
  assert.deepEqual(await ctx.award(), done, 'late receipts change nothing');

  // A foreign window with the operator preload and the shipped operator document is not the operator.
  const before = await ctx.readLot();
  const read = await operator.evaluate(() => window.desktop.readLineLot());
  assert.equal(read.ok, true);
  const { eventId, auditSequence, presentation } = read.snapshot;
  const impostor = await foreign(ctx, app, 'operator');
  const outcome = await impostor.evaluate(async ([id, snapshot]) => {
    const attempt = async (call) => { try { return { resolved: await call() }; } catch (error) { return { rejected: String(error.message) }; } };
    return { read: await attempt(() => window.desktop.readLineLot()), draw: await attempt(() => window.desktop.drawLineLot(id)),
      present: await attempt(() => window.desktop.presentLineLot(snapshot)) };
  }, [{ eventId, auditSequence, presentationId: presentation.id }, read.snapshot]);
  for (const call of ['read', 'draw', 'present']) assert.ok('rejected' in outcome[call], `foreign operator ${call} must be rejected: ${JSON.stringify(outcome[call])}`);
  assert.deepEqual(await ctx.readLot(), before, 'fixture unchanged by the foreign operator window');
  assert.equal(before.lot.lotResolution, 'pending');

  // API separation of the real windows.
  const names = ['desktop', 'publicLineReceipt', 'publicLineLot', 'publicLineAward', 'publicEvent'];
  const surface = (target) => target.evaluate((list) => Object.fromEntries(list.map((name) => [name, name in window])), names);
  const own = await surface(operator);
  assert.deepEqual([own.desktop, own.publicLineReceipt, own.publicLineLot], [true, false, false], 'operator has no public receipt/lot API');
  const publicSide = await surface(page);
  assert.equal(publicSide.desktop, false, 'public has no desktop (draw) API');
  assert.equal(publicSide.publicLineReceipt, true);
  assert.equal((await surface(impostor)).publicLineReceipt, false, 'foreign operator window has no receipt API');
  assert.equal((await surface(outsider)).desktop, false, 'foreign public window has no draw API');
  await ctx.shoot('final');
}

export const LOT_SCENARIOS = [
  ['8-lot-live-hydrate', liveHydrate],
  ['9-lot-authority-receipts', authorityReceipts],
];
