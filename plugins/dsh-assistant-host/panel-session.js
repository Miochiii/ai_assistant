/**
 * Manual resident panel session.
 *
 * `/assistant-open` starts the Orb helper and a small Host/channel so the
 * panel can display model suggestions. WDA capture exclusion is off by default:
 * on some Windows/NVIDIA setups it also made the panel invisible to the user.
 * It is explicit: nothing launches at plugin load.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { UiChannel } from './ui-channel.js';
import { ResidentHost } from './resident-host.js';
import { startResidentUi } from './ui-process.js';
import { HighlightController } from './highlight-controller.js';
import { PanelStepVerifier } from './panel-guidance.js';
import { createMssAdapter } from './mss-adapter.js';
import { TaskWatch, sameScene, frameGeometry, temporaryCaptureError } from './task-watch.js';
import { guidanceScope, confirmVisualWindow } from './desktop-grounding.js';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export class PanelSession {
  constructor({
    sessionId,
    root = null,
    pythonPath = 'E:\\python\\python.exe',
    panelPath = join(ROOT, 'plugins', 'dsh-assistant-host', 'orb-helper.cjs'),
    executablePath = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'DesktopAssistant', 'runtimes', 'electron-44.0.0', 'electron.exe'),
    excludeCapture = false,
    model = null,
    highlighter = null,
    ctx = null,
    route = {},
    captureMode = 'desktop',
    diagnostics = false,
    makeCaptureAdapter = createMssAdapter,
  } = {}) {
    if (!sessionId) throw new Error('sessionId is required');
    this.sessionId = sessionId;
    this.root = root ?? join(ROOT, 'runtime', 'assistant-panel', createHash('sha256').update(sessionId).digest('hex').slice(0, 24));
    this.pythonPath = pythonPath;
    this.panelPath = panelPath;
    this.executablePath = panelPath.endsWith('.cjs') ? executablePath : null;
    this.excludeCapture = excludeCapture;
    this.model = model;
    this.ctx = ctx;
    this.route = route;
    this.captureMode = captureMode;
    this.diagnostics = diagnostics;
    this.makeCaptureAdapter = makeCaptureAdapter;
    if (model) {
      model.observe = () => this.captureFrame({task:this.host?.state.task});
      model.bindDesktopTarget = async (frame, visual) => {
        const fresh = await this.captureFrame();
        try {
          const result=confirmVisualWindow(frame,fresh,visual);
          this.lastGuidanceFrame=result.baseline;
          return result;
        } finally {await fresh.release?.();}
      };
      model.validateObservation = async frame => {
        // The user is normally still in Orb when the model replies. Do not use
        // the auto-watch focus gate here; hide the assistant and take a fresh
        // target-window frame instead.
        const fresh = await this.captureFrame({task:{target_window:frame.target_window},watch:false});
        try { return sameScene(frame, fresh); } finally { await fresh.release?.(); }
      };
    }
    this.highlighter = highlighter ?? new HighlightController({
      root: join(ROOT, 'runtime', 'assistant-highlight', createHash('sha256').update(sessionId).digest('hex').slice(0, 24)),
      pythonPath,
      locatorPythonPath: join(ROOT, '.venv', 'Scripts', 'python.exe'),
      overlayPath: join(ROOT, 'tools', 'coach_overlay', 'coach_overlay.py'),
      locatorPath: join(ROOT, 'tools', 'coach_overlay', 'highlight_locator.py'),
    });
    this.channel = null;
    this.host = null;
    this.ui = null;
    this.timer = null;
    this.opened = false;
    this.closing = false;
    this.captureQueue = Promise.resolve();
  }

  async _cleanStale() {
    const lockPath = join(this.root, 'instance.lock');
    const lock = await readJson(lockPath);
    if (lock && Number.isSafeInteger(lock.pid) && lock.pid !== process.pid && pidAlive(lock.pid)) {
      throw new Error(`助手面板 Host 已被其他进程占用：pid=${lock.pid}`);
    }
    const ready = await readJson(join(this.root, 'ui-ready.json'));
    if (ready && Number.isSafeInteger(ready.pid) && ready.pid !== process.pid && pidAlive(ready.pid)) {
      try { process.kill(ready.pid); } catch { /* stale UI best effort */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    // A failed Host.initialize leaves a lock and a state revision behind.
    // Remove only the known channel files, never the whole directory.
    for (const name of ['instance.lock', 'instance.json', 'state.json', 'ui-ready.json', 'ui-heartbeat.json']) {
      try { await rm(join(this.root, name), { force: true }); } catch { /* best effort */ }
    }
  }

  async open() {
    if (this.ui?.status?.().alive) return { opened: true, already: true, root: this.root };
    this.closing = false;
    await mkdir(this.root, { recursive: true });
    await this._cleanStale();
    const assistantSessionId = `instance-panel-${randomUUID()}`;
    this.channel = new UiChannel(this.root, { assistantSessionId });
    this.verifier = this.ctx?.llm
      ? new PanelStepVerifier({
        ctx: this.ctx,
        sessionId: this.sessionId,
        captureFrame: options => this.captureFrame(options),
        route: this.route,
      })
      : null;
    this.host = new ResidentHost({
      channel: this.channel,
      ...(this.model ? { model: this.model } : {}),
      ...(this.verifier ? { stepVerifier: this.verifier } : {}),
      validateStepFrame: (frame,task,result) => this.validateStepFrame(frame,task,result),
      onState: state => {
        if (this.closing) return;
        void Promise.resolve(this.highlighter.update(state.highlight)).catch(() => {});
      },
      highlightResolver: target => this._resolveHighlight(target),
    });
    this.taskWatch = new TaskWatch({host:this.host,capture: options => this.captureFrame(options)});
    this.host.guidanceStatus = () => this.taskWatch.status();
    try {
      this.host.initialize();
      this.ui = await startResidentUi({
        channelDir: this.root,
        assistantSessionId,
        pythonPath: this.pythonPath,
        executablePath: this.executablePath,
        diagnostics: this.diagnostics,
        panelPath: this.panelPath,
        excludeCapture: this.excludeCapture,
        noSound: true,
        timeoutMs: 8000,
      });
      this.opened = true;
      this.timer = setInterval(async () => {
        if (!this.opened) return;
        try {
          await this.host.poll();
          void this.taskWatch.tick().catch(() => {});
          if (!this.model?.active) void this.model?.daily?.tick();
          if (this.channel.readState()?.assistant === 'closed') await this.close('panel-closed');
        } catch { /* keep UI; next tick may recover */ }
      }, 150);
      this.timer.unref?.();
      return { opened: true, root: this.root, ui_pid: this.ui.child.pid };
    } catch (error) {
      await this.close('open-failed');
      throw error;
    }
  }

  publish(text, { kind = 'wake_suggestion' } = {}) {
    if (!this.opened || !this.host) return null;
    if (kind === 'wake_suggestion' && this.host.state.task && this.host.state.task.status !== 'complete') return null;
    const message = this.host.publishAssistantMessage(text, { kind });
    if (message && kind === 'wake_suggestion') this.model?.noteObservation?.(text);
    return message;
  }

  async highlightTarget(target, { text = null } = {}) {
    return this._resolveHighlight(target, { text });
  }

  async _resolveHighlight(target, { text = null } = {}) {
    if (!this.host || this.closing) throw new Error('panel is not open');
    const host = this.host, epoch = host.state.context_epoch;
    if (target && typeof target === 'object') {
      const age = Date.now() - Date.parse(target.capturedAt);
      if (!Number.isFinite(age) || age < 0 || age > 60000) throw Error('截图已过期，请重新指导');
      return this.host.setHighlight({ ...target, expiresAt: new Date(Date.now() + 10000).toISOString() });
    }
    const located = await this.highlighter.locate(target);
    if (this.closing || this.host !== host || host.state.context_epoch !== epoch) {
      throw new Error('指导上下文已改变');
    }
    if (!located.ok) {
      throw new Error(`无法定位目标“${target}”：${located.reason ?? 'unknown'}`);
    }
    return this.host.setHighlight({
      text: text || `查看：${target}`,
      target,
      rect: located.rect,
      observationId: null,
      geometryRevision: null,
    });
  }

  captureFrame(options = {}) {
    const result = this.captureQueue.then(() => {
      if (this.closing) throw Error('助手正在关闭');
      return this._captureFrame(options);
    });
    this.captureQueue = result.catch(() => {});
    return result;
  }

  async validateStepFrame(frame,task,result) {
    if (frame.capture_scope === 'desktop') {
      // A new foreground window is evidence to inspect, not permission to
      // switch tasks. Only a passed visible postcondition can rebind it.
      if (result?.status !== 'passed' || !result.visual) return false;
      const fresh=await this.captureFrame({transition:true});
      try {
        const confirmed=confirmVisualWindow(frame,fresh,result.visual);
        result.nextWindow=confirmed.binding;
        result.nextBaseline=confirmed.baseline;
        if(result.highlight) {
          result.highlight.targetHwnd=confirmed.binding.foreground;
          result.highlight.windowGeometry=confirmed.binding.window_geometry;
        }
        return true;
      } finally {await fresh.release?.();}
    }
    const fresh=await this.captureFrame({task,watch:true});
    try {return sameScene(frame,fresh);} finally {await fresh.release?.();}
  }

  async _captureFrame({ task = null, step = null, watch = false, transition = false } = {}) {
    if (watch) {
      const heartbeat = await readJson(join(this.root,'ui-heartbeat.json'));
      if (heartbeat?.focused && Date.now() - Date.parse(heartbeat.at) < 2000) {
        throw Error('用户正在助手面板中交互，暂缓自动观察');
      }
    }
    const captureId = randomUUID();
    const captureDir = join(this.root, 'captures', captureId);
    const adapter = this.makeCaptureAdapter({
      pythonPath: join(ROOT, '.venv', 'Scripts', 'python.exe'),
      scriptPath: join(ROOT, 'tools', 'coach_overlay', 'capture_once.py'),
      outdir: captureDir,
    });
    const visibility = join(this.root, 'capture-visibility.json');
    try {
      if (watch && this.highlighter.suspendForCapture) await this.highlighter.suspendForCapture();
      else {
        await this.highlighter.update(null);
        this.host?.clearHighlight('准备新截图');
      }
      // Hiding the Orb on every 2s watch capture makes the panel visibly flash.
      // A bound-window crop excludes the Orb when it is outside the target; keep
      // it visible during watch. Initial/full-desktop captures still hide it.
      if (this.ui && this.executablePath && !watch) {
        await writeFile(visibility, JSON.stringify({ id: captureId, expires: Date.now() + 15000 }));
        let hidden = false;
        for (let i = 0; i < 40; i++) {
          if ((await readJson(join(this.root, 'capture-hidden.json')))?.id === captureId) { hidden = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!hidden) throw Error('悬浮球隐藏确认超时');
      }
      const excludePids = [this.ui?.child?.pid, this.highlighter.child?.pid].filter(Number.isSafeInteger);
      const scope = transition ? guidanceScope(null,excludePids) : task
        ? guidanceScope(task, excludePids)
        : this.captureMode === 'desktop'
          ? guidanceScope(null, excludePids)
          : { kind: 'window', foregroundWindow: true,
              scope_id: 'guidance-foreground', excludePids };
      let frame;
      try {
        frame = await adapter.capture({
          scope: { ...scope, geometry_revision: `guidance-${Date.now()}` },
          frameId: `guidance-${Date.now()}`,
        });
      } catch (error) {
        if (task?.target_window && /different_foreground_window|target_hidden_or_minimized|target_identity_changed/.test(String(error?.message))) {
          this.host?.clearHighlight('界面已切换，重新观察当前步骤');
          await rm(captureDir,{recursive:true,force:true});
          // Do not queue behind our own capture. This explicit desktop capture
          // hides the Orb as well, including when the caller is the watch loop.
          return await this._captureFrame({transition:true});
        }
        // Route A is preferred, but hiding a focused Orb can leave Windows
        // reporting the hidden assistant as foreground. For the initial,
        // unbound capture, fall back to the full desktop visual path so the
        // user still gets a chance to locate the visible target window.
        if (!task && String(error?.message).includes('GUIDANCE_WINDOW_NOT_FOREGROUND')) {
          frame = await adapter.capture({
            scope: { ...guidanceScope(null, excludePids), geometry_revision: `guidance-desktop-${Date.now()}` },
            frameId: `guidance-desktop-${Date.now()}`,
          });
        } else {
          throw error;
        }
      }
      frame.raw = await readFile(frame.raw_ref);
      if (this.closing) throw Error('助手正在关闭');
      const sameGeometry = this.lastGuidanceFrame
        && frameGeometry(this.lastGuidanceFrame) === frameGeometry(frame);
      if (watch && this.lastGuidanceFrame && (!sameGeometry
          || !sameScene(this.lastGuidanceFrame, frame))) {
        this.host?.clearHighlight(sameGeometry ? '目标画面已变化' : '目标窗口几何已变化');
      } else if (watch && this.lastGuidanceFrame && this.host?.state.highlight) {
        this.host.state.highlight.expires_at = new Date(Date.now() + 10000).toISOString();
        this.host._revision(); this.host._writeState();
      }
      this.lastGuidanceFrame = frame;
      return { ...frame, release: () => rm(captureDir, { recursive: true, force: true }) };
    } catch (error) {
      if (watch && !temporaryCaptureError(error)) this.host?.clearHighlight('目标窗口不可观察');
      await rm(captureDir, { recursive: true, force: true });
      if (String(error?.message).includes('GUIDANCE_WINDOW_NOT_FOREGROUND')) {
        await writeFile(join(this.root,'capture-diagnostic.json'),JSON.stringify({
          at:new Date().toISOString(),stage:task?.target_window?'bound-window':'initial-window',
          reason:String(error.message).slice(0,500),
          target:task?.target_window?{hwnd:task.target_window.hwnd,pid:task.target_window.pid}:null,
        })).catch(()=>{});
        throw Object.assign(new Error(task?.target_window
          ? '目标窗口暂时不在前台。请切回正在指导的窗口；任务观察会在窗口可见后继续。'
          : '未能取得当前软件窗口。请将要操作的软件切到前台，再在助手中发送指导请求。'),
        {code:'GUIDANCE_WINDOW_NOT_FOREGROUND',cause:error});
      }
      throw error;
    } finally {
      await rm(visibility, { force: true });
      if (watch) await this.highlighter.resumeAfterCapture?.(this.closing ? null : this.host?.state.highlight);
    }
  }

  clearHighlight(reason = 'user') {
    return this.host?.clearHighlight(reason) ?? null;
  }

  status() {
    return {
      opened: this.opened,
      root: this.root,
      ui_pid: this.ui?.child?.pid ?? null,
      ui_alive: Boolean(this.ui?.status?.().alive),
      exclude_capture: this.excludeCapture,
      task_watch: this.taskWatch?.status() ?? null,
    };
  }

  async close(reason = 'user') {
    this.closing = true;
    this.opened = false;
    this.model?.reset?.();
    this.host?.close();
    this.lastGuidanceFrame = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { await this.highlighter.stop(); } catch { /* best effort */ }
    const ready = this.ui ? null : await readJson(join(this.root, 'ui-ready.json'));
    const uiPid = this.ui?.child?.pid ?? ready?.pid;
    if (Number.isSafeInteger(uiPid) && uiPid !== process.pid && pidAlive(uiPid)) {
      try { process.kill(uiPid); } catch { /* best effort */ }
    }
    try { this.host?.close(); } catch { /* best effort */ }
    try { await this.ui?.stop(); } catch { /* best effort */ }
    try { await rm(join(this.root, 'instance.lock'), { force: true }); } catch { /* best effort */ }
    this.host = null;
    this.ui = null;
    this.channel = null;
    return { closed: true, reason };
  }
}

export function createPanelSession(options) {
  return new PanelSession(options);
}
