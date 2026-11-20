import { FrameChangeAnalyzer } from './frame-analysis.js';

export function frameGeometry(frame) {
  return JSON.stringify([frame.bounds, frame.target_window?.hwnd, frame.target_window?.pid,
    frame.target_window?.foreground, frame.target_window?.window_geometry,
    frame.capture_scope === 'desktop' ? frame.windows?.map(w=>[w.hwnd,w.pid,w.rect]) : null]);
}

export function sameScene(before, after) {
  if (frameGeometry(before) !== frameGeometry(after)) return false;
  const analyzer = new FrameChangeAnalyzer();
  analyzer.analyze(before.raw, before.width, before.height);
  return !analyzer.analyze(after.raw, after.width, after.height).change_bbox;
}

/** True while the user/assistant makes the target temporarily uncapturable. */
export function temporaryCaptureError(error) {
  return /助手面板中交互|GUIDANCE_WINDOW_NOT_FOREGROUND|目标窗口暂时不在前台|暂缓自动观察/u
    .test(String(error?.message ?? error));
}

/** Local change/stability gate. Never treats movement or a click as success. */
export class TaskWatch {
  constructor({ host, capture, now = Date.now, intervalMs = 2000, cooldownMs = 8000 }) {
    Object.assign(this, { host, capture, now, intervalMs, cooldownMs });
    this.next = 0; this.lastCall = -Infinity; this.busy = false;
    this.key = null; this.stage = 'idle'; this.calls = 0;
  }
  reset() { this.key = null; this.stage = 'idle'; this.next = 0; }
  status() { return { stage: this.stage, calls: this.calls, interval_ms: this.intervalMs }; }
  async tick() {
    const host = this.host, task = host.state.task;
    if (host.closed || host.state.mode !== 'coach' || !task?.target_window || task.status !== 'waiting_user') {
      if (!this.busy) this.reset();
      return;
    }
    if (this.busy || host.state.model_request || host._verification || this.now() < this.next) return;
    this.busy = true; this.next = this.now() + this.intervalMs;
    const key = `${task.task_id}:${task.step_id}:${host.state.context_epoch}`;
    const valid = () => !host.closed && host.state.mode === 'coach' && host.state.task === task
      && key === `${task.task_id}:${task.step_id}:${host.state.context_epoch}`;
    let frame;
    try {
      if (key !== this.key) {
        this.key = key; this.analyzer = new FrameChangeAnalyzer(); this.geometry = null;
        this.dirty = false; this.stable = 0;
        const seed = host.guidanceBaseline;
        host.guidanceBaseline = null;
        if (seed?.raw) {
          this.analyzer.analyze(seed.raw, seed.width, seed.height);
          this.geometry = frameGeometry(seed);
        }
      }
      frame = await this.capture({ task, watch: true });
      if (!valid()) return;
      const geometry = frameGeometry(frame);
      const change = this.analyzer.analyze(frame.raw, frame.width, frame.height);
      if (change.change_bbox || (this.geometry !== null && this.geometry !== geometry)) {
        this.dirty = true; this.stable = 0; this.stage = 'waiting_stable';
        host.clearHighlight('画面变化，等待稳定');
      } else {
        this.stable += 1;
        this.stage = this.dirty ? 'waiting_stable' : 'waiting_change';
      }
      this.geometry = geometry;
      if (!this.dirty || this.stable < 2 || this.now() - this.lastCall < this.cooldownMs) return;
      this.dirty = false; this.lastCall = this.now(); this.calls++; this.stage = 'checking';
      await host._verifyCurrentStep({ frame });
      if (valid()) this.stage = 'waiting_change';
    } catch (error) {
      if (valid()) {
        this.stage = 'waiting_window'; this.dirty = true; this.stable = 0;
        // Orb focus or a temporarily background target must not erase a valid
        // highlight. Only a real capture/content failure clears it.
        if (!temporaryCaptureError(error)) host.clearHighlight('目标窗口暂不可观察');
      }
    } finally {
      await frame?.release?.();
      this.busy = false;
    }
  }
}
