/**
 * Cheap local candidate gate for the resident model loop.
 *
 * Runs before any model request. It is intentionally heuristic: changed score,
 * changed ratio and changed-region area must clear configurable floors. A
 * "strong" change is treated as a new scene and can reset a silent backoff
 * immediately; otherwise low-value frames never reach the model.
 *
 * Silence is a cadence signal, not a stop signal. The observation loop stays
 * resident; model calls get slower until a new scene or user input arrives.
 */
export class CandidateGate {
  constructor({
    minChangedScore = 2,
    minChangedRatio = 0.01,
    minRegionRatio = 0.001,
    strongChangeScore = 32,
    strongChangeRatio = 0.12,
    cooldownMs = 8000,
    maxSilent = 3,
    backoffFactor = 2,
    maxCooldownMs = 60000,
    now = Date.now,
  } = {}) {
    for (const [name, value] of Object.entries({
      minChangedScore, minChangedRatio, minRegionRatio, strongChangeScore,
      strongChangeRatio, cooldownMs,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
    }
    if (!Number.isInteger(maxSilent) || maxSilent < 1) throw new Error('maxSilent must be >= 1');
    this.minChangedScore = minChangedScore;
    this.minChangedRatio = minChangedRatio;
    this.minRegionRatio = minRegionRatio;
    this.strongChangeScore = strongChangeScore;
    this.strongChangeRatio = strongChangeRatio;
    this.baseCooldownMs = cooldownMs;
    this.cooldownMs = cooldownMs;
    this.maxSilent = maxSilent;
    this.backoffFactor = backoffFactor;
    this.maxCooldownMs = maxCooldownMs;
    this.now = now;
    this.nextAllowedAt = 0;
    this.silentStreak = 0;
    this.accepted = 0;
    this.skipped = 0;
    this.lastReason = null;
  }

  _regionRatio(frame) {
    const bbox = frame?.change_bbox;
    if (!bbox || !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)
        || !Number.isFinite(frame?.width) || !Number.isFinite(frame?.height)
        || frame.width <= 0 || frame.height <= 0) return null;
    return (bbox.width * bbox.height) / (frame.width * frame.height);
  }

  shouldRequest(frame) {
    const now = this.now();
    if (!frame || typeof frame.frame_id !== 'string') {
      return { candidate: false, reason: 'no_frame', new_scene: false };
    }
    const score = Number(frame.changed_score ?? 0);
    const ratio = Number(frame.changed_ratio ?? 0);
    const regionRatio = this._regionRatio(frame);
    const strong = score >= this.strongChangeScore || ratio >= this.strongChangeRatio;

    if (strong) {
      // A new scene should not wait for a long silent cooldown.
      this.silentStreak = 0;
      this.cooldownMs = this.baseCooldownMs;
      this.nextAllowedAt = now;
    } else if (now < this.nextAllowedAt) {
      return { candidate: false, reason: 'cooldown', new_scene: false, score, ratio };
    }

    if (score < this.minChangedScore && ratio < this.minChangedRatio) {
      this.skipped += 1;
      this.lastReason = 'low_change';
      return { candidate: false, reason: 'low_change', new_scene: false, score, ratio };
    }
    if (regionRatio !== null && regionRatio < this.minRegionRatio && !strong) {
      this.skipped += 1;
      this.lastReason = 'small_region';
      return { candidate: false, reason: 'small_region', new_scene: false, regionRatio };
    }
    this.accepted += 1;
    this.lastReason = strong ? 'new_scene' : 'candidate';
    this.nextAllowedAt = now + this.cooldownMs;
    return { candidate: true, reason: this.lastReason, new_scene: strong, score, ratio, regionRatio };
  }

  recordDecision(speak) {
    if (speak) {
      this.silentStreak = 0;
      this.cooldownMs = this.baseCooldownMs;
      this.nextAllowedAt = this.now() + this.cooldownMs;
      return;
    }
    this.silentStreak += 1;
    this.cooldownMs = Math.min(
      this.maxCooldownMs,
      Math.max(this.baseCooldownMs, Math.round(this.cooldownMs * this.backoffFactor)),
    );
    this.nextAllowedAt = this.now() + this.cooldownMs;
  }

  status() {
    return {
      accepted: this.accepted,
      skipped: this.skipped,
      silent_streak: this.silentStreak,
      max_silent: this.maxSilent,
      cooldown_ms: this.cooldownMs,
      last_reason: this.lastReason,
    };
  }
}

export function createCandidateGate(options) {
  return new CandidateGate(options);
}
