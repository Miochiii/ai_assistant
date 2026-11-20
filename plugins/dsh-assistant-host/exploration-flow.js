/**
 * Explore-and-record flow for a task with no existing PreAct program.
 *
 * User direction:
 *   - no matching PreAct program → ask the user for exploration permission
 *   - low-risk steps run continuously under that permission
 *   - risky steps require a separate explicit risk grant
 *   - only verified steps are appended to the recorded sequence
 *   - the whole sequence is saved to PreAct as one program
 *
 * The executor and recordProgram are injected. This module has no input driver,
 * so tests and callers must provide the real fixed executor / inventory save.
 */

const TERMINAL = new Set(['recorded', 'stopped', 'failed', 'replan_required']);

function validateGrant(grant, action, hwnd = null) {
  if (!grant || typeof grant !== 'object') return false;
  if (typeof grant.grant_id !== 'string' || !grant.grant_id) return false;
  if (!Array.isArray(grant.actions) || !grant.actions.includes(action)) return false;
  if (hwnd && Array.isArray(grant.windows)
      && !grant.windows.some(window => window?.hwnd === hwnd)) return false;
  return true;
}

export class ExplorationFlow {
  constructor({ goal, window = null, explorationGrant, clock = () => new Date() } = {}) {
    if (typeof goal !== 'string' || !goal.trim()) throw new Error('goal is required');
    if (!validateGrant(explorationGrant, 'explore', window?.hwnd ?? null)) {
      throw new Error('exploration grant is required');
    }
    this.goal = goal.trim().slice(0, 500);
    this.window = window ? { ...window } : null;
    this.explorationGrant = explorationGrant;
    this.clock = clock;
    this.phase = 'exploring';
    this.pending = null;
    this.steps = [];
    this.riskGrant = null;
    this.stopReason = null;
    this.recorded = null;
  }

  status() {
    return {
      phase: this.phase,
      goal: this.goal,
      window: this.window,
      steps_verified: this.steps.length,
      pending: this.pending ? {
        intent: this.pending.intent,
        risk: this.pending.risk,
        authorized: this.pending.authorized,
      } : null,
      has_risk_grant: Boolean(this.riskGrant),
      stop_reason: this.stopReason,
      recorded: this.recorded ? { program_id: this.recorded.program_id } : null,
    };
  }

  proposeStep({ intent, risk = 'low', evidence, expected = null } = {}) {
    if (this.phase !== 'exploring') throw new Error('flow is not exploring');
    if (this.pending) throw new Error('one pending step is allowed');
    if (typeof intent !== 'string' || !intent.trim()) throw new Error('step intent is required');
    if (!evidence || typeof evidence !== 'object') throw new Error('step evidence is required');
    if (!['low', 'high'].includes(risk)) throw new Error('risk must be low or high');
    const step = {
      intent: intent.trim().slice(0, 300),
      risk,
      evidence,
      expected,
      authorized: risk === 'low'
        ? validateGrant(this.explorationGrant, 'explore', this.window?.hwnd ?? null)
        : Boolean(this.riskGrant),
    };
    this.pending = step;
    if (!step.authorized) this.phase = 'awaiting_risk_authorization';
    return this.status();
  }

  authorizeRisk(grant) {
    if (this.phase !== 'awaiting_risk_authorization' || !this.pending) {
      return { authorized: false, reason: 'no_pending_risk' };
    }
    if (!validateGrant(grant, 'risk', this.window?.hwnd ?? null)) {
      return { authorized: false, reason: 'risk_grant_missing_or_out_of_scope' };
    }
    this.riskGrant = grant;
    this.pending.authorized = true;
    this.phase = 'exploring';
    return { authorized: true, status: this.status() };
  }

  async executeStep({ executor } = {}) {
    if (this.pending && !this.pending.authorized) {
      return { ok: false, reason: 'authorization_required' };
    }
    if (this.phase !== 'exploring') return { ok: false, reason: `flow_${this.phase}` };
    if (!this.pending) return { ok: false, reason: 'no_pending_step' };
    if (!this.pending.authorized) return { ok: false, reason: 'authorization_required' };
    if (typeof executor !== 'function') throw new Error('executor is required');
    const step = this.pending;
    let result;
    try {
      result = await executor({
        intent: step.intent,
        risk: step.risk,
        evidence: step.evidence,
        expected: step.expected,
        exploration_grant: this.explorationGrant,
        risk_grant: step.risk === 'high' ? this.riskGrant : null,
      });
    } catch (error) {
      result = { status: 'failed', reason: `executor: ${error?.message ?? error}` };
    }
    if (result?.status === 'passed') {
      this.steps.push({
        intent: step.intent,
        risk: step.risk,
        evidence: step.evidence,
        expected: step.expected,
        result,
        verified_at: result.verified_at ?? this.clock().toISOString(),
      });
      this.pending = null;
      return { ok: true, status: 'passed', steps: this.steps.length };
    }
    this.pending = null;
    if (result?.status === 'replan_required') {
      this.phase = 'replan_required';
      this.stopReason = 'replan_required';
      return { ok: false, status: 'replan_required', reason: result?.reason ?? null };
    }
    if (result?.status === 'unknown') {
      this.phase = 'failed';
      this.stopReason = 'unknown';
      return { ok: false, status: 'unknown', reason: result?.reason ?? null };
    }
    this.phase = 'failed';
    this.stopReason = 'step_failed';
    return { ok: false, status: 'failed', reason: result?.reason ?? null };
  }

  finish() {
    if (this.phase !== 'exploring') return { ok: false, reason: `flow_${this.phase}` };
    if (this.pending) return { ok: false, reason: 'pending_step' };
    if (this.steps.length === 0) return { ok: false, reason: 'no_verified_steps' };
    this.phase = 'ready_to_record';
    return { ok: true, status: this.status() };
  }

  async record({ recordProgram } = {}) {
    if (this.phase !== 'ready_to_record') return { ok: false, reason: 'flow_not_ready_to_record' };
    if (typeof recordProgram !== 'function') throw new Error('recordProgram is required');
    const draft = {
      goal: this.goal,
      window: this.window,
      steps: this.steps.map(step => ({
        intent: step.intent,
        risk: step.risk,
        evidence: { ...step.evidence },
        expected: step.expected,
        verification: step.result?.verification ?? { status: 'passed' },
      })),
      verified: true,
      created_at: this.clock().toISOString(),
    };
    const saved = await recordProgram(draft);
    this.recorded = saved;
    this.phase = 'recorded';
    return { ok: true, program_id: saved.program_id, draft };
  }

  abort(reason = 'user') {
    if (TERMINAL.has(this.phase)) return { stopped: false };
    this.phase = 'stopped';
    this.stopReason = String(reason).slice(0, 200);
    this.pending = null;
    return { stopped: true };
  }
}

export function createExplorationFlow(options) {
  return new ExplorationFlow(options);
}
