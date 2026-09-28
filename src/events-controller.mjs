// Only a validated IPC acknowledgement may replace the displayed event list.
const connectionError = 'Could not connect to the events. Reload and try again.';
const invalidUpdate = 'Invalid events update. Reload and try again.';
const phases = new Set(['drawing', 'checking_line', 'line_declared', 'checking_bingo', 'bingo_declared', 'finished']);
const text = (value) => typeof value === 'string' && value.trim() !== '';

export function validEvents(events) {
  if (!Array.isArray(events)) return false;
  const ids = new Set(events.map((event) => event?.id));
  return ids.size === events.length && events.filter((event) => event?.active === true).length <= 1 &&
    events.every((event) => event !== null && typeof event === 'object' && text(event.id) && text(event.name) &&
      text(event.place) && /^\d{4}-\d{2}-\d{2}$/.test(event.date) && phases.has(event.phase) &&
      typeof event.active === 'boolean');
}

// Local calendar date, the default for a new event.
export function today(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function createEventsController(api, view, onSelected) {
  let events = [];
  let loaded = false;
  let pending = null;
  let stale = false;
  let error = null;

  const render = () => view.render({ events: events.map((event) => ({ ...event })), loaded, pending, stale, error,
    active: events.find((event) => event.active) ?? null });

  // Outcome: 'accepted', 'rejected', 'committed' (selected or created but the list was unreadable),
  // 'unknown' (the request never acknowledged), or 'skipped' (another request was pending).
  async function request(kind, operation) {
    if (pending !== null) return 'skipped';
    pending = kind;
    render();
    let outcome = 'rejected';
    try {
      const result = await operation();
      if (result?.ok === true && validEvents(result.events)) {
        events = result.events.map((event) => ({ ...event }));
        loaded = true;
        stale = false;
        error = null;
        outcome = 'accepted';
      } else {
        stale = loaded;
        error = result?.ok === false && typeof result.message === 'string' ? result.message : invalidUpdate;
        // From the select and update channels, ok:true means the write committed even if the list is unusable.
        if (((kind === 'select' || kind === 'update') && result?.ok === true) || (result?.ok === false &&
            (result.selected === true || (kind === 'create' && result.created === true) ||
             (kind === 'update' && result.updated === true)))) {
          outcome = 'committed';
        }
      }
    } catch {
      stale = loaded;
      error = connectionError;
      outcome = 'unknown';
    } finally {
      pending = null;
      render();
    }
    return outcome;
  }

  return {
    start: async () => (await request('list', () => api.listEvents())) === 'accepted',
    // A committed create must not look failed, or the operator would submit the form again.
    create: async (meta) => ['accepted', 'committed'].includes(await request('create', () => api.createEvent(meta))),
    // Resolves true only for an acknowledged commit, so an unsaved draft is never reported as saved.
    update: async (id, meta) => ['accepted', 'committed'].includes(await request('update', () => api.updateEvent(id, meta))),
    // Dependent panels re-read committed state whenever the active event may have changed:
    // an acknowledged selection, one that committed without a readable list, or one with no answer.
    select: async (id) => {
      if (events.find((event) => event.id === id)?.active === true) return false;
      const outcome = await request('select', () => api.selectEvent(id));
      if (outcome === 'accepted' || outcome === 'committed' || outcome === 'unknown') await onSelected();
      return outcome === 'accepted';
    },
  };
}
