// REC02B legacy checking_line recovery smoke (verification only). Registered by line-smoke.mjs; it receives its guarded
// ctx and never imports the harness, touches a profile, writes SQL, or patches production code. The legacy state is
// created by the fixture-owned seed capability (ctx.seedLegacyLine) on a harness-owned profile only, between two
// launches; every recovery step afterwards goes through the real operator UI.
import assert from 'node:assert/strict';

const CONFIRM = '#legacy-dialog [data-action="confirm"] button';
const BACK = '#legacy-dialog [data-action="cancel"] button';
const baseline = (facts) => structuredClone(facts);
const tongo = (page) => page.evaluate(() => { const el = document.querySelector('#tongo');
  return { hidden: el.hidden, active: el.active ?? null, text: el.shadowRoot?.textContent ?? '' }; });

// Manual public window: the shared open helper assumes one called number and the default event name, neither true here.
async function openPublic(app, operator, expected) {
  await operator.click('#tab-bingo');
  const [page] = await Promise.all([app.waitForEvent('window'), operator.locator('#open-public button').click()]);
  await page.waitForFunction(({ name, count }) => document.querySelector('#event-name')?.textContent === name &&
    document.querySelector('#called-count')?.value === String(count), expected);
  return page;
}

// The public page must stay an ordinary board: no celebration, no static award text, an untouched Tongo.
async function assertQuiet(ctx, page, tongoBefore, label) {
  const shown = await ctx.celebration(page);
  assert.deepEqual([shown.active, shown.text, shown.award], [false, false, ''], `${label}: no celebration and no award text`);
  assert.deepEqual(await tongo(page), tongoBefore, `${label}: Tongo untouched`);
}

async function legacyRecovery(ctx) {
  // 1. Bootstrap on the owned profile (runtime identity verified by the lifecycle), prove it is pristine, then close.
  await ctx.launch('bootstrap');
  const pristine = await ctx.readRecovery();
  assert.deepEqual([pristine.calledNumbers, pristine.phase, pristine.audit, pristine.awards], [[], 'drawing', [], []], 'bootstrap is a pristine drawing baseline');
  await ctx.closeApps();
  // 2. Offline seed through the real store API, then relaunch on the same retained profile.
  const seeded = await ctx.seedLegacyLine();
  assert.deepEqual([seeded.calledNumbers, seeded.phase, seeded.award, seeded.audit.map((entry) => entry.kind)], [[7, 42], 'checking_line', null, ['begin_line_check']]);
  const { app, operator } = await ctx.launch('legacy');
  await operator.waitForFunction(() => !document.querySelector('#line-recover').hidden && document.querySelector('#event-summary').count === 2);
  const before = baseline(await ctx.readRecovery());
  assert.deepEqual([before.calledNumbers, before.phase, before.lastTransitionAt, before.awards], [[7, 42], 'checking_line', seeded.lastTransitionAt, []], 'seeded legacy state is what the app opened');
  assert.deepEqual([before.name, before.date, before.place], [seeded.meta.name, seeded.meta.date, seeded.meta.place]);
  assert.deepEqual(before.prizes, seeded.prizes);
  assert.deepEqual(before.audit.map((entry) => [entry.kind, entry.transitionAt]), [['begin_line_check', seeded.lastTransitionAt]]);
  // 3. No startup rewrite: wait, and the committed state is identical.
  await ctx.pause(1500);
  assert.deepEqual(await ctx.readRecovery(), before, 'startup did not cancel the legacy check');
  // 4. Public window opened manually: an ordinary board, no celebration, no Tongo.
  const page = await openPublic(app, operator, { name: seeded.meta.name, count: 2 });
  const quiet = await tongo(page);
  await assertQuiet(ctx, page, quiet, 'before recovery');
  // 5. Dismissing the confirmation changes nothing.
  await operator.click('#tab-bingo');
  await operator.locator('#line-recover button').click();
  await operator.locator('#legacy-dialog dialog').waitFor({ state: 'visible' });
  await operator.locator(BACK).click();
  await operator.locator('#legacy-dialog dialog').waitFor({ state: 'hidden' });
  await ctx.pause(300);
  assert.deepEqual(await ctx.readRecovery(), before, 'dismissing the dialog wrote nothing');
  // 6. Explicit confirmation: exactly one reject_line_claim; everything else is preserved.
  await operator.locator('#line-recover button').click();
  await operator.locator('#legacy-dialog dialog').waitFor({ state: 'visible' });
  await operator.locator(CONFIRM).click();
  await operator.waitForFunction(() => document.querySelector('#line-recover').hidden && !document.querySelector('#claim-line').disabled);
  const after = baseline(await ctx.readRecovery());
  assert.equal(after.phase, 'drawing', 'the game is drawing again');
  assert.deepEqual(after.calledNumbers, [7, 42], 'called numbers and order are preserved');
  assert.deepEqual([after.name, after.date, after.place, after.prizes], [before.name, before.date, before.place, before.prizes], 'metadata and prizes are preserved');
  assert.deepEqual(after.audit.slice(0, 1), before.audit, 'prior audit is preserved');
  assert.equal(after.audit.filter((entry) => entry.kind === 'reject_line_claim').length, 1, 'exactly one reject_line_claim');
  assert.deepEqual(after.audit.map((entry) => [entry.kind, entry.fromPhase, entry.toPhase]),
    [['begin_line_check', 'drawing', 'checking_line'], ['reject_line_claim', 'checking_line', 'drawing']]);
  assert.ok(after.audit[1].transitionAt > before.lastTransitionAt, 'the cancellation is newer than the check');
  assert.deepEqual(after.awards, [], 'no award');
  await ctx.pause(1500);
  await assertQuiet(ctx, page, quiet, 'after recovery');
  assert.deepEqual(await ctx.readRecovery(), after, 'nothing else changed after the recovery');
  // 7. A restart stays in drawing: no replay, no second cancellation.
  const restarted = await ctx.restart({ app, operator }, 'restart');
  assert.deepEqual(await ctx.readRecovery(), after, 'restart preserved the recovered state');
  const again = await openPublic(restarted.app, restarted.operator, { name: seeded.meta.name, count: 2 });
  await ctx.pause(1200);
  await assertQuiet(ctx, again, quiet, 'after restart');
  assert.deepEqual(await ctx.readRecovery(), after, 'opening the public window never replays');
  // 8. A normal first-line declaration works through the real UI, then drawing resumes.
  assert.equal(await ctx.award(), null);
  await ctx.declare(restarted.operator, 1);
  const started = await ctx.waitAward('started', (award) => award.status === 'started');
  const shown = await ctx.celebration(again);
  assert.deepEqual([shown.active, shown.text], [true, true], 'the normal declaration celebrates');
  await ctx.runToCompletion(restarted.operator, started);
  await ctx.drawFromUi(restarted.operator);
  const final = await ctx.readRecovery();
  assert.deepEqual(final.calledNumbers.slice(0, 2), [7, 42], 'the preserved baseline survives the later declaration and draw');
  assert.deepEqual(final.audit.slice(0, 2), after.audit, 'the preserved audit survives');
  assert.equal(final.audit.filter((entry) => entry.kind === 'reject_line_claim').length, 1, 'still exactly one reject_line_claim');
  assert.deepEqual([final.name, final.prizes], [before.name, before.prizes]);
}

export const LEGACY_RECOVERY_SCENARIOS = [['rec02b-legacy-recovery', legacyRecovery]];
