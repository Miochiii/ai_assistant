/**
 * Wake model port for the resident loop.
 *
 * The scheduler decides WHEN to wake. This adapter decides WHAT the model sees
 * and publishes only the model's suggestion. It never executes an action; an
 * `action_request` returned by a model is handed back to the caller for the
 * PreAct permission/verification gate.
 *
 * The real DSH session adapter can replace OfflineWakeModel later. No model
 * client or network call is present in this module.
 */

export class OfflineWakeModel {
  async complete({ kind, text, task, frame }) {
    if (kind === 'user') {
      return { should_speak: true, text: `收到：${text || '我在'}` };
    }
    if (task) {
      const step = task.steps?.[task.step_index] ?? task.title ?? '当前步骤';
      const note = frame?.change_bbox
        ? ` 画面区域 ${frame.change_bbox.width}×${frame.change_bbox.height}。`
        : '';
      return {
        should_speak: true,
        text: `当前步骤：${step}${note}`,
      };
    }
    if (frame && Number(frame.changed_score ?? 0) > 0) {
      return {
        should_speak: true,
        text: '画面有新变化。需要我看一下并给建议吗？',
      };
    }
    return { should_speak: false, text: '' };
  }
}

export class WakeModelAdapter {
  constructor({
    model = new OfflineWakeModel(),
    host,
    allowUserWake = false,
    clock = () => new Date(),
  } = {}) {
    if (!model || typeof model.complete !== 'function') {
      throw new Error('model.complete() is required');
    }
    if (!host || typeof host.publishAssistantMessage !== 'function') {
      throw new Error('host.publishAssistantMessage() is required');
    }
    this.model = model;
    this.host = host;
    this.allowUserWake = allowUserWake;
    this.clock = clock;
    this.busy = false;
    this.handled = 0;
    this.published = 0;
    this.lastResult = null;
  }

  status() {
    return {
      busy: this.busy,
      handled: this.handled,
      published: this.published,
      last_kind: this.lastResult?.kind ?? null,
      last_should_speak: this.lastResult?.should_speak ?? null,
    };
  }

  async handle({ kind = 'frame', frame = null, text = null } = {}) {
    if (this.busy) return { ok: false, reason: 'busy' };
    if (kind === 'user' && !this.allowUserWake) {
      return { ok: true, ignored: 'user-wake-handled-by-chat' };
    }
    this.busy = true;
    try {
      const task = this.host.state.task;
      const step = task ? {
        index: task.step_index,
        step_id: task.step_id,
        text: task.steps?.[task.step_index] ?? '',
      } : null;
      const request = {
        kind,
        text,
        task: task ? { ...task, steps: [...task.steps] } : null,
        step,
        frame: frame ? {
          frame_id: frame.frame_id,
          captured_at: frame.captured_at,
          changed_score: frame.changed_score ?? 0,
          changed_ratio: frame.changed_ratio ?? 0,
          change_bbox: frame.change_bbox ?? null,
          thumbnail_ref: frame.thumbnail_ref ?? null,
          width: frame.width ?? null,
          height: frame.height ?? null,
        } : null,
        at: this.clock().toISOString(),
      };
      let result;
      try {
        result = await this.model.complete(request);
      } catch (error) {
        return { ok: false, reason: `model: ${error?.message ?? error}` };
      }
      this.handled += 1;
      this.lastResult = { ...result, kind };
      if (result?.should_speak === false) {
        return { ok: true, should_speak: false, text: null, action_request: result?.action_request ?? null };
      }
      const reply = String(result?.text ?? '').trim();
      if (!reply) return { ok: false, reason: 'empty_reply' };
      this.host.publishAssistantMessage(reply, { kind: 'wake_suggestion' });
      this.published += 1;
      return {
        ok: true,
        should_speak: true,
        text: reply,
        action_request: result?.action_request ?? null,
      };
    } finally {
      this.busy = false;
    }
  }
}

export function createWakeModelAdapter(options) {
  return new WakeModelAdapter(options);
}
