/**
 * Bridge between a model's action_request and the PreAct gate.
 *
 * Design:
 *   propose()  → asks for user authorization, never executes
 *   authorize() → records explicit grant, never executes
 *   execute()  → one gate replay attempt only
 *
 * The bridge has no input driver. The real replay function is injected into
 * PreactGate; tests use a fake.
 */

export class WakeActionBridge {
  constructor({ gate, host } = {}) {
    if (!gate || typeof gate.propose !== 'function') throw new Error('PreactGate is required');
    if (!host || typeof host.publishAssistantMessage !== 'function') {
      throw new Error('host.publishAssistantMessage() is required');
    }
    this.gate = gate;
    this.host = host;
  }

  status() {
    return this.gate.status();
  }

  propose({ actionRequest, frame, task = null } = {}) {
    const status = this.gate.propose({ actionRequest, frame, task });
    this.host.publishAssistantMessage(
      `准备执行 ${actionRequest.program_id} v${actionRequest.version}；需要你明确授权后才能继续。`,
      { kind: 'action_request' },
    );
    return status;
  }

  authorize(grant) {
    const result = this.gate.authorize({ grant });
    this.host.publishAssistantMessage(
      result.authorized
        ? '操作已授权；仍未执行，等待单次 replay。'
        : '授权不足，操作不会执行。',
      { kind: 'authorization_result' },
    );
    return result;
  }

  async execute() {
    const result = await this.gate.execute();
    if (result.status === 'completed') {
      this.host.publishAssistantMessage('操作 replay 已完成并通过动作后验证。', { kind: 'action_result' });
    } else if (result.status === 'replan_required') {
      this.host.publishAssistantMessage('现场状态已变化，需要重新观察和规划。', { kind: 'action_result' });
    } else if (result.status === 'unknown') {
      this.host.publishAssistantMessage('无法确认操作结果，不会自动重试。', { kind: 'action_result' });
    } else {
      this.host.publishAssistantMessage('操作未完成；不会自动重试或改用旧坐标。', { kind: 'action_result' });
    }
    return result;
  }

  cancel(reason = 'user') {
    return this.gate.cancel(reason);
  }
}

export function createWakeActionBridge(options) {
  return new WakeActionBridge(options);
}
