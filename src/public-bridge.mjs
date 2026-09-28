// The public page's receive-only inputs. In the public window they are the sandboxed preload's
// subscriptions. Framed as the operator's simulator (no preload), the same page instead receives
// display-only messages from its parent frame; it never gains a way to send or write anything.
export const SIMULATOR_MESSAGE = 'bingo-public-simulator';
const CHANNELS = ['event', 'theme', 'meta'];

function frameBridges(win) {
  const listeners = Object.fromEntries(CHANNELS.map((channel) => [channel, new Set()]));
  win.addEventListener('message', (message) => {
    const data = message.data;
    if (message.source !== win.parent || data === null || typeof data !== 'object' ||
        data.type !== SIMULATOR_MESSAGE || !CHANNELS.includes(data.channel)) return;
    for (const callback of listeners[data.channel]) callback(data.payload);
  });
  const channel = (name) => Object.freeze({ subscribe: (callback) => {
    listeners[name].add(callback);
    return () => listeners[name].delete(callback);
  } });
  return { event: channel('event'), theme: channel('theme'), meta: channel('meta') };
}

export function publicBridges(win = window) {
  if (win.publicEvent && win.publicTheme && win.publicEventMeta) {
    return { event: win.publicEvent, theme: win.publicTheme, meta: win.publicEventMeta };
  }
  if (win.parent !== win) return frameBridges(win);
  throw new Error('Missing public display bridge');
}

// Committed (or, in the simulator, drafted) event metadata; anything else shows the generic heading.
export function validEventMeta(meta) {
  const text = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 120;
  return meta !== null && typeof meta === 'object' && text(meta.name) && text(meta.place) &&
    typeof meta.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.date);
}

// Operator side: mirrors the latest display state into the simulator frame after every (re)load.
export function createSimulatorFeed(frame) {
  const latest = { theme: undefined, meta: undefined, event: undefined };
  const post = (channel) => {
    if (latest[channel] === undefined) return;
    // The frame is the bundled public page from file://, whose origin is opaque, so no narrower target
    // origin exists; the payload is display-only state that the public screen shows anyway.
    frame.contentWindow?.postMessage({ type: SIMULATOR_MESSAGE, channel, payload: latest[channel] }, '*');
  };
  // Theme first, then metadata, then state: the same reveal order as the public window.
  const flush = () => { for (const channel of ['theme', 'meta', 'event']) post(channel); };
  frame.addEventListener('load', flush);
  return {
    update(next) {
      for (const channel of ['theme', 'meta', 'event']) {
        if (!(channel in next)) continue;
        latest[channel] = structuredClone(next[channel]);
        post(channel);
      }
    },
  };
}
