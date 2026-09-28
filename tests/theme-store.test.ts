import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { THEME_IDS } from '../src/theme.ts';
import { createThemeStore } from '../src/theme-store.ts';

function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'bingo-theme-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'theme.sqlite');
}

test('allow-list matches the generated semantic token themes', () => {
  const themes = fs.readdirSync(new URL('../tokens/semantic/', import.meta.url))
    .map((file) => file.replace(/\.json$/, '')).sort();
  assert.deepEqual([...THEME_IDS].sort(), themes);
});

test('defaults to pixel-classic and recovers each registered theme after reopening', (t) => {
  const path = fixture(t);
  const initial = createThemeStore(path);
  try { assert.equal(initial.load(), 'pixel-classic'); } finally { initial.close(); }
  for (const theme of ['high-contrast', 'pixel-classic'] as const) {
    const store = createThemeStore(path);
    try {
      assert.equal(store.save(theme), theme);
    } finally { store.close(); }
    const reopened = createThemeStore(path);
    try { assert.equal(reopened.load(), theme); } finally { reopened.close(); }
  }
});

test('rejects CSS, URLs, paths, unknown names and non-strings without writing', (t) => {
  const store = createThemeStore(fixture(t));
  t.after(() => store.close());
  store.save('high-contrast');
  for (const value of ['body{color:red}', 'https://example.com/theme.css', '../generated/high-contrast.css',
    '/etc/passwd', 'High-Contrast', 'dark', '', ' pixel-classic', null, 1, { theme: 'pixel-classic' }]) {
    assert.throws(() => store.save(value), /Unknown theme/);
  }
  assert.equal(store.load(), 'high-contrast');
});

test('a failed write preserves the last committed theme', (t) => {
  const path = fixture(t);
  const store = createThemeStore(path);
  t.after(() => store.close());
  store.save('high-contrast');
  const other = new DatabaseSync(path);
  other.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => store.save('pixel-classic'), /locked|busy/i); }
  finally { other.exec('ROLLBACK'); other.close(); }
  assert.equal(store.load(), 'high-contrast');
});

test('tampered or unknown stored values are rejected rather than applied', (t) => {
  const path = fixture(t);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE theme_setting (id INTEGER PRIMARY KEY, theme TEXT NOT NULL); INSERT INTO theme_setting VALUES (1, 'url(evil)')");
  db.close();
  assert.throws(() => createThemeStore(path), /Invalid theme setting/);
});
