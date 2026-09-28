// Only allow-listed theme ids reach the document; keep aligned with src/theme.ts.
export const THEME_LABELS = Object.freeze({ 'pixel-classic': 'Pixel classic', 'high-contrast': 'High contrast' });
export const DEFAULT_THEME = 'pixel-classic';
export const validTheme = (theme) => typeof theme === 'string' && Object.hasOwn(THEME_LABELS, theme);

export function applyTheme(root, theme) {
  if (!validTheme(theme)) return false;
  root.dataset.theme = theme;
  return true;
}

// screen.css hides the page until a theme is applied; never leave it hidden if delivery fails.
export function revealAfter(root, delay, schedule = setTimeout) {
  return schedule(() => { if (!validTheme(root.dataset.theme)) applyTheme(root, DEFAULT_THEME); }, delay);
}

export function createThemeController(api, view) {
  let theme = null;
  let pending = false;
  let error = null;
  const render = () => view.render({ theme, pending, error });

  let inFlight = Promise.resolve();
  let readQueued = null;
  function request(operation) {
    if (pending) return undefined;
    inFlight = run(operation);
    return inFlight;
  }
  // A read requested while another request is pending (e.g. after an event switch) must not be
  // dropped: queue exactly one fresh read after the in-flight request settles.
  function read() {
    if (!pending) return request(() => api.getTheme());
    readQueued ??= inFlight.then(() => { readQueued = null; return read(); });
    return readQueued;
  }

  async function run(operation) {
    pending = true;
    render();
    try {
      const result = await operation();
      if (result?.ok === true && validTheme(result.theme)) {
        theme = result.theme;
        error = null;
      } else {
        error = result?.ok === false && typeof result.message === 'string' ? result.message : 'Invalid theme update.';
      }
    } catch {
      error = 'Could not connect to theme settings. Try again.';
    } finally {
      pending = false;
      render();
    }
  }

  render();
  return {
    start: read,
    select: (next) => (validTheme(next) && next !== theme ? request(() => api.setTheme(next)) : undefined),
  };
}
