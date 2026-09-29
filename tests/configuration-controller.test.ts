import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationController, previewPrizes, SAVE_ERRORS, validateDraft } from '../src/configuration-controller.mjs';

type Config = { id: string; name: string; date: string; place: string; theme: string | null;
  lineAmount: string | null; lineLot: string | null; bingoAmount: string | null; bingoLot: string | null };
type State = { committed: Config | null; draft: Config | null; dirty: boolean; pending: boolean; error: string | null;
  errors: Record<string, string>; canSave: boolean };
// Prizes stay unread (null) until setCommittedPrizes acknowledges them for the event.
const unread = { lineAmount: null, lineLot: null, bingoAmount: null, bingoLot: null };
const event = (id = 'a', name = 'Verbena') => ({ id, name, date: '2026-08-15', place: 'Plaza', phase: 'drawing', active: true });

function fixture() {
  const renders: State[] = [];
  const calls: string[] = [];
  const replies = { meta: async () => true, theme: async () => true, prizes: async () => true };
  const controller = createConfigurationController({
    saveMeta: (id: string, meta: unknown) => { calls.push(`meta:${id}:${JSON.stringify(meta)}`); return replies.meta(); },
    saveTheme: (theme: string) => { calls.push(`theme:${theme}`); return replies.theme(); },
    savePrizes: (id: string, prizes: unknown) => { calls.push(`prizes:${id}:${JSON.stringify(prizes)}`); return replies.prizes(); },
  }, { render: (state: State) => { renders.push(structuredClone(state)); } });
  return { controller, renders, calls, replies, last: () => renders.at(-1)! };
}

test('the draft starts from committed values in either arrival order and edits never touch the committed baseline', () => {
  const f = fixture();
  assert.deepEqual([f.last().draft, f.last().canSave], [null, false]);
  f.controller.edit('name', 'ignored without an event');
  f.controller.setCommittedTheme('high-contrast');
  f.controller.setCommittedEvent(event());
  const committed = { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', theme: 'high-contrast', ...unread };
  assert.deepEqual([f.last().committed, f.last().draft, f.last().dirty], [committed, committed, false]);
  f.controller.edit('name', 'Gran Bingo');
  f.controller.edit('theme', 'jules');
  f.controller.edit('unknown', 'x');
  assert.deepEqual(f.last().committed, committed);
  assert.deepEqual(f.last().draft, { ...committed, name: 'Gran Bingo', theme: 'jules' });
  assert.deepEqual([f.last().dirty, f.last().canSave], [true, true]);
  f.controller.discard();
  assert.deepEqual([f.last().draft, f.last().dirty], [committed, false]);
  assert.deepEqual(f.calls, []);
});

test('unedited fields follow new commits, edited ones are kept, and another event resets the draft', () => {
  const f = fixture();
  f.controller.setCommittedTheme('jules');
  f.controller.setCommittedEvent(event());
  f.controller.edit('place', 'Club');
  f.controller.setCommittedEvent({ ...event(), name: 'Renamed', place: 'Sala' });
  f.controller.setCommittedTheme('high-contrast');
  assert.deepEqual(f.last().draft, { id: 'a', name: 'Renamed', date: '2026-08-15', place: 'Club', theme: 'high-contrast', ...unread });
  f.controller.setCommittedEvent(event('b', 'Otro'));
  assert.deepEqual([f.last().draft?.id, f.last().draft?.name, f.last().draft?.place, f.last().dirty], ['b', 'Otro', 'Plaza', false]);
  f.controller.setCommittedEvent(null);
  assert.deepEqual([f.last().draft, f.last().dirty, f.last().canSave], [null, false, false]);
});

test('invalid drafts cannot be saved and report field errors with the store rules', () => {
  assert.deepEqual(validateDraft({ name: ' x ', date: '2026-02-28', place: 'p'.repeat(120), theme: 'high-contrast' }), {});
  assert.deepEqual(Object.keys(validateDraft({ name: ' ', date: '2026-02-30', place: 'p'.repeat(121), theme: 'neon' })),
    ['name', 'date', 'place', 'theme']);
  const f = fixture();
  f.controller.setCommittedTheme('jules');
  f.controller.setCommittedEvent(event());
  f.controller.edit('date', '2026-13-01');
  assert.deepEqual([f.last().dirty, f.last().canSave, Object.keys(f.last().errors)], [true, false, ['date']]);
  return f.controller.save().then((saved: boolean) => {
    assert.equal(saved, false);
    assert.deepEqual(f.calls, []);
  });
});

test('save commits trimmed metadata then the theme, and acknowledges only when both committed', async () => {
  const f = fixture();
  f.controller.setCommittedTheme('jules');
  f.controller.setCommittedEvent(event());
  f.controller.edit('name', '  Gran Bingo ');
  f.controller.edit('theme', 'high-contrast');
  const saving = f.controller.save();
  assert.deepEqual([f.last().pending, f.last().canSave], [true, false]);
  f.controller.edit('name', 'ignored while saving');
  f.controller.discard();
  assert.equal(await saving, true);
  assert.deepEqual(f.calls, ['meta:a:{"name":"Gran Bingo","date":"2026-08-15","place":"Plaza"}', 'theme:high-contrast']);
  const saved = { id: 'a', name: 'Gran Bingo', date: '2026-08-15', place: 'Plaza', theme: 'high-contrast', ...unread };
  assert.deepEqual([f.last().committed, f.last().draft, f.last().dirty, f.last().error], [saved, saved, false, null]);
  f.controller.edit('place', 'Club');
  f.calls.length = 0;
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls, ['meta:a:{"name":"Gran Bingo","date":"2026-08-15","place":"Club"}'], 'only changed parts are saved');
});

test('a failed save keeps the whole draft, shows an actionable error, and can be retried', async () => {
  const f = fixture();
  f.controller.setCommittedTheme('jules');
  f.controller.setCommittedEvent(event());
  f.controller.edit('name', 'Gran Bingo');
  f.controller.edit('theme', 'high-contrast');
  f.replies.meta = async () => false;
  assert.equal(await f.controller.save(), false);
  assert.deepEqual(f.calls, ['meta:a:{"name":"Gran Bingo","date":"2026-08-15","place":"Plaza"}']);
  assert.deepEqual([f.last().committed?.name, f.last().draft?.name, f.last().draft?.theme], ['Verbena', 'Gran Bingo', 'high-contrast']);
  assert.deepEqual([f.last().error, f.last().dirty, f.last().canSave], [SAVE_ERRORS.meta, true, true]);
  f.replies.meta = async () => true;
  f.replies.theme = async () => { throw new Error('ipc'); };
  assert.equal(await f.controller.save(), false);
  assert.deepEqual([f.last().committed?.name, f.last().committed?.theme, f.last().draft?.theme],
    ['Gran Bingo', 'jules', 'high-contrast'], 'the committed metadata is the new baseline; the theme stays drafted');
  assert.equal(f.last().error, SAVE_ERRORS.themeAfterMeta);
  f.replies.theme = async () => false;
  f.calls.length = 0;
  assert.equal(await f.controller.save(), false);
  assert.deepEqual([f.calls, f.last().error], [['theme:high-contrast'], SAVE_ERRORS.theme]);
  f.controller.discard();
  assert.deepEqual([f.last().draft?.theme, f.last().dirty, f.last().error], ['jules', false, null]);
});

test('a save whose event changed meanwhile is not acknowledged and does not save the theme to the new event', async () => {
  const f = fixture();
  f.controller.setCommittedTheme('jules');
  f.controller.setCommittedEvent(event());
  f.controller.edit('name', 'Gran Bingo');
  f.controller.edit('theme', 'high-contrast');
  f.replies.meta = async () => { f.controller.setCommittedEvent(event('b', 'Otro')); return true; };
  assert.equal(await f.controller.save(), false);
  assert.equal(f.calls.some((call) => call.startsWith('theme:')), false);
  assert.deepEqual([f.last().draft?.id, f.last().dirty], ['b', false]);
});

test('a theme-only save that throws reports a theme error, not a metadata error', async () => {
  const f = fixture();
  f.controller.setCommittedTheme('high-contrast');
  f.controller.setCommittedEvent(event());
  f.controller.edit('theme', 'jules');
  f.replies.theme = async () => { throw new Error('ipc gone'); };
  assert.equal(await f.controller.save(), false);
  assert.equal(f.last().error, SAVE_ERRORS.theme);
  assert.deepEqual(f.calls, ['theme:jules']);
});

test('metadata can still be saved when the committed theme could not be read', async () => {
  const f = fixture();
  f.controller.setCommittedEvent(event());
  f.controller.edit('name', 'Gran Bingo');
  assert.equal(f.last().canSave, true);
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls, ['meta:a:{"name":"Gran Bingo","date":"2026-08-15","place":"Plaza"}']);
});

const prizes = (lineAmount: number, lineLot: string, bingoAmount: number, bingoLot: string) =>
  ({ line: { amount: lineAmount, lot: lineLot }, bingo: { amount: bingoAmount, lot: bingoLot } });

function withPrizes() {
  const f = fixture();
  f.controller.setCommittedTheme('light');
  f.controller.setCommittedPrizes('a', prizes(150, 'Jamón', 0, ''));
  f.controller.setCommittedEvent(event());
  return f;
}

test('committed prizes join the draft as form text in either order, only for their own event', () => {
  const f = withPrizes();
  const fields = { lineAmount: '150', lineLot: 'Jamón', bingoAmount: '', bingoLot: '' };
  assert.deepEqual([f.last().draft, f.last().dirty], [{ ...f.last().committed, ...fields }, false]);
  assert.deepEqual(f.last().committed, { id: 'a', name: 'Verbena', date: '2026-08-15', place: 'Plaza', theme: 'light', ...fields });
  // Prizes read for another event, or malformed ones, never replace these.
  f.controller.setCommittedPrizes('b', prizes(1, '', 1, ''));
  for (const bad of [null, prizes(-1, '', 0, ''), prizes(1.5, '', 0, ''), prizes(0, ' x ', 0, ''), { line: { amount: 1, lot: '' } }]) {
    f.controller.setCommittedPrizes('a', bad);
  }
  assert.deepEqual(f.last().draft, { ...f.last().committed, ...fields });
  f.controller.edit('bingoLot', 'Cesta');
  f.controller.setCommittedPrizes('a', prizes(200, 'Jamón', 0, ''));
  assert.deepEqual([f.last().draft?.lineAmount, f.last().draft?.bingoLot, f.last().dirty], ['200', 'Cesta', true],
    'an unedited prize field follows a new commit; an edited one is kept');
  f.controller.discard();
  assert.deepEqual([f.last().draft?.bingoLot, f.last().dirty], ['', false]);
  // Prizes read for the next event before it becomes the committed one are picked up on selection.
  f.controller.setCommittedPrizes('b', prizes(1, '', 1, ''));
  assert.equal(f.last().draft?.lineAmount, '200');
  f.controller.setCommittedEvent(event('b', 'Otro'));
  assert.deepEqual([f.last().draft?.lineAmount, f.last().draft?.bingoAmount], ['1', '1']);
  f.controller.setCommittedEvent(event('c', 'Nuevo'));
  assert.deepEqual([f.last().draft?.lineAmount, f.last().draft?.lineLot], [null, null]);
  assert.deepEqual(f.calls, []);
});

test('prize drafts validate like the store: blank or whole euros 0–100 000 and lots of up to 120 characters', () => {
  const draft = (lineAmount: string, lineLot = '', bingoAmount = '', bingoLot = '') =>
    validateDraft({ name: 'N', date: '2026-02-28', place: 'P', theme: null, lineAmount, lineLot, bingoAmount, bingoLot });
  for (const amount of ['', '  ', '0', '7', ' 12 ', '100000', '007']) assert.deepEqual(draft(amount), {}, amount);
  for (const amount of ['-1', '100001', '1.5', '1,5', '1e3', 'abc', '10 €', '0x10', '1000000']) {
    assert.deepEqual(Object.keys(draft(amount)), ['lineAmount'], amount);
  }
  assert.deepEqual(draft('', ` ${'l'.repeat(120)} `, '', 'l'.repeat(120)), {});
  assert.deepEqual(draft('', 'l'.repeat(121), '5', 'l'.repeat(121)), {
    lineLot: 'Escribe un lote de hasta 120 caracteres.', bingoLot: 'Escribe un lote de hasta 120 caracteres.' });
  assert.equal(draft('x').lineAmount, 'Escribe un importe en euros enteros, de 0 a 100 000.');
});

test('saving prizes sends normalized values and makes them the committed baseline', async () => {
  const f = withPrizes();
  f.controller.edit('lineAmount', ' 007 ');
  f.controller.edit('bingoAmount', '500');
  f.controller.edit('bingoLot', '  Cesta de Navidad ');
  assert.equal(f.last().canSave, true);
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls, [`prizes:a:${JSON.stringify(prizes(7, 'Jamón', 500, 'Cesta de Navidad'))}`], 'only the prizes changed');
  const fields = { lineAmount: '7', lineLot: 'Jamón', bingoAmount: '500', bingoLot: 'Cesta de Navidad' };
  assert.deepEqual([f.last().draft, f.last().dirty, f.last().error], [{ ...f.last().committed, ...fields }, false, null]);
  // Clearing both parts saves a prize of 0 € with no lot.
  f.controller.edit('lineAmount', '');
  f.controller.edit('lineLot', ' ');
  f.calls.length = 0;
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls, [`prizes:a:${JSON.stringify(prizes(0, '', 500, 'Cesta de Navidad'))}`]);
});

test('a failed prize save keeps the prize draft and says whether the other changes committed', async () => {
  const f = withPrizes();
  f.controller.edit('name', 'Gran Bingo');
  f.controller.edit('lineAmount', '300');
  f.replies.prizes = async () => false;
  assert.equal(await f.controller.save(), false);
  assert.deepEqual(f.calls.map((call) => call.split(':')[0]), ['meta', 'prizes']);
  assert.deepEqual([f.last().committed?.name, f.last().committed?.lineAmount, f.last().draft?.lineAmount],
    ['Gran Bingo', '150', '300']);
  assert.deepEqual([f.last().error, f.last().dirty, f.last().canSave], [SAVE_ERRORS.prizesAfterOther, true, true]);
  f.replies.prizes = async () => { throw new Error('ipc gone'); };
  f.calls.length = 0;
  assert.equal(await f.controller.save(), false);
  assert.deepEqual([f.calls.length, f.last().error], [1, SAVE_ERRORS.prizes]);
  f.replies.prizes = async () => true;
  assert.equal(await f.controller.save(), true);
  assert.deepEqual([f.last().committed?.lineAmount, f.last().error], ['300', null]);
});

test('invalid prize drafts cannot be saved, and unread prizes stay locked while the rest is saveable', async () => {
  const f = withPrizes();
  f.controller.edit('bingoAmount', '12,50');
  assert.deepEqual([f.last().dirty, f.last().canSave, Object.keys(f.last().errors)], [true, false, ['bingoAmount']]);
  assert.equal(await f.controller.save(), false);
  const unreadPrizes = fixture();
  unreadPrizes.controller.setCommittedEvent(event());
  unreadPrizes.controller.edit('lineAmount', '100');
  assert.deepEqual([unreadPrizes.last().draft?.lineAmount, unreadPrizes.last().dirty], [null, false]);
  unreadPrizes.controller.edit('name', 'Gran Bingo');
  assert.equal(await unreadPrizes.controller.save(), true);
  assert.deepEqual(unreadPrizes.calls.map((call) => call.split(':')[0]), ['meta']);
  assert.deepEqual(f.calls, []);
});

test('prizes are not saved to an event that became active during the save', async () => {
  const f = withPrizes();
  f.controller.edit('name', 'Gran Bingo');
  f.controller.edit('lineAmount', '999');
  f.replies.meta = async () => { f.controller.setCommittedEvent(event('b', 'Otro')); return true; };
  assert.equal(await f.controller.save(), false);
  assert.equal(f.calls.some((call) => call.startsWith('prizes:')), false);
});

test('the simulator preview uses each valid drafted prize and falls back per prize while one is invalid', () => {
  const committed = { lineAmount: '150', lineLot: 'Jamón', bingoAmount: '', bingoLot: '' };
  assert.deepEqual(previewPrizes({ ...committed, lineAmount: '20', bingoLot: ' Cesta ' }, committed), prizes(20, 'Jamón', 0, 'Cesta'));
  assert.deepEqual(previewPrizes({ ...committed, lineAmount: 'x', bingoAmount: '5' }, committed), prizes(150, 'Jamón', 5, ''));
  assert.equal(previewPrizes({ ...committed, lineAmount: null }, committed), null);
  assert.equal(previewPrizes(null, committed), null);
});
