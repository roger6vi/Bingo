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
  assert.match(operatorMessage(message), /Comprobar línea/);
});
