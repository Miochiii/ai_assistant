/**
 * PreAct gate for model-proposed actions.
 *
 * The model may return an `action_request`, but this gate refuses to execute it
 * until a caller supplies an explicit grant. Execution is one attempt only:
 * no retry, no fallback coordinates, no evidence reuse after failure.
 *
 * `replay` is injected (the real implementation is scripts/preact_replay.py or
 * a DSH bridge). No mouse/keyboard input is implemented here.
 */
import { newId } from './protocol.js';

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validateActionRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('action_request is required');
  if (typeof request.program_id !== 'string' || !request.program_id) {
    throw new Error('action_request.program_id is required');
  }
  if (!Number.isSafeInteger(request.version) || request.version < 1) {
    throw new Error('action_request.version is required');
  }
  if (request.hwnd !== undefined && (!Number.isSafeInteger(request.hwnd) || request.hwnd <= 0)) {
    throw new Error('invalid action_request.hwnd');
  }
  return request;
}

function grantCovers(grant, request) {
  if (!grant || typeof grant !== 'object') return false;
  if (typeof grant.grant_id !== 'string' || !grant.grant_id) return false;
  if (!Array.isArray(grant.actions) || !grant.actions.includes('replay')) return false;
  if (request.hwnd && Array.isArray(grant.windows)
      && !grant.windows.some(window => window?.hwnd === request.hwnd)) {
    return false;
  }
  return true;
}

export class PreactGate {
  constructor({
    replay,
    clock = () => new Date(),
    maxEvidenceAgeMs = 5000,
  } = {}) {
    if (typeof replay !== 'function') throw new Error('replay function is required');
    if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs < 0) {
      throw new Error('maxEvidenceAgeMs must be non-negative');
    }
    this.replay = replay;
    this.clock = clock;
    this.maxEvidenceAgeMs = maxEvidenceAgeMs;
    this.pending = null;
    this.executing = false;
    this.history = [];
  }

  status() {
    return {
      phase: this.pending?.status ?? 'idle',
      pending_id: this.pending?.pending_id ?? null,
      executing: this.executing,
      history: this.history.length,
    };
  }

  propose({ actionRequest, frame, task = null } = {}) {
    if (this.pending && !['completed', 'stopped', 'failed', 'replan_required', 'unknown'].includes(this.pending.status)) {
      throw new Error('one pending action is allowed');
    }
    validateActionRequest(actionRequest);
    if (!frame || typeof frame.frame_id !== 'string' || !frame.frame_id) {
      throw new Error('fresh observation frame is required');
    }
    const captured = parseTime(frame.captured_at);
    if (captured === null) throw new Error('frame.captured_at must be ISO-8601');
    if (this.clock().getTime() - captured > this.maxEvidenceAgeMs) {
      throw new Error('observation frame is stale');
    }
    this.pending = {
      pending_id: newId('action'),
      status: 'awaiting_authorization',
      action_request: actionRequest,
      frame: { ...frame },
      task: task ? { ...task } : null,
      grant: null,
      result: null,
      created_at: this.clock().toISOString(),
    };
    return this.status();
  }

  authorize({ grant } = {}) {
    if (!this.pending) throw new Error('no pending action');
    if (this.pending.status !== 'awaiting_authorization') {
      return { authorized: false, reason: 'not_awaiting_authorization' };
    }
    if (!grantCovers(grant, this.pending.action_request)) {
      return { authorized: false, reason: 'grant_missing_or_out_of_scope' };
    }
    this.pending.grant = grant;
    this.pending.status = 'authorized';
    return { authorized: true, status: this.status() };
  }

  async execute() {
    if (!this.pending) return { ok: false, reason: 'no_pending_action' };
    if (this.pending.status !== 'authorized') {
      return { ok: false, reason: 'authorization_required' };
    }
    if (this.executing) return { ok: false, reason: 'busy' };
    this.executing = true;
    this.pending.status = 'executing';
    const pending = this.pending;
    try {
      let result;
      try {
        result = await this.replay({
          action_request: pending.action_request,
          grant: pending.grant,
          frame: pending.frame,
          task: pending.task,
        });
      } catch (error) {
        result = { status: 'failed', reason: `replay: ${error?.message ?? error}` };
      }
      pending.result = result;
      if (result?.status === 'completed') {
        pending.status = 'completed';
        this.history.push(pending);
        return { ok: true, status: 'completed', result };
      }
      if (result?.status === 'replan_required') {
        pending.status = 'replan_required';
        this.history.push(pending);
        return { ok: false, status: 'replan_required', result };
      }
      pending.status = result?.status === 'unknown' ? 'unknown' : 'failed';
      this.history.push(pending);
      return { ok: false, status: pending.status, result };
    } finally {
      this.executing = false;
    }
  }

  cancel(reason = 'user') {
    if (!this.pending) return { cancelled: false };
    if (this.pending.status === 'executing') return { cancelled: false, reason: 'executing' };
    this.pending.status = 'stopped';
    this.pending.result = { status: 'stopped', reason: String(reason).slice(0, 200) };
    this.history.push(this.pending);
    return { cancelled: true };
  }
}

export function createPreactGate(options) {
  return new PreactGate(options);
}
