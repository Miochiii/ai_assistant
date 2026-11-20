/**
 * Low-rate mss observation loop for RH04.
 *
 * One capture at a time, no overlapping calls, no model and no input. The loop
 * is created only when the Host is explicitly configured with it; opening the
 * assistant does not start capture.
 */
import { newId } from './protocol.js';

export class MssObservationRunner {
  constructor({
    adapter,
    intervalMs = 2000,
    clock = () => new Date(),
  } = {}) {
    if (!adapter || typeof adapter.capture !== 'function') {
      throw new Error('adapter with capture() is required');
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 250) {
      throw new Error('intervalMs must be >= 250');
    }
    this.adapter = adapter;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.statusValue = 'stopped';
    this.timer = null;
    this.busy = false;
    this.scope = null;
    this._onFrame = null;
    this._onError = null;
    this.frames = 0;
    this.errors = 0;
  }

  status() {
    return {
      status: this.statusValue,
      scope_id: this.scope?.scope_id ?? null,
      interval_ms: this.intervalMs,
      frames: this.frames,
      errors: this.errors,
      busy: this.busy,
    };
  }

  start({ scope, onFrame = () => {}, onError = () => {} } = {}) {
    if (!scope) throw new Error('scope is required');
    this.stop('restart');
    this.scope = { ...scope };
    this._onFrame = onFrame;
    this._onError = onError;
    this.statusValue = 'running';
    this.frames = 0;
    this.errors = 0;
    this.busy = false;
    this._capture();
    this.timer = setInterval(() => this._capture(), this.intervalMs);
    this.timer.unref?.();
    return this.status();
  }

  pause(reason = 'user') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.statusValue === 'running') this.statusValue = 'paused';
    this.pauseReason = String(reason).slice(0, 200);
    return this.status();
  }

  stop(reason = 'user') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.statusValue = 'stopped';
    this.scope = null;
    this._onFrame = null;
    this._onError = null;
    this.busy = false;
    this.stopReason = String(reason).slice(0, 200);
    return this.status();
  }

  async _capture() {
    if (this.statusValue !== 'running' || this.busy || !this.scope) return;
    this.busy = true;
    try {
      const frame = await this.adapter.capture({
        scope: this.scope,
        frameId: newId('frame'),
      });
      if (this.statusValue !== 'running') return;
      this.frames += 1;
      this._onFrame?.(frame);
    } catch (error) {
      if (this.statusValue !== 'running') return;
      this.errors += 1;
      this._onError?.(error);
    } finally {
      this.busy = false;
    }
  }
}

export function createMssObservationRunner(options) {
  return new MssObservationRunner(options);
}
