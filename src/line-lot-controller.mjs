// Browser-compatible renderer controller for line lots. It only talks to the injected preload API, never
// publishes events or celebrates, and keeps lot failures out of ordinary event state.
// The ids mirror LINE_LOT_PALETTE v1 (src/line-lot-contract.ts); tests cross-check them.
const COLORS = Object.freeze(['red', 'blue', 'green', 'yellow', 'purple', 'orange']);
const PRESENTATION = ['pending', 'started', 'completed', 'failed', 'interrupted'];
const KINDS = ['current', 'committed', 'recovered'];

const isInt = (v) => Number.isSafeInteger(v) && v > 0;
const text = (v) => typeof v === 'string' && v !== '';

// Plain own enumerable data only: no accessors, symbols, inherited or unexpected keys.
function plain(v, keys, optional = []) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.getOwnPropertySymbols(v).length) return null;
  const out = {};
  const names = Object.getOwnPropertyNames(v);
  for (const k of names) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d.enumerable || !('value' in d) || !(keys.includes(k) || optional.includes(k))) return null;
    out[k] = d.value;
  }
  return keys.every((k) => names.includes(k)) ? out : null;
}

function validSnapshot(raw) {
  const s = plain(raw, ['eventId', 'auditSequence', 'winnerCount', 'lot', 'presentation', 'fact']);
  const p = s && plain(s.presentation, ['id', 'status']);
  if (!s || !p || !text(s.eventId) || !isInt(s.auditSequence) || !isInt(s.winnerCount) || typeof s.lot !== 'string'
    || !text(p.id) || !PRESENTATION.includes(p.status)) return null;
  const base = plain(s.fact, ['origin', 'resolution'], ['paletteVersion', 'participantNumber', 'colorId', 'winner']);
  if (!base) return null;
  let fact;
  if (base.origin === 'none') {
    const f = plain(s.fact, ['origin', 'resolution']);
    if (!f || (f.resolution !== 'pending' && f.resolution !== 'not_required')) return null;
    if ((f.resolution === 'pending') !== (s.winnerCount > 1 && s.lot !== '')) return null; // pending iff tied with a lot
    fact = { origin: 'none', resolution: f.resolution };
  } else if (base.origin === 'numbered_v1') {
    const f = plain(s.fact, ['origin', 'resolution', 'paletteVersion', 'participantNumber', 'colorId']);
    if (!f || f.resolution !== 'resolved' || f.paletteVersion !== 1 || !isInt(f.participantNumber)
      || f.participantNumber > s.winnerCount || s.winnerCount < 2 || s.lot === '' || p.status !== 'completed'
      || f.colorId !== COLORS[(f.participantNumber - 1) % COLORS.length]) return null;
    fact = { origin: 'numbered_v1', resolution: 'resolved', paletteVersion: 1, participantNumber: f.participantNumber, colorId: f.colorId };
  } else if (base.origin === 'legacy_v8') {
    const f = plain(s.fact, ['origin', 'resolution', 'winner']);
    if (!f || f.resolution !== 'resolved' || f.winner !== 'unknown' || s.winnerCount < 2 || s.lot === '') return null;
    fact = { origin: 'legacy_v8', resolution: 'resolved', winner: 'unknown' };
  } else return null;
  return Object.freeze({ eventId: s.eventId, auditSequence: s.auditSequence, winnerCount: s.winnerCount, lot: s.lot,
    presentation: Object.freeze({ id: p.id, status: p.status }), fact: Object.freeze(fact) });
}

// -> { ok: true, kind, snapshot } | { ok: false, code } | null (malformed)
function validReply(raw) {
  const r = plain(raw, ['ok'], ['kind', 'snapshot', 'code', 'message']);
  if (!r) return null;
  if (r.ok === false) return typeof r.code === 'string' && !('kind' in r) && !('snapshot' in r) ? { ok: false, code: r.code } : null;
  const full = plain(raw, ['ok', 'kind', 'snapshot']);
  const snapshot = full && r.ok === true && KINDS.includes(full.kind) ? validSnapshot(full.snapshot) : null;
  return snapshot ? { ok: true, kind: full.kind, snapshot } : null;
}

const winnerOf = (snap) => {
  if (!snap || snap.fact.resolution !== 'resolved') return null;
  return snap.fact.origin === 'legacy_v8' ? Object.freeze({ kind: 'unknown' })
    : Object.freeze({ kind: 'number', participantNumber: snap.fact.participantNumber, colorId: snap.fact.colorId });
};

export function createLineLotController(api, view = {}, hooks = {}) {
  let ctx = null; let snapshot = null; let source = null; let message = null; let error = false;
  let locked = false; let reading = false; let drawing = false; let drawInFlight = false;
  let disposed = false; let gen = 0; let readSeq = 0; let cached = null;

  const eligible = () => !!snapshot && snapshot.fact.resolution === 'pending' && snapshot.presentation.status === 'completed'
    && snapshot.winnerCount > 1 && snapshot.lot !== '';
  const canDraw = () => !disposed && !!ctx && !locked && !drawing && !drawInFlight && !ctx.busy && !ctx.tongoPlaying && eligible();

  function compute() {
    let status;
    if (!ctx) status = 'unknown';
    else if (drawing) status = 'pending';
    else if (reading && !snapshot) status = 'loading';
    else if (locked) status = 'recovery';
    else if (!snapshot) status = error ? 'error' : 'unknown';
    else if (snapshot.fact.resolution !== 'pending') status = 'resolved';
    else status = canDraw() ? 'actionable' : 'pending';
    return Object.freeze({ status, source, winner: winnerOf(snapshot), busy: drawing, canDraw: canDraw(), snapshot, message });
  }
  function getState() { return cached ?? (cached = compute()); }
  function emit() {
    cached = null;
    if (disposed) return;
    try { view.render?.(getState()); } catch { /* a renderer failure must not corrupt lot state */ }
  }
  function lock(text) { snapshot = null; source = null; locked = true; error = false; message = text; }
  function apply(next, kind) {
    const cur = snapshot;
    const stale = cur && cur.fact.resolution === 'resolved' && cur.eventId === next.eventId
      && (next.auditSequence <= cur.auditSequence || next.presentation.id === cur.presentation.id);
    locked = false; error = false; message = null;
    if (stale) return false;
    snapshot = next; source = kind;
    return true;
  }
  function reset(next) {
    gen++; snapshot = null; source = null; message = null; error = false; locked = false; reading = false; drawing = false;
    ctx = next;
  }

  async function read() {
    if (disposed || !ctx) return;
    const g = gen; const seq = ++readSeq; reading = true; emit();
    let reply = null;
    try { reply = validReply(await api.readLineLot()); } catch { reply = null; }
    if (disposed || g !== gen || seq !== readSeq) return;
    reading = false;
    if (reply?.ok && reply.snapshot.eventId === ctx.eventId) apply(reply.snapshot, reply.kind);
    else if (reply && !reply.ok && reply.code === 'not_available' && !snapshot && !locked) { error = true; message = 'Lot unavailable.'; }
    else if (reply && !reply.ok && snapshot && !locked && reply.code !== 'storage_failure' && reply.code !== 'read_required') { /* keep what is known */ }
    else lock('Lot state needs a fresh read.');
    emit();
  }

  async function draw() {
    if (disposed || drawInFlight || !canDraw()) return; // synchronous guards: nothing speculative before the ack
    const id = { eventId: snapshot.eventId, auditSequence: snapshot.auditSequence, presentationId: snapshot.presentation.id };
    const g = gen; drawInFlight = true; drawing = true; emit();
    let reply = null;
    try { reply = validReply(await api.drawLineLot(id)); } catch { reply = null; }
    drawInFlight = false;
    if (disposed || g !== gen) { if (!disposed) emit(); return; }
    drawing = false;
    if (locked) { emit(); return; } // a read-required recovery set during the await outlives this late ack
    const snap = reply?.ok ? reply.snapshot : null;
    const same = snap && snap.eventId === id.eventId && snap.auditSequence === id.auditSequence && snap.presentation.id === id.presentationId;
    if (!same || (reply.kind === 'committed' && snap.fact.origin !== 'numbered_v1')) {
      lock('Draw result uncertain; read the lot to continue.');
    } else {
      if (apply(snap, reply.kind) && reply.kind === 'committed') { try { hooks.onCommitted?.(snapshot); } catch { /* hook errors are not lot errors */ } }
    }
    emit();
  }

  return {
    getState,
    setContext(raw) {
      if (disposed) return;
      const c = plain(raw, ['eventId'], ['busy', 'tongoPlaying', 'drawBlocked', 'liveBlocked']);
      const next = c && text(c.eventId) ? Object.freeze({ eventId: c.eventId, busy: c.busy === true, tongoPlaying: c.tongoPlaying === true }) : null;
      const switched = !!ctx && (!next || next.eventId !== ctx.eventId);
      if (switched) reset(next); else ctx = next;
      emit();
      if (switched && next) read();
    },
    start() { return read(); },
    resync() { return drawing ? Promise.resolve() : read(); },
    draw,
    dispose() { disposed = true; gen++; },
  };
}
