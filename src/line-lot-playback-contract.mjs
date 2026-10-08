import { validLineAward } from './public-controller.mjs';

// Pure payload contracts for line-lot playback: no DOM, media, IPC, store or persistence.
// Signal ids are opaque transient UUIDs, never a durable presentation identity.
const colors = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange']);
const SIGNAL = ['colorId', 'id', 'participantNumber'];

// Own enumerable data properties only: descriptors are read, so no getter result is trusted. Hostile proxies whose
// traps throw are rejected (null); traps may still run, only their failure is contained.
export function dataCopy(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(own);
    if (keys !== null && (names.length !== keys.length || !keys.every((key) => Object.hasOwn(own, key)))) return null;
    const copy = {};
    for (const name of names) {
      if (typeof name !== 'string' || !('value' in own[name]) || own[name].enumerable !== true) return null;
      // defineProperty keeps an own "__proto__" as data instead of invoking the prototype setter.
      Object.defineProperty(copy, name, { value: own[name].value, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } catch {
    return null;
  }
}

// Known winner of a fully valid award: winner is null when none is stored; undefined when the award is invalid.
export function knownWinner(award) {
  try {
    const root = dataCopy(award, null);
    const result = root === null || root.lotResult === undefined ? undefined : dataCopy(root.lotResult, null);
    if (root === null || result === null || !validLineAward({ ...root, lotResult: result })) return undefined;
    const winner = result?.origin === 'numbered_v1' ? { participantNumber: result.participantNumber, colorId: result.colorId } : null;
    return { eventId: root.eventId, winner };
  } catch {
    return undefined;
  }
}

// Structural validity only: matching the confirmed winner is the playback's job.
export function validSignal(value) {
  const s = dataCopy(value, SIGNAL);
  return s !== null && typeof s.id === 'string' && s.id !== '' && s.id.length <= 128 && Number.isSafeInteger(s.participantNumber) &&
    s.participantNumber >= 1 && colors.has(s.colorId) ? s : null;
}

export const sameWinner = (a, b) => a === b || (a !== null && b !== null && a.participantNumber === b.participantNumber && a.colorId === b.colorId);
