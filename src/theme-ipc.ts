import { DEFAULT_THEME, isThemeId, type ThemeId } from './theme.ts';

export const THEME_CHANNELS = Object.freeze({ get: 'theme:get', set: 'theme:set' });

export type ThemeResult =
  | { ok: true; theme: ThemeId }
  | { ok: false; code: 'invalid_request' | 'storage_failure'; message: string };

type ThemeRequest = { sender: unknown; senderFrame: unknown };
type ThemeStore = { load(): ThemeId; save(theme: ThemeId): ThemeId };
type Registrar = {
  handle(channel: string, handler: (event: ThemeRequest, ...args: unknown[]) => ThemeResult): void;
};

export function registerThemeIpc(
  registrar: Registrar, store: ThemeStore, authorize: (event: ThemeRequest) => void,
  notifyCommitted?: (theme: ThemeId) => void,
) {
  // An unreadable setting renders the default without overwriting what is stored.
  let committed: ThemeId;
  const reload = (): ThemeId => {
    try { committed = store.load(); } catch { committed = DEFAULT_THEME; }
    return committed;
  };
  reload();

  registrar.handle(THEME_CHANNELS.get, (event, ...args) => {
    authorize(event);
    if (args.length !== 0) return { ok: false, code: 'invalid_request', message: 'Invalid theme request.' };
    return { ok: true, theme: committed };
  });
  registrar.handle(THEME_CHANNELS.set, (event, ...args) => {
    authorize(event);
    if (args.length !== 1 || !isThemeId(args[0])) {
      return { ok: false, code: 'invalid_request', message: 'Invalid theme request.' };
    }
    let saved: ThemeId;
    try { saved = store.save(args[0]); }
    catch { return { ok: false, code: 'storage_failure', message: 'Could not save the theme. Try again.' }; }
    committed = saved;
    try { notifyCommitted?.(saved); }
    catch { /* Delivery is best effort after persistence commits. */ }
    return { ok: true, theme: saved };
  });
  // reload() re-reads the setting after the active event (and so its theme) changes.
  return { current: (): ThemeId => committed, reload };
}
