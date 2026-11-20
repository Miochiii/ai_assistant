/**
 * Scene wake scheduler, modeled on dsh-see-now's loop.js.
 *
 * The scheduler owns the clock. It wakes the caller only when the observation
 * service has a NEW accepted frame (or the user interjects), not on every
 * captured frame. This is the missing "companion" half of the mss pipeline:
 * capture and scoring may run continuously, but model/agent turns are paced.
 *
 * No model client, desktop input or capture is performed here. onWake is an
 * injected callback; PreAct/action execution must remain behind its own grant
 * and verification gate.
 */

const DEFAULTS = Object.freeze({
  tickMs: 2000,
  minWakeGapMs: 8000,
  userCooldownMs: 3000,
  maxFrameAgeMs: 15000,
  idleStopMs: 3 * 60 * 1000,
  maxAutonomousWakes: 8,
  maxWakeFailures: 2,
  retryDelayMs: 800,
});

export class SceneWakeScheduler {
  constructor({
    observationService,
    onWake = async () => ({ ok: true }),
    onStop = () => {},
    now = Date.now,
    windowOpen = () => true,
    retryDelayMs = DEFAULTS.retryDelayMs,
    ...options
  } = {}) {
    if (!observationService || typeof observationService.latest !== 'function') {
      throw new Error('observationService.latest() is required');
    }
    this.observationService = observationService;
    this.onWake = onWake;
    this.onStop = onStop;
    this.now = now;
    this.windowOpen = windowOpen;
    this.retryDelayMs = retryDelayMs;
    this.config = { ...DEFAULTS, ...options };
    if (!Number.isFinite(this.config.tickMs) || this.config.tickMs < 250) {
      throw new Error('tickMs must be >= 250');
    }
    if (!Number.isFinite(this.config.minWakeGapMs) || this.config.minWakeGapMs < 0) {
      throw new Error('minWakeGapMs must be non-negative');
    }
    if (!Number.isFinite(this.config.userCooldownMs) || this.config.userCooldownMs < 0) {
      throw new Error('userCooldownMs must be non-negative');
    }
    this.started = false;
    this.stopped = false;
    this.stopReason = null;
    this.busy = false;
    this.tickRunning = false;
    this.timer = null;
    this.lastWakeAt = null;
    this.lastFrameId = null;
    this.pendingUser = [];
    this.lastUserAt = this.now();
    this.wakesSinceUser = 0;
    this.consecutiveFailures = 0;
    this.wakeCount = 0;
    this.failureCount = 0;
  }

  start() {
    if (this.started) return this.state();
    this.started = true;
    this.stopped = false;
    this.stopReason = null;
    this.timer = setInterval(() => { void this.tick(); }, this.config.tickMs);
    this.timer.unref?.();
    void this.tick();
    return this.state();
  }

  stop(reason = 'manual') {
    if (this.stopped) return this.state();
    this.stopped = true;
    this.stopReason = String(reason).slice(0, 200);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.onStop(this.stopReason); } catch { /* stop must not throw */ }
    return this.state();
  }

  noteUser(text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    this.pendingUser.push(value.slice(0, 1000));
    this.lastUserAt = this.now();
    this.wakesSinceUser = 0;
    this.consecutiveFailures = 0;
  }

  state() {
    return {
      started: this.started,
      stopped: this.stopped,
      reason: this.stopReason,
      wakes: this.wakeCount,
      failures: this.failureCount,
      wakes_since_user: this.wakesSinceUser,
      pending_user: this.pendingUser.length,
      last_wake_at: this.lastWakeAt,
      last_frame_id: this.lastFrameId,
      busy: this.busy,
    };
  }

  _dueForIdle() {
    if (this.windowOpen()) return false;
    return this.now() - this.lastUserAt > this.config.idleStopMs;
  }

  async _wake(payload, { user = false } = {}) {
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    try {
      let result = null;
      let attempts = 0;
      while (attempts < 2) {
        attempts += 1;
        try {
          result = await this.onWake(payload);
        } catch (error) {
          result = { ok: false, reason: String(error?.message ?? error) };
        }
        if (result?.ok !== false) break;
        if (attempts < 2 && this.retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
        }
      }
      if (result?.ok === false) {
        this.failureCount += 1;
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.config.maxWakeFailures) {
          this.stop('wake-failed');
        }
        return result;
      }
      this.consecutiveFailures = 0;
      this.wakeCount += 1;
      this.lastWakeAt = this.now();
      if (user) {
        this.pendingUser.shift();
        this.lastUserAt = this.now();
        this.wakesSinceUser = 0;
      } else {
        this.wakesSinceUser += 1;
        if (this.wakesSinceUser >= this.config.maxAutonomousWakes) {
          this.stop('idle');
        }
      }
      return result ?? { ok: true };
    } finally {
      this.busy = false;
    }
  }

  async tick() {
    if (this.stopped || this.tickRunning) return this.state();
    this.tickRunning = true;
    try {
      if (this._dueForIdle()) {
        this.stop('idle');
        return this.state();
      }
      if (this.busy) return this.state();

      if (this.pendingUser.length > 0) {
        const since = this.lastWakeAt === null ? Infinity : this.now() - this.lastWakeAt;
        if (since < this.config.userCooldownMs) return this.state();
        const text = this.pendingUser[0];
        await this._wake({ kind: 'user', text, frame: null }, { user: true });
        return this.state();
      }

      const latest = this.observationService.latest({
        maxAgeMs: this.config.maxFrameAgeMs,
      });
      if (!latest || latest.status !== 'found') return this.state();
      const frame = latest.frame;
      if (!frame || !frame.frame_id || frame.frame_id === this.lastFrameId) {
        return this.state();
      }
      const since = this.lastWakeAt === null ? Infinity : this.now() - this.lastWakeAt;
      if (since < this.config.minWakeGapMs) return this.state();
      const result = await this._wake({ kind: 'frame', frame, text: null });
      if (result?.ok !== false) this.lastFrameId = frame.frame_id;
      return this.state();
    } finally {
      this.tickRunning = false;
    }
  }
}

export function createSceneWakeScheduler(options) {
  return new SceneWakeScheduler(options);
}
