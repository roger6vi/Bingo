import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fields = ['text-field', 'date-field', 'select-field'];
const names = [...fields, 'form-actions'];

test('shared form components register exactly once and consume only semantic styling', () => {
  for (const name of [...names, 'field', 'button']) {
    const code = source(`src/components/bingo-${name}.mjs`);
    assert.match(code, /from ['"]lit['"]/);
    assert.doesNotMatch(code, /\bwindow\b|\b(?:ipcRenderer|desktop|localStorage|sessionStorage)\b|#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(|--bingo-reference-|--bingo-(?:component|field|button|form)-/i, name);
    assert.doesNotMatch(code, /\b(?:white|black|red|blue|yellow|transparent)\b(?![-\w])/i, `${name} uses named colors`);
  }
  for (const name of names) {
    const code = source(`src/components/bingo-${name}.mjs`);
    assert.match(code, new RegExp(`customElements\\.define\\(['"]bingo-${name}['"]`));
    assert.equal([...code.matchAll(/customElements\.define\(/g)].length, 1, name);
  }
  assert.doesNotMatch(source('src/components/bingo-field.mjs'), /customElements\.define\(/, 'the shared base is not an element');
});

test('fields are form-associated with label, hint, announced error and state wiring', () => {
  const base = source('src/components/bingo-field.mjs');
  assert.match(base, /static formAssociated = true/);
  assert.match(base, /this\.attachInternals\(\)/);
  assert.match(base, /delegatesFocus: true/);
  assert.match(base, /<label for="control">/);
  assert.match(base, /id="error"[^>]*aria-live="polite"/);
  assert.match(base, /setValidity\(\{ customError: true \}/);
  assert.match(base, /setFormValue\(this\.value\)/);
  assert.match(base, /formResetCallback\(\)/);
  for (const name of fields) {
    const code = source(`src/components/bingo-${name}.mjs`);
    assert.match(code, /extends BingoField/);
    assert.match(code, /id="control"/);
    assert.match(code, /aria-invalid=\$\{this\.error \? 'true' : 'false'\}/);
    assert.match(code, /aria-describedby=\$\{this\.describedBy\(\)\}/);
    assert.match(code, /aria-busy=\$\{this\.pending/);
  }
  const button = source('src/components/bingo-button.mjs');
  assert.match(button, /static formAssociated = true/);
  assert.match(button, /requestSubmit\(\)/);
});

test('operator forms use only the shared controls and keep every control ID', () => {
  const page = source('src/operator.html');
  assert.doesNotMatch(page, /<(?:select|textarea)\b/, 'no raw select or textarea controls');
  for (const form of page.match(/<form\b[\s\S]*?<\/form>/g) ?? []) {
    assert.doesNotMatch(form, /<input\b/, 'no raw text or date fields in event forms');
    assert.doesNotMatch(form, /<button\b/, 'no raw form buttons');
  }
  // The Bingo side rail has native cue controls (mute checkbox, volume range); they are not event form fields.
  assert.match(page, /<input type="checkbox" id="cue-mute"[^>]*>/);
  assert.match(page, /<input id="cue-volume" type="range"/);
  for (const [tag, id] of [['text-field', 'event-name'], ['text-field', 'event-place'], ['date-field', 'event-date'],
    ['text-field', 'settings-name'], ['text-field', 'settings-place'], ['date-field', 'settings-date'],
    ['select-field', 'theme-select'], ['button', 'create-event-submit'], ['button', 'settings-save'], ['button', 'settings-discard']]) {
    assert.match(page, new RegExp(`<bingo-${tag} [^>]*id="${id}"`), id);
  }
  assert.match(page, /<form id="create-event" class="event-form">/);
  assert.match(page, /<form id="settings-form" class="settings-controls" novalidate>/);
  assert.equal([...page.matchAll(/<bingo-form-actions\b/g)].length, 2);
  const ui = source('src/operator-ui.mjs');
  for (const name of names) assert.ok(ui.includes(`./components/bingo-${name}.mjs`), name);
});
