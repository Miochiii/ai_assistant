/**
 * Speech event bus, modeled on dsh-see-now's speech.js.
 *
 * Core code only emits events; it never bundles or calls a TTS engine. A future
 * voice adapter subscribes with onSpeech(), starts audio, then emits 'spoken'
 * (or 'skipped'). With no subscribers, speaking is a no-op.
 */
const subscribers = new Map();
let seq = 0;
let lastEvent = null;

function normalizeState(value) {
  if (value === 'scheduled' || value === 'spoken' || value === 'skipped') return value;
  return 'due';
}

export function onSpeech(handler, { voice = true } = {}) {
  if (typeof handler !== 'function') throw new TypeError('onSpeech(handler) needs a function');
  subscribers.set(handler, { voice: Boolean(voice) });
  return () => subscribers.delete(handler);
}

export function speechSubscribers() {
  let count = 0;
  for (const item of subscribers.values()) if (item.voice) count += 1;
  return count;
}

export function emitSpeech(event) {
  if (subscribers.size === 0) return 0;
  seq += 1;
  const payload = Object.freeze({
    seq,
    at: Number.isFinite(event?.at) ? Number(event.at) : null,
    text: String(event?.text ?? ''),
    state: normalizeState(event?.state),
    ...(event?.origin ? { origin: String(event.origin) } : {}),
  });
  lastEvent = { ...payload, emittedAt: Date.now() };
  let delivered = 0;
  for (const handler of [...subscribers.keys()]) {
    try {
      handler(payload);
      delivered += 1;
    } catch { /* one bad voice adapter must not stop the assistant */ }
  }
  return delivered;
}

export function emitSpoken(event) {
  return emitSpeech({ ...event, state: 'spoken' });
}

export function lastSpeech() {
  return lastEvent;
}

export function __resetSpeech() {
  subscribers.clear();
  lastEvent = null;
  seq = 0;
}

/**
 * Small host-facing port. It emits a 'due' event and returns whether any
 * voice subscriber accepted it. It does not wait for audio and never throws.
 */
export class SpeechPort {
  constructor({ bus = { emitSpeech, speechSubscribers, lastSpeech } } = {}) {
    this.bus = bus;
  }

  speak(text, { at = null, origin = 'assistant' } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return { delivered: 0, state: 'empty' };
    try {
      const delivered = this.bus.emitSpeech({
        text: value.slice(0, 4000), at, state: 'due', origin,
      });
      return { delivered, state: delivered > 0 ? 'due' : 'unvoiced' };
    } catch {
      return { delivered: 0, state: 'error' };
    }
  }

  status() {
    try {
      return { subscribers: this.bus.speechSubscribers?.() ?? 0, last: this.bus.lastSpeech?.() ?? null };
    } catch {
      return { subscribers: 0, last: null };
    }
  }
}

export function createSpeechPort(options) {
  return new SpeechPort(options);
}
