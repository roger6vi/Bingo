import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_THEME, THEME_IDS, isThemeId, type ThemeId } from './theme.ts';

const table = `CREATE TABLE IF NOT EXISTS theme_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL CHECK (theme IN (${THEME_IDS.map((theme) => `'${theme}'`).join(', ')}))
)`;

export function createThemeStore(path: string) {
  const db = new DatabaseSync(path);

  function read(): ThemeId {
    const rows = db.prepare('SELECT id, theme FROM theme_setting').all();
    if (rows.length === 0) return DEFAULT_THEME;
    if (rows.length !== 1 || rows[0].id !== 1 || !isThemeId(rows[0].theme)) {
      throw new Error('Invalid theme setting');
    }
    return rows[0].theme;
  }

  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec(table);
    read();
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    load(): ThemeId { return read(); },
    // Returns the value read back inside the committing transaction.
    save(theme: unknown): ThemeId {
      if (!isThemeId(theme)) throw new Error('Unknown theme');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO theme_setting (id, theme) VALUES (1, ?)
          ON CONFLICT (id) DO UPDATE SET theme = excluded.theme`).run(theme);
        const committed = read();
        db.exec('COMMIT');
        return committed;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
        throw error;
      }
    },
    close(): void { db.close(); },
  };
}
