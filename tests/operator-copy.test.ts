import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lineAwardSummary, MESSAGES_ES, operatorMessage, PHASE_LABELS_ES, THEME_NAMES_ES, UNKNOWN_ERROR_ES } from '../src/operator-copy.mjs';
import { THEME_LABELS } from '../src/theme-controller.mjs';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Every English message the operator can receive, from the main process or its own controllers.
const sources = ['src/event-ipc.ts', 'src/theme-ipc.ts', 'src/event-catalog-ipc.ts', 'src/tongo-ipc.ts',
  'src/operator-controller.mjs', 'src/events-controller.mjs', 'src/theme-controller.mjs', 'src/tongo.mjs'];

test('every English operator-facing message has a Spanish translation', () => {
  const english = new Set<string>();
  for (const file of sources) {
    for (const [, text] of source(file).matchAll(/'((?:Could not|Invalid|No current|All numbers|That number|The event|Tongo|Wait for|Open the public)[^']*)'/g)) {
      english.add(text);
    }
  }
  assert.ok(english.size >= 20, `found ${english.size} messages`);
  for (const text of english) {
    assert.ok(Object.hasOwn(MESSAGES_ES, text), `missing translation: ${text}`);
    assert.notEqual(operatorMessage(text), text);
  }
});

test('operatorMessage translates known messages, keeps Spanish, and never shows unknown English', () => {
  assert.equal(operatorMessage('That number has already been called.'), 'Ese número ya se ha cantado.');
  assert.equal(operatorMessage(MESSAGES_ES['All numbers have been called.']), 'Ya se han cantado todos los números.');
  assert.equal(operatorMessage('Write failed'), UNKNOWN_ERROR_ES);
  assert.equal(operatorMessage(null), null);
  assert.equal(operatorMessage(undefined), null);
});

test('line lot controller messages are translated without mutating the controller state', () => {
  const expected = {
    'Lot unavailable.': 'El lote no está disponible ahora. Pulsa «Releer estado» para intentarlo de nuevo.',
    'Lot state needs a fresh read.': 'El estado del lote no es fiable. Pulsa «Releer estado» para leerlo de nuevo.',
    'Draw result uncertain; read the lot to continue.':
      'No se pudo confirmar el resultado del sorteo del lote. Pulsa «Releer estado» para leerlo; no se repite solo.',
  };
  for (const [english, spanish] of Object.entries(expected)) assert.equal(operatorMessage(english), spanish);
  const state = Object.freeze({ status: 'error', message: 'Lot unavailable.' });
  const view = { ...state, message: operatorMessage(state.message) };
  assert.equal(state.message, 'Lot unavailable.');
  assert.notEqual(view.message, state.message);
  assert.equal(operatorMessage('Lot exploded: ENOENT /db'), UNKNOWN_ERROR_ES);
});

test('phase and theme names cover every phase and registered theme', () => {
  assert.deepEqual(Object.keys(PHASE_LABELS_ES),
    ['drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished']);
  assert.deepEqual(Object.keys(THEME_NAMES_ES), Object.keys(THEME_LABELS));
});

const awardCopy = { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: 'Jamón', lotResolution: 'pending' };
const summaryFor = (status: string) => lineAwardSummary({ award: awardCopy, presentation: { id: 'p', status } });

test('each presentation status gets truthful Spanish copy while keeping the money and the pending lot', () => {
  for (const status of ['pending', 'started', 'failed', 'interrupted', 'completed']) {
    const text = summaryFor(status);
    assert.match(text, /Línea declarada con 3 ganadores\./, status);
    assert.match(text, /3,33 € cada uno/, status);
    assert.match(text, /Sobra 1 céntimo/, status);
    assert.match(text, /Lote «Jamón»: pendiente de resolver/, status);
  }
  assert.match(summaryFor('pending'), /todavía no muestra la celebración/);
  assert.match(summaryFor('started'), /en marcha/);
  assert.match(summaryFor('failed'), /no pudo mostrarse[\s\S]*«Reintentar celebración»/);
  assert.match(summaryFor('interrupted'), /interrumpida[\s\S]*«Repetir celebración completa»/);
  assert.match(summaryFor('completed'), /celebración pública terminó[\s\S]*lote sigue pendiente/);
  for (const status of ['pending', 'started', 'failed', 'interrupted']) {
    assert.doesNotMatch(summaryFor(status), /terminó|ya puedes|se ha completado:/i, `${status} never claims completion`);
    assert.match(summaryFor(status), /bloqueados/, status);
  }
});

test('the controller messages for a lost celebration action are translated', () => {
  const message = 'Could not confirm the line celebration. Check the line and try again.';
  assert.ok(source('src/operator-controller.mjs').includes(message));
  assert.match(operatorMessage(message), /«Línea»/);
  assert.match(operatorMessage(message), /no se repite sola/, 'the no-replay safeguard stays');
});

import * as copy from '../src/operator-copy.mjs';

test('legacy line check recovery messages from main and the controller are translated to Spanish', () => {
  const english = ['There is no line check to cancel.', 'Could not read the line check. Try again or review the event storage.',
    'Could not cancel the line check. Try again.', 'Could not confirm the line check state. Read it again before trying.',
    'A first-line setup is already open. Close it first.', 'Could not connect to the line check. Read it again before trying.',
    'Invalid line check update. Read it again before trying.'];
  for (const text of english) {
    assert.notEqual(operatorMessage(text), UNKNOWN_ERROR_ES, text);
    assert.notEqual(operatorMessage(text), text);
    assert.match(operatorMessage(text) as string, /[áéíóúñ¿«]|línea|comprobación/, text);
  }
  assert.match(operatorMessage('Could not confirm the line check state. Read it again before trying.') as string, /Releer comprobación de línea/);
});

test('legacy recovery copy names the action, keeps numbers and prizes, and never claims a line was declared', () => {
  const text = (copy as unknown as { LEGACY_CHECK_ES?: Record<string, string> }).LEGACY_CHECK_ES;
  assert.ok(text, 'LEGACY_CHECK_ES is exported');
  assert.equal(text.action, 'Cancelar comprobación de línea');
  assert.equal(text.reread, 'Releer comprobación de línea');
  assert.equal(text.back, 'Volver');
  assert.equal(text.confirm, 'Volver a cantar números');
  assert.match(text.dialog, /números cantados/);
  assert.match(text.dialog, /premios/);
  assert.doesNotMatch(Object.values(text).join(' '), /línea declarada|Línea declarada|ganador/);
  for (const key of ['available', 'recovered', 'refreshFailed']) assert.ok(text[key], key);
});

// Bingo copy (BG-05H1): distinct from the Line copy, never unlocks drawing and keeps a tied lot visibly pending.
const bingoSources = ['src/bingo-ipc.ts', 'src/bingo-controller.mjs'];

test('every English Bingo message from main and the controller has a distinct Spanish translation', () => {
  const english = new Set<string>(['Another award setup is already open. Close it first.']);
  for (const file of bingoSources) for (const [, text] of source(file).matchAll(/'([A-Z][^']*[.)])'/g)) english.add(text);
  assert.ok(english.size >= 20, `found ${english.size} messages`);
  for (const text of english) {
    assert.notEqual(copy.operatorMessage(text), UNKNOWN_ERROR_ES, text);
    assert.notEqual(copy.operatorMessage(text), text);
    assert.equal(copy.bingoMessage(text), copy.bingoMessage(copy.bingoMessage(text)), `${text} stays translated`);
    assert.doesNotMatch(copy.bingoMessage(text), /línea/i, `${text} does not send the operator to the line`);
  }
  assert.match(copy.bingoMessage('Could not confirm the Bingo declaration. Keep this setup open and check the state later.'),
    /No lo declares de nuevo/);
  assert.match(copy.bingoMessage('Could not confirm legacy Bingo recovery. Check the state later.'), /«Releer comprobación de bingo»/);
});

test('bingoMessage keeps the shared table, overrides only line-specific wording and falls back like operatorMessage', () => {
  assert.equal(copy.bingoMessage('Wait for Tongo to finish, then try again.'), operatorMessage('Wait for Tongo to finish, then try again.'));
  assert.match(operatorMessage('Could not read the clock. Try again.') as string, /Pulsa «Línea» para comprobar el estado y reintentar/, 'Line copy names the visible button');
  assert.match(copy.bingoMessage('Could not read the clock. Try again.'), /reloj[\s\S]*bingo/);
  assert.equal(copy.bingoMessage('Write failed: ENOENT'), UNKNOWN_ERROR_ES);
  assert.equal(copy.bingoMessage(null), null);
  assert.equal(copy.bingoMessage(''), '');
});

test('the Bingo prize summary is distinct from the line one and covers money, lot, both and neither', () => {
  assert.equal(copy.bingoPrizeSummary({ amount: 50, lot: 'Jamón' }), 'Premio de bingo configurado: 50 € + lote «Jamón».');
  assert.equal(copy.bingoPrizeSummary({ amount: 1500, lot: '' }), 'Premio de bingo configurado: 1.500 €.');
  assert.equal(copy.bingoPrizeSummary({ amount: 0, lot: 'Cesta' }), 'Premio de bingo configurado: lote «Cesta».');
  assert.equal(copy.bingoPrizeSummary({ amount: 0, lot: '' }), 'Premio de bingo configurado: sin premio.');
  assert.equal(copy.linePrizeSummary({ amount: 50, lot: 'Jamón' }), 'Premio de línea configurado: 50 € + lote «Jamón».');
});

const bingoAward = { winnerCount: 3, totalCents: 1000, shareCents: 333, remainderCents: 1, lot: 'Jamón', lotResolution: 'pending' };
const bingoFor = (status: unknown, award: Record<string, unknown> = bingoAward) =>
  copy.bingoAwardSummary({ award, presentation: { id: 'p', status } });

test('each Bingo presentation status is truthful, keeps money and lot, and never unlocks drawing or finishes', () => {
  for (const status of ['pending', 'started', 'failed', 'interrupted', 'completed']) {
    const text = bingoFor(status);
    assert.match(text, /^Bingo cantado con 3 ganadores\./, status);
    assert.match(text, /Premio: 10,00 €, 3,33 € cada uno\. Sobra 1 céntimo sin asignar\./, status);
    assert.match(text, /Lote «Jamón»: pendiente de resolver entre los ganadores\./, status);
    assert.match(text, /no se cantan más números/, status);
    assert.doesNotMatch(text, /seguir cantando|ya puedes|desbloque|partida terminada|termina sola|línea/i, status);
  }
  assert.match(bingoFor('pending'), /todavía no muestra la celebración del bingo/);
  assert.match(bingoFor('started'), /en marcha/);
  assert.match(bingoFor('failed'), /no pudo mostrarse[\s\S]*«Reintentar celebración»/);
  assert.match(bingoFor('interrupted'), /interrumpida[\s\S]*«Repetir celebración completa»/);
  assert.match(bingoFor('completed'), /celebración pública del bingo terminó[\s\S]*El lote sigue pendiente de resolver\./);
  for (const status of ['pending', 'started', 'failed', 'interrupted', 'mystery', undefined]) {
    assert.doesNotMatch(bingoFor(status), /terminó/, `${String(status)} never claims completion`);
  }
  assert.equal(bingoFor('mystery'), bingoFor('pending'), 'unknown status falls back to not shown yet');
});

test('Bingo award money and lot variants: one winner, no remainder, plural remainder, resolved, no prize', () => {
  const one = bingoFor('completed', { winnerCount: 1, totalCents: 5000, shareCents: 5000, remainderCents: 0, lot: '', lotResolution: 'not_required' });
  assert.match(one, /^Bingo cantado con 1 ganador\. Premio: 50,00 €\. La celebración/);
  assert.doesNotMatch(one, /cada uno|Sobra|Lote|pendiente/);
  const two = bingoFor('started', { winnerCount: 4, totalCents: 1002, shareCents: 250, remainderCents: 2, lot: 'Cesta', lotResolution: 'resolved' });
  assert.match(two, /Premio: 10,02 €, 2,50 € cada uno\. Sobran 2 céntimos sin asignar\. Lote «Cesta»\./);
  assert.doesNotMatch(bingoFor('completed', { ...bingoAward, lotResolution: 'resolved' }), /pendiente/);
  const none = bingoFor('completed', { winnerCount: 2, totalCents: 0, shareCents: 0, remainderCents: 0, lot: '', lotResolution: 'not_required' });
  assert.doesNotMatch(none, /Premio|€|Lote/);
  assert.match(copy.BINGO_REFRESH_FAILED_ES, /no se pudo releer el evento[\s\S]*«Recargar evento»/);
  assert.doesNotMatch(copy.BINGO_REFRESH_FAILED_ES, /seguir cantando/);
});

test('legacy Bingo recovery copy names its actions, returns to Línea cantada and never claims a Bingo or drawing', () => {
  const text = copy.BINGO_LEGACY_ES;
  assert.equal(text.action, 'Cancelar comprobación de bingo');
  assert.equal(text.reread, 'Releer comprobación de bingo');
  assert.equal(text.retryRefresh, 'Reintentar lectura del evento');
  assert.equal(text.back, 'Volver');
  assert.match(text.confirm, /«Línea cantada»/);
  assert.match(text.dialog, /línea declarada[\s\S]*números cantados[\s\S]*premios[\s\S]*no se declarará ningún bingo/);
  for (const key of ['available', 'uncertain', 'recovered', 'refreshPending', 'refreshFailed']) assert.ok(text[key], key);
  assert.match(text.uncertain, /«Releer comprobación de bingo»/);
  assert.match(text.refreshFailed, /«Reintentar lectura del evento»/);
  assert.doesNotMatch(Object.values(text).join(' '), /Bingo cantado|bingo declarado|ganador|cantar números|seguir cantando/i);
  assert.notDeepEqual(Object.values(text), Object.values(copy.LEGACY_CHECK_ES));
});

// The reason the page shows when a Bingo is uncertain but still holds a running celebration. Its wording is a
// contract with the operator: it must say why the page stays locked, name the read that confirms the state, and
// never promise a release a non-confirming answer cannot give.
test('the uncertain held-celebration reason explains the lock and names the confirming read without promising a release', () => {
  assert.equal(typeof copy.BINGO_UNCERTAIN_LIVE_ES, 'string', 'the reason exists');
  assert.match(copy.BINGO_UNCERTAIN_LIVE_ES, /celebraci[oó]n puede seguir en marcha/, 'it says the celebration may still run');
  assert.match(copy.BINGO_UNCERTAIN_LIVE_ES, /bloqueada/, 'it says the page stays locked');
  assert.match(copy.BINGO_UNCERTAIN_LIVE_ES, /«Comprobar bingo»/, 'it names the control that reads the state');
  assert.doesNotMatch(copy.BINGO_UNCERTAIN_LIVE_ES, /l[ií]nea/i, 'a Bingo reason never sends the operator to the line');
  assert.doesNotMatch(copy.BINGO_UNCERTAIN_LIVE_ES, /recarga|recargar/i, 'reload cannot clear a held award, so it is never offered');
  assert.doesNotMatch(copy.BINGO_UNCERTAIN_LIVE_ES, /se libera|desbloquea|ya puedes/i, 'it never promises the page is freed');
});
