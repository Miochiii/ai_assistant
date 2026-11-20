/**
 * Resident assistant host (offline first slice).
 *
 * Owns the single task/session lifecycle and consumes UI events from the file
 * channel. There is no screen capture, model client, desktop input or timer in
 * this module. A caller may inject a fake model and call poll() repeatedly.
 */
import { randomUUID } from 'node:crypto';

import {
  SCHEMA_VERSION,
  makeEvent,
  newId,
  nowIso,
  validateEvent,
  validateHighlight,
  validateState,
} from './protocol.js';

const TASK_STATUSES = new Set(['waiting_user', 'checking', 'complete', 'cancelled']);

export class OfflineEchoModel {
  constructor() {
    this.calls = 0;
  }

  async complete({ text }) {
    this.calls += 1;
    return { text: `离线模式收到：${text}（未调用真实模型）` };
  }

  abort() {
    // The offline model resolves immediately; this is a contract stub.
  }
}

export class ResidentHost {
  constructor({
    channel,
    model = new OfflineEchoModel(),
    observationService = null,
    captureAdapter = null,
    observationRunner = null,
    sceneWakeScheduler = null,
    speechPort = null,
    stepVerifier = null,
    validateStepFrame = null,
    highlightResolver = null,
    defaultObservationScope = null,
    clock = () => new Date(),
    onState = () => {},
  } = {}) {
    if (!channel) throw new Error('channel is required');
    this.channel = channel;
    this.model = model;
    this.observationService = observationService;
    this.captureAdapter = captureAdapter;
    this.observationRunner = observationRunner;
    this.sceneWakeScheduler = sceneWakeScheduler;
    this.speechPort = speechPort;
    this.stepVerifier = stepVerifier;
    this.validateStepFrame = validateStepFrame;
    this.highlightResolver = highlightResolver;
    this.defaultObservationScope = defaultObservationScope;
    this.clock = clock;
    this.onState = onState;
    this.assistantSessionId = channel.assistantSessionId;
    this.state = {
      schema_version: SCHEMA_VERSION,
      assistant_session_id: this.assistantSessionId,
      state_revision: 0,
      context_epoch: 0,
      assistant: 'starting',
      mode: 'standby',
      observation: { status: 'stopped', scope_id: null },
      task: null,
      model_request: null,
      highlight: null,
      bubble: { text: '待命中' },
      input_enabled: true,
    };
    this.started = false;
    this.closed = false;
    this._seen = new Set();
    this._pending = new Set();
    this._request = null;
    this._startedAt = null;
  }

  initialize() {
    if (this.started) return this.state;
    this.channel.initialize();
    this.started = true;
    this._startedAt = nowIso(this.clock);
    this.state.assistant = 'ready';
    this.state.bubble = { text: '待命中' };
    this._writeState();
    return this.state;
  }

  _snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  _writeState() {
    validateState(this.state, { assistantSessionId: this.assistantSessionId });
    this.channel.writeState(this._snapshot());
    this.onState(this._snapshot());
    return this.state;
  }

  _revision() {
    this.state.state_revision += 1;
    return this.state.state_revision;
  }

  _emit(text, kind = 'assistant_message', extra = {}) {
    const message = this.channel.publishMessage({
      assistant_session_id: this.assistantSessionId,
      task_id: this.state.task?.task_id ?? null,
      context_epoch: this.state.context_epoch,
      kind,
      text,
      ...extra,
    });
    try {
      this.speechPort?.speak?.(text, { origin: kind });
    } catch { /* voice is optional */ }
    return message;
  }

  publishAssistantMessage(text, { kind = 'assistant_message', bubble = true } = {}) {
    if (this.closed) return null;
    const value = String(text ?? '').trim();
    if (!value) return null;
    const message = this._emit(value.slice(0, 4000), kind);
    if (bubble) this.state.bubble = { text: value.slice(0, 140) };
    this._revision();
    this._writeState();
    return message;
  }

  setHighlight({
    highlightId = newId('highlight'),
    text,
    rect,
    target = null,
    targetHwnd = null,
    windowGeometry = null,
    observationId = null,
    geometryRevision = null,
    expiresAt = null,
  } = {}) {
    if (this.closed) throw new Error('host is closed');
    const task = this.state.task;
    const highlight = {
      highlight_id: highlightId,
      task_id: task?.task_id ?? null,
      step_id: task?.step_id ?? null,
      text: String(text ?? '').trim().slice(0, 240),
      target: target === null ? null : String(target).slice(0, 200),
      rect: Array.isArray(rect) ? rect.map(Number) : rect,
      target_hwnd: targetHwnd === null ? null : Number(targetHwnd),
      window_geometry: windowGeometry === null ? null : structuredClone(windowGeometry),
      observation_id: observationId === null ? null : String(observationId),
      geometry_revision: geometryRevision === null ? null : String(geometryRevision),
      created_at: nowIso(this.clock),
      expires_at: expiresAt === null ? null : String(expiresAt),
    };
    validateHighlight(highlight);
    this.state.highlight = highlight;
    this._revision();
    this._writeState();
    return highlight;
  }

  clearHighlight(reason = 'user') {
    if (!this.state.highlight) return this.state;
    this.state.highlight = null;
    this.state.bubble = { text: `高亮已隐藏：${String(reason).slice(0, 80)}` };
    this._revision();
    return this._writeState();
  }

  _dropHighlight(reason) {
    if (!this.state.highlight) return;
    this.state.highlight = null;
    this.state.bubble = { text: `高亮已隐藏：${String(reason).slice(0, 80)}` };
  }

  _cancelRequest(reason) {
    this._verification?.controller.abort();
    if (this.state.task?.status === 'checking') this.state.task.status = 'waiting_user';
    if (!this._request) return;
    this._request.cancelled = true;
    this._request.reason = reason;
    try { this.model.abort?.(this._request); } catch { /* adapter best effort */ }
    if (this.state.model_request?.request_id === this._request.request_id) {
      this.state.model_request = null;
    }
  }

  _bumpEpoch() {
    this.state.context_epoch += 1;
    return this.state.context_epoch;
  }

  _syncObservation() {
    if (!this.observationService) {
      this.state.observation = { status: 'stopped', scope_id: null };
      return;
    }
    const status = this.observationService.status();
    this.state.observation = {
      status: status.status,
      scope_id: status.scope?.scope_id ?? null,
      latest_frame_id: status.latest_frame_id ?? null,
      latest_changed_score: status.latest_changed_score ?? null,
      latest_change_bbox: status.latest_change_bbox ?? null,
      latest_change_regions: status.latest_change_regions ?? null,
      latest_thumbnail_ref: status.latest_thumbnail_ref ?? null,
      latest_captured_at: status.latest_captured_at ?? null,
      frames_kept: status.frames_kept ?? 0,
      frames_seen: status.frames_seen ?? 0,
      frames_low_change: status.frames_low_change ?? 0,
      min_changed_score: status.min_changed_score ?? 0,
      min_changed_ratio: status.min_changed_ratio ?? 0,
      ...(status.pause_reason ? { pause_reason: status.pause_reason } : {}),
      ...(status.fault_reason ? { fault_reason: status.fault_reason } : {}),
    };
  }

  _observationScope(scope = null) {
    return scope ?? this.defaultObservationScope;
  }

  async _startObservation(scope = null) {
    if (!this.observationService) {
      this.state.observation = { status: 'running', scope_id: null };
      this.sceneWakeScheduler?.start();
      return;
    }
    const selected = this._observationScope(scope);
    if (!selected) throw new Error('observation scope is required');
    const current = this.observationService.status();
    if (current.status === 'paused') this.observationService.resume({ scope: selected });
    else this.observationService.start({ scope: selected });
    this._syncObservation();
    this.sceneWakeScheduler?.start();
    if (this.observationRunner) {
      this.observationRunner.start({
        scope: selected,
        onFrame: frame => this._acceptObservationFrame(frame),
        onError: error => this._failObservation(error),
      });
    } else if (this.captureAdapter) {
      await this.captureOnce();
    }
  }

  _acceptObservationFrame(frame) {
    if (!this.observationService) return;
    const result = this.observationService.pushFrame(frame);
    if (result.accepted) {
      this._syncObservation();
      this._revision();
      this._writeState();
    } else if (result.reason === 'low_change') {
      this._syncObservation();
      this._revision();
      this._writeState();
    }
    return result;
  }

  _failObservation(error) {
    if (!this.observationService) return;
    this.observationRunner?.stop('fault');
    this.observationService.fail(`capture: ${error?.message ?? error}`);
    this._syncObservation();
    this._revision();
    this._writeState();
  }

  async captureOnce() {
    if (!this.observationService || !this.captureAdapter) {
      return { accepted: false, reason: 'capture_not_configured' };
    }
    const status = this.observationService.status();
    if (status.status !== 'running' || !status.scope) {
      return { accepted: false, reason: 'observation_not_running' };
    }
    try {
      const frame = await this.captureAdapter.capture({
        scope: status.scope,
        frameId: newId('frame'),
      });
      const result = this.observationService.pushFrame(frame);
      this._syncObservation();
      this._revision();
      this._writeState();
      return result;
    } catch (error) {
      this.observationService.fail(`capture: ${error?.message ?? error}`);
      this._syncObservation();
      this._revision();
      this._writeState();
      return { accepted: false, reason: 'capture_failed', detail: String(error?.message ?? error) };
    }
  }

  startTask({ taskId = newId('task'), title = '指导任务', steps = [], conditions = [], targetWindow = null } = {}) {
    if (this.closed) throw new Error('host is closed');
    if (this.state.task) throw new Error('one active task is allowed');
    if (!Array.isArray(steps) || steps.some(step => typeof step !== 'string' || !step.trim())) {
      throw new Error('steps must be strings');
    }
    this._bumpEpoch();
    this.state.mode = 'coach';
    this.state.highlight = null;
    this.state.task = {
      task_id: taskId,
      title: String(title).slice(0, 200),
      step_index: 0,
      step_id: stepId(0),
      steps: steps.map(step => step.trim()).slice(0, 20),
      status: 'waiting_user',
      expected_result: null,
      conditions: conditions.slice(0, 20),
      target_window: targetWindow,
    };
    this.state.bubble = { text: this.state.task.steps[0] ?? '指导任务已开始' };
    if (targetWindow) this._emit(`已开始 ${steps.length} 步指导，将观察操作结果。可输入“暂停指导”“继续指导”“检查当前步骤”或“取消指导”。`);
    this._revision();
    return this._writeState();
  }

  endTask(reason = 'user') {
    if (!this.state.task) return this.state;
    this._cancelRequest(reason);
    this.state.task = null;
    this.guidanceBaseline = null;
    this.state.highlight = null;
    this._bumpEpoch();
    this.state.mode = 'standby';
    this.observationRunner?.stop(reason);
    this.sceneWakeScheduler?.stop(reason);
    this.observationService?.stop(reason);
    this._syncObservation();
    this.state.bubble = { text: '任务已结束' };
    this._revision();
    return this._writeState();
  }

  _advanceTaskOrReject(event) {
    if (!this.state.task) return false;
    const task = this.state.task;
    if (event.task_id && event.task_id !== task.task_id) {
      throw new Error('event task_id does not match active task');
    }
    return true;
  }

  async _runModel({ event, requestId }) {
    const epoch = this.state.context_epoch;
    const taskId = this.state.task?.task_id ?? null;
    const request = {
      request_id: requestId,
      context_epoch: epoch,
      task_id: taskId,
      cancelled: false,
      reason: '',
    };
    this._request = request;
    this.state.model_request = {
      request_id: requestId,
      status: 'running',
      context_id: `ctx-${epoch}`,
    };
    this._revision();
    this._writeState();
    let reply;
    try {
      reply = await this.model.complete({
        request_id: requestId,
        text: event.payload.text,
        event_id: event.event_id,
        coachTask: this.state.mode === 'coach' && this.state.task ? {
          title: this.state.task.title,
          step: this.state.task.steps[this.state.task.step_index] ?? '',
        } : null,
        task_id: taskId,
        context_epoch: epoch,
      });
    } catch (error) {
      if (!request.cancelled && epoch === this.state.context_epoch && !this.closed) {
        const companionError = typeof error?.code === 'string' && error.code.startsWith('COMPANION_');
        this._emit((companionError ? '' : '回复未完成，请重试。') + String(error?.message ?? error).slice(0, 240),
          'assistant_message', { request_id: requestId,
            ...(companionError ? { error_code: error.code, finish_reason: error.details?.finishReason ?? null } : {}) });
        this.state.model_request = null;
        this.state.bubble = { text: '模型请求失败' };
        this._revision();
        this._writeState();
      }
      if (this._request === request) this._request = null;
      return;
    }
    if (this._request === request) this._request = null;
    if (request.cancelled || epoch !== this.state.context_epoch || taskId !== (this.state.task?.task_id ?? null)) {
      if (this.state.model_request?.request_id === requestId) {
        this.state.model_request = null;
        this._revision();
        this._writeState();
      }
      return;
    }
    this.state.model_request = null;
    this._emit(String(reply?.text ?? '（无回复）'), 'assistant_message', { request_id: requestId });
    this.state.bubble = { text: String(reply?.text ?? '').slice(0, 140) || '已回复' };
    if (Object.hasOwn(reply ?? {}, 'highlightTarget')) this.clearHighlight('新的指导回复');
    if (reply?.highlightTarget && !this.state.task) {
      try {
        this.guidanceBaseline = reply.guidanceBaseline ?? null;
        this.startTask({
          title: '指导任务',
          steps: [String(reply.text || event.payload.text).slice(0, 200)],
          ...(reply.guidancePlan ?? {}),
        });
      } catch { /* task creation is optional; never turn a reply into a success */ }
    }
    if (reply?.highlightTarget && this.highlightResolver) {
      void Promise.resolve(this.highlightResolver(reply.highlightTarget))
        .catch(error => {
          if (!this.closed) this._emit(`高亮未完成：${String(error?.message ?? error).slice(0, 200)}`,
            'assistant_message', { request_id: requestId });
        });
    }
    this._revision();
    this._writeState();
  }

  async _verifyCurrentStep(options = {}) {
    if (this._verification || this.state.model_request) return { status: 'busy' };
    const task = this.state.task;
    if (!task || task.status === 'complete' || this.state.mode !== 'coach') return { status: 'inactive' };
    const epoch = this.state.context_epoch, index = task.step_index;
    const token = { controller: new AbortController() };
    this._verification = token;
    const current = () => !token.controller.signal.aborted && !this.closed
      && this.state.task === task && this.state.context_epoch === epoch && task.step_index === index;
    try { return await this._verifyStep({ ...options, current, signal: token.controller.signal }); }
    finally { if (this._verification === token) this._verification = null; }
  }

  async _verifyStep({ frame: suppliedFrame = null, current, signal }) {
    const task = this.state.task;
    if (!task) throw new Error('no active task');
    if (!this.stepVerifier) {
      task.status = 'checking';
      this.state.bubble = { text: '等待当前步骤的验证结果' };
      this._revision();
      this._writeState();
      return { status: 'checking' };
    }
    const latest = this.observationService?.latest({ maxAgeMs: 5000 });
    let frame = suppliedFrame ?? (latest?.status === 'found' ? latest.frame : null);
    if (!frame && typeof this.stepVerifier?.captureFrame === 'function') {
      try {
        frame = await this.stepVerifier.captureFrame({
          task: { ...task, steps: [...task.steps] },
          step: { index: task.step_index, step_id: task.step_id, text: task.steps[task.step_index] ?? '' },
        });
      } catch (error) {
        frame = null;
      }
    }
    if (!current()) { await frame?.release?.(); return {status:'stale'}; }
    task.status = 'checking';
    this.state.bubble = { text: '正在核对当前步骤…' };
    this._revision();
    this._writeState();
    if (!frame) {
      task.status = 'waiting_user';
      this.state.bubble = { text: '没有新鲜画面，无法验证；请恢复观察后再试' };
      this._revision();
      this._writeState();
      return { status: 'unknown', reason: 'no_fresh_frame' };
    }
    let result;
    try {
      result = await this.stepVerifier.verify({
        task: { ...task, steps: [...task.steps] },
        step: {
          index: task.step_index,
          step_id: task.step_id,
          text: task.steps[task.step_index] ?? '',
        },
        frame,
        signal,
      });
    } catch (error) {
      result = { status: 'unknown', reason: `verifier: ${error?.message ?? error}` };
    } finally { await frame?.release?.(); }
    if (!current()) return {status:'stale'};
    if (task.target_window && this.validateStepFrame) {
      try {
        if (!await this.validateStepFrame(frame, task, result)) result = {status:'unknown',reason:'frame_changed'};
      } catch { result = {status:'unknown',reason:'window_unavailable'}; }
    }
    if (!current()) return {status:'stale'};
    const status = result?.status;
    if (status === 'passed') {
      if (result.nextWindow) task.target_window = result.nextWindow;
      const next = task.step_index + 1;
      if (next >= task.steps.length) {
        task.step_index = next;
        task.step_id = stepId(next);
        task.status = 'complete';
        task.expected_result = result.evidence ?? null;
        this.state.bubble = { text: '当前任务已完成' };
      } else {
        task.step_index = next;
        task.step_id = stepId(next);
        task.status = 'waiting_user';
        task.expected_result = null;
        this.state.bubble = { text: task.steps[next] };
      }
      this._emit('当前步骤验证通过', 'assistant_message', { task_id: task.task_id });
      this._dropHighlight('step-advanced');
      if (task.status === 'waiting_user') {
        this._emit(task.steps[task.step_index], 'assistant_message');
        this.guidanceBaseline = result.nextBaseline ?? frame;
        if (result.highlight && this.highlightResolver) {
          try { await this.highlightResolver(result.highlight); } catch { /* next step remains visible as text */ }
        }
      } else {
        this.state.mode = 'standby';
        this._emit('任务的所有步骤已根据当前画面验证完成。', 'assistant_message');
      }
      this._revision();
      this._writeState();
      return { status: 'passed', next_step: task.step_index };
    }
    task.status = 'waiting_user';
    if (result.highlight && this.highlightResolver) {
      try { await this.highlightResolver(result.highlight); } catch { /* keep step */ }
    }
    if (status === 'failed') {
      task.expected_result = null;
      this.state.bubble = { text: '当前步骤验证未通过，未自动重试' };
    } else {
      task.expected_result = null;
      this.state.bubble = { text: '无法确认当前步骤，保留原位等待你核对' };
    }
    this._revision();
    this._writeState();
    return { status: status === 'failed' ? 'failed' : 'unknown', reason: result?.reason ?? null };
  }

  async _handleEvent(item) {
    const { event, path } = item;
    if (!event) {
      return { rejected: true, reason: item.error ?? 'invalid event' };
    }
    if (this._seen.has(event.event_id)) return { duplicate: true };
    validateEvent(event, { assistantSessionId: this.assistantSessionId });
    if (this.closed) return { rejected: true, reason: 'host closed' };
    this.channel.ack(event.event_id, 'accepted');
    try {
      if (event.context_epoch !== this.state.context_epoch) {
        throw new Error('stale context_epoch');
      }
      if (event.kind === 'chat_submit') {
        if (event.payload.text.trim() === '指导状态') {
          this.publishAssistantMessage(JSON.stringify({task:this.state.task,watch:this.guidanceStatus?.() ?? null}));
          this.channel.ack(event.event_id,'handled'); this._seen.add(event.event_id);
          return {handled:true};
        }
        const command = {'暂停指导':'pause_observation','继续指导':'resume_observation',
          '取消指导':'cancel_task','检查当前步骤':'check_step'}[event.payload.text.trim()];
        if (command) return await this._handleEvent({...item,event:{...event,kind:command}});
        if (this.state.task && /^(?:请)?(?:教我|指导我|带我操作)|^指导[：:]/u.test(event.payload.text)) {
          this.endTask('new-guidance');
        } else if (this._verification) {
          this._cancelRequest('user-interjection'); this._bumpEpoch();
        }
      }
      switch (event.kind) {
        case 'chat_submit': {
          if (this.state.model_request) throw new Error('one active model request is allowed');
          this.sceneWakeScheduler?.noteUser(event.payload.text);
          const requestId = newId('request');
          this.state.bubble = { text: '收到，正在处理…' };
          this._revision();
          this._writeState();
          const pending = this._runModel({ event, requestId });
          this._pending.add(pending);
          pending.catch(() => {}).finally(() => this._pending.delete(pending));
          break;
        }
        case 'typing_started':
          this.state.input_enabled = true;
          this._revision();
          this._writeState();
          break;
        case 'typing_ended':
          this.state.input_enabled = true;
          this._revision();
          this._writeState();
          break;
        case 'start_task': {
          this.startTask({
            taskId: event.payload.task_id ?? newId('task'),
            title: event.payload.title ?? '指导任务',
            steps: Array.isArray(event.payload.steps) ? event.payload.steps : [],
          });
          break;
        }
        case 'end_task':
        case 'cancel_task':
          this.endTask(event.kind);
          break;
        case 'check_step':
          if (!this._advanceTaskOrReject(event)) throw new Error('no active task');
          if (!this.state.task) throw new Error('no active task');
          if (this.stepVerifier) await this._verifyCurrentStep();
          else {
            this.state.task.status = 'checking';
            this.state.bubble = { text: '等待当前步骤的验证结果' };
            this._revision();
            this._writeState();
          }
          break;
        case 'skip_step':
          if (!this._advanceTaskOrReject(event)) throw new Error('no active task');
          this.state.task.status = 'waiting_user';
          this.state.task.step_index += 1;
          this.state.task.step_id = stepId(this.state.task.step_index);
          this.state.task.expected_result = null;
          this.state.bubble = { text: '已跳过（未验证）' };
          this._dropHighlight('step-skipped');
          this._revision();
          this._writeState();
          break;
        case 'pause_observation':
          this._cancelRequest('pause');
          this.observationRunner?.pause('user');
          this.sceneWakeScheduler?.stop('pause');
          if (this.observationService) {
            this.observationService.pause('user');
            this._syncObservation();
          } else {
            this.state.observation = { status: 'paused', scope_id: null };
          }
          this.state.mode = 'standby';
          this.state.bubble = { text: '观察已暂停' };
          this._dropHighlight('observation-paused');
          this._bumpEpoch();
          this._revision();
          this._writeState();
          break;
        case 'resume_observation':
          await this._startObservation(event.payload.scope ?? null);
          this.state.mode = this.state.task ? 'coach' : 'companion';
          this.state.bubble = { text: '观察已恢复' };
          this._revision();
          this._writeState();
          break;
        case 'stop_response':
          this._cancelRequest('stop_response');
          this.state.bubble = { text: '已停止当前回答' };
          this._revision();
          this._writeState();
          break;
        case 'close_assistant':
          this.channel.ack(event.event_id, 'handled');
          this.close();
          this._seen.add(event.event_id);
          return { closed: true };
        default:
          throw new Error(`unsupported event: ${event.kind}`);
      }
      this.channel.ack(event.event_id, 'handled');
      this._seen.add(event.event_id);
      return { handled: true, path };
    } catch (error) {
      this.channel.ack(event.event_id, 'rejected', String(error?.message ?? error));
      this._seen.add(event.event_id);
      return { rejected: true, reason: String(error?.message ?? error) };
    }
  }

  async poll() {
    if (!this.started || this.closed) return { processed: 0 };
    if (this.state.highlight?.expires_at
        && Date.parse(this.state.highlight.expires_at) <= this.clock().getTime()) {
      this.clearHighlight('已过期');
    }
    this.channel.heartbeat();
    const items = this.channel.readInbox();
    let processed = 0;
    for (const item of items) {
      const eventId = item.event?.event_id;
      if (eventId && this._seen.has(eventId)) continue;
      if (eventId) {
        const ack = this.channel.readAck(eventId);
        if (ack && ack.status !== 'accepted') {
          this._seen.add(eventId);
          continue;
        }
      }
      const result = await this._handleEvent(item);
      processed += 1;
      if (result.closed) break;
    }
    return { processed, state: this._snapshot() };
  }

  async waitForIdle() {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }

  submit(event) {
    return this.channel.submitEvent(event);
  }

  close() {
    if (this.closed) return this.state;
    this.closed = true;
    this._cancelRequest('close');
    this.observationRunner?.stop('close');
    this.sceneWakeScheduler?.stop('close');
    this.observationService?.stop('close');
    this._syncObservation();
    this.state.highlight = null;
    this.state.assistant = 'closing';
    this._revision();
    try { this._writeState(); } catch { /* closing must not be blocked */ }
    this.state.assistant = 'closed';
    this.state.bubble = { text: '已关闭' };
    this._revision();
    try { this._writeState(); } catch { /* best effort */ }
    this.channel.close();
    return this.state;
  }
}

export function stepId(index) {
  return `step-${index + 1}`;
}

export function makeAssistantEvent({ host, kind, payload = {}, clientSeq = 1, contextEpoch = null } = {}) {
  return makeEvent({
    assistantSessionId: host.assistantSessionId,
    kind,
    clientSeq,
    contextEpoch: contextEpoch ?? host.state.context_epoch,
    taskId: host.state.task?.task_id ?? null,
    payload,
  });
}
