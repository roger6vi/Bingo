import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MESSAGES_ES, operatorMessage, PHASE_LABELS_ES, THEME_NAMES_ES, UNKNOWN_ERROR_ES } from '../src/operator-copy.mjs';
import { THEME_LABELS } from '../src/theme-controller.mjs';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Every English message the operator can receive, from the main process or its own controllers.
const sources = ['src/event-ipc.ts', 'src/theme-ipc.ts', 'src/event-catalog-ipc.ts',
  'src/operator-controller.mjs', 'src/events-controller.mjs', 'src/theme-controller.mjs'];

test('every English operator-facing message has a Spanish translation', () => {
  const english = new Set<string>();
  for (const file of sources) {
    for (const [, text] of source(file).matchAll(/'((?:Could not|Invalid|No current|All numbers|That number|The event)[^']*)'/g)) {
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
