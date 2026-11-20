/**
 * Observation service (RH04 offline slice).
 *
 * Owns capture lifecycle for the Host, but this version accepts synthetic
 * frames only. It never opens a screen/camera, invokes ffmpeg, calls a model or
 * sends desktop input. A future capture adapter can push frames into the same
 * contract.
 *
 * Important: the service keeps a bounded frame cache and a separate "latest"
 * frame. History/summary frames are not current evidence for a click.
 */

const STATUSES = new Set(['stopped', 'starting', 'running', 'paused', 'fault']);
const SCOPE_KINDS = new Set(['monitor', 'region', 'window']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoNow(clock) {
  return clock().toISOString();
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validateScope(scope) {
  if (!isPlainObject(scope)) throw new Error('scope must be an object');
  if (!SCOPE_KINDS.has(scope.kind)) throw new Error('invalid scope kind');
  if (typeof scope.scope_id !== 'string' || !scope.scope_id) throw new Error('scope_id is required');
  if (typeof scope.geometry_revision !== 'string' || !scope.geometry_revision) {
    throw new Error('geometry_revision is required');
  }
  if (scope.bounds !== undefined) {
    const b = scope.bounds;
    if (!isPlainObject(b) || !['left', 'top', 'width', 'height'].every(k => Number.isSafeInteger(b[k]))
        || b.width <= 0 || b.height <= 0) {
      throw new Error('invalid scope bounds');
    }
  }
  if (scope.hwnd !== undefined && (!Number.isSafeInteger(scope.hwnd) || scope.hwnd <= 0)) {
    throw new Error('invalid scope hwnd');
  }
  return { ...scope, bounds: scope.bounds ? { ...scope.bounds } : undefined };
}

function validateFrame(frame) {
  if (!isPlainObject(frame)) throw new Error('frame must be an object');
  if (typeof frame.frame_id !== 'string' || !frame.frame_id) throw new Error('frame_id is required');
  if (typeof frame.scope_id !== 'string' || !frame.scope_id) throw new Error('scope_id is required');
  if (typeof frame.geometry_revision !== 'string' || !frame.geometry_revision) {
    throw new Error('geometry_revision is required');
  }
  if (!parseTime(frame.captured_at)) throw new Error('captured_at must be ISO-8601');
  if (typeof frame.changed_score !== 'number' || !Number.isFinite(frame.changed_score)
      || frame.changed_score < 0 || frame.changed_score > 255) {
    throw new Error('changed_score must be 0..255');
  }
  for (const key of ['width', 'height']) {
    if (frame[key] !== undefined && (!Number.isSafeInteger(frame[key]) || frame[key] <= 0)) {
      throw new Error(`invalid ${key}`);
    }
  }
  return frame;
}

export class ObservationService {
  constructor({
    maxFrames = 8,
    maxAgeMs = 5000,
    minChangedScore = 0,
    minChangedRatio = 0,
    clock = () => new Date(),
    source = null,
  } = {}) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 64) {
      throw new Error('maxFrames must be 1..64');
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('maxAgeMs must be non-negative');
    if (!Number.isFinite(minChangedScore) || minChangedScore < 0 || minChangedScore > 255) {
      throw new Error('minChangedScore must be 0..255');
    }
    if (!Number.isFinite(minChangedRatio) || minChangedRatio < 0 || minChangedRatio > 1) {
      throw new Error('minChangedRatio must be 0..1');
    }
    this.maxFrames = maxFrames;
    this.maxAgeMs = maxAgeMs;
    this.minChangedScore = minChangedScore;
    this.minChangedRatio = minChangedRatio;
    this.clock = clock;
    this.source = source;
    this.statusValue = 'stopped';
    this.scope = null;
    this.frames = [];
    this.latestFrame = null;
    this.framesSeen = 0;
    this.framesKept = 0;
    this.framesDropped = 0;
    this.framesLowChange = 0;
    this.pauseReason = null;
    this.faultReason = null;
    this.startedAt = null;
  }

  status() {
    return {
      status: this.statusValue,
      scope: this.scope ? { ...this.scope } : null,
      frames_kept: this.frames.length,
      latest_frame_id: this.latestFrame?.frame_id ?? null,
      latest_changed_score: this.latestFrame?.changed_score ?? null,
      latest_change_bbox: this.latestFrame?.change_bbox ?? null,
      latest_change_regions: this.latestFrame?.change_regions ?? null,
      latest_thumbnail_ref: this.latestFrame?.thumbnail_ref ?? null,
      latest_captured_at: this.latestFrame?.captured_at ?? null,
      frames_seen: this.framesSeen,
      frames_dropped: this.framesDropped,
      frames_low_change: this.framesLowChange,
      min_changed_score: this.minChangedScore,
      min_changed_ratio: this.minChangedRatio,
      pause_reason: this.pauseReason,
      fault_reason: this.faultReason,
      started_at: this.startedAt,
    };
  }

  start({ scope, source = this.source } = {}) {
    if (this.statusValue === 'running') return { already: true, status: this.status() };
    this.scope = validateScope(scope);
    this.source = source;
    this.statusValue = 'running';
    this.frames = [];
    this.latestFrame = null;
    this.framesSeen = 0;
    this.framesKept = 0;
    this.framesDropped = 0;
    this.framesLowChange = 0;
    this.pauseReason = null;
    this.faultReason = null;
    this.startedAt = isoNow(this.clock);
    return { started: true, status: this.status() };
  }

  pause(reason = 'user') {
    if (this.statusValue !== 'running' && this.statusValue !== 'starting') {
      return { paused: false, status: this.status() };
    }
    this.statusValue = 'paused';
    this.pauseReason = String(reason).slice(0, 200);
    // Pending frames are stale by definition after a pause.
    this.frames = [];
    this.latestFrame = null;
    return { paused: true, status: this.status() };
  }

  resume({ scope } = {}) {
    if (this.statusValue === 'running') return { already: true, status: this.status() };
    this.scope = validateScope(scope ?? this.scope);
    this.statusValue = 'running';
    this.frames = [];
    this.latestFrame = null;
    this.framesSeen = 0;
    this.framesKept = 0;
    this.framesDropped = 0;
    this.framesLowChange = 0;
    this.pauseReason = null;
    this.faultReason = null;
    this.startedAt = isoNow(this.clock);
    return { resumed: true, status: this.status() };
  }

  stop(reason = 'user') {
    this.statusValue = 'stopped';
    this.pauseReason = null;
    this.faultReason = null;
    this.frames = [];
    this.latestFrame = null;
    this.scope = null;
    this.stopReason = String(reason).slice(0, 200);
    return { stopped: true, status: this.status() };
  }

  fail(reason) {
    this.statusValue = 'fault';
    this.faultReason = String(reason).slice(0, 200);
    this.frames = [];
    this.latestFrame = null;
    return { fault: true, status: this.status() };
  }

  _isLowChange(frame) {
    const score = Number(frame.changed_score ?? 0);
    const ratio = Number(frame.changed_ratio ?? 0);
    return score <= this.minChangedScore && ratio <= this.minChangedRatio;
  }

  pushFrame(frame) {
    this.framesSeen += 1;
    if (this.statusValue !== 'running') {
      this.framesDropped += 1;
      return { accepted: false, reason: 'not_running' };
    }
    try {
      validateFrame(frame);
    } catch (error) {
      this.framesDropped += 1;
      return { accepted: false, reason: 'invalid_frame', detail: String(error.message ?? error) };
    }
    if (frame.scope_id !== this.scope.scope_id
        || frame.geometry_revision !== this.scope.geometry_revision) {
      this.framesDropped += 1;
      return { accepted: false, reason: 'scope_or_geometry_mismatch' };
    }
    const captured = parseTime(frame.captured_at);
    const now = this.clock().getTime();
    if (captured > now + 5000) {
      this.framesDropped += 1;
      return { accepted: false, reason: 'frame_in_future' };
    }
    if (this.latestFrame && this._isLowChange(frame)) {
      this.framesDropped += 1;
      this.framesLowChange += 1;
      return {
        accepted: false,
        reason: 'low_change',
        changed_score: Number(frame.changed_score ?? 0),
        changed_ratio: Number(frame.changed_ratio ?? 0),
      };
    }
    const item = { ...frame, captured_ms: captured };
    this.frames.push(item);
    this.framesKept += 1;
    if (this.frames.length > this.maxFrames) {
      this.frames.shift();
      this.framesDropped += 1;
    }
    if (!this.latestFrame || captured >= this.latestFrame.captured_ms) {
      this.latestFrame = item;
    }
    return { accepted: true, latest: this.latestFrame.frame_id };
  }

  latest({ after = null, scopeId = null, geometryRevision = null, maxAgeMs = null } = {}) {
    if (!this.latestFrame) return { status: 'not_found', reason: 'no_frame' };
    const frame = this.latestFrame;
    if (scopeId && frame.scope_id !== scopeId) return { status: 'not_found', reason: 'scope_mismatch' };
    if (geometryRevision && frame.geometry_revision !== geometryRevision) {
      return { status: 'not_found', reason: 'geometry_mismatch' };
    }
    if (after) {
      const afterMs = parseTime(after);
      if (afterMs === null) return { status: 'unknown', reason: 'invalid_after' };
      if (frame.captured_ms <= afterMs) return { status: 'not_found', reason: 'not_newer' };
    }
    const ageLimit = maxAgeMs === null ? this.maxAgeMs : maxAgeMs;
    if (ageLimit > 0 && this.clock().getTime() - frame.captured_ms > ageLimit) {
      return { status: 'not_found', reason: 'stale' };
    }
    return { status: 'found', frame: { ...frame } };
  }

  takeSummary() {
    const summary = {
      status: this.statusValue,
      scope_id: this.scope?.scope_id ?? null,
      frames_seen: this.framesSeen,
      frames_kept: this.framesKept,
      frames_dropped: this.framesDropped,
      frames_low_change: this.framesLowChange,
      cached_frames: this.frames.length,
      latest_frame_id: this.latestFrame?.frame_id ?? null,
    };
    this.framesSeen = 0;
    this.framesKept = 0;
    this.framesDropped = 0;
    this.framesLowChange = 0;
    return summary;
  }
}

export function createObservationService(options = {}) {
  return new ObservationService(options);
}
