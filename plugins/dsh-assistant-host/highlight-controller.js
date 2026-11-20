/**
 * Display-only highlight controller.
 *
 * The Node Host owns the highlight state. This controller mirrors it into the
 * existing click-through Coach overlay and starts/stops that overlay process.
 * It never sends desktop input and never treats a drawn box as verification.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const runFile = promisify(execFile);

export class HighlightController {
  constructor({
    root,
    pythonPath = 'E:\\python\\python.exe',
    locatorPythonPath = null,
    overlayPath = join(process.cwd(), 'tools', 'coach_overlay', 'coach_overlay.py'),
    locatorPath = join(process.cwd(), 'tools', 'coach_overlay', 'highlight_locator.py'),
    spawnProcess = spawn,
    runExec = runFile,
    now = () => new Date(),
  } = {}) {
    if (!root) throw new Error('highlight root is required');
    this.root = root;
    this.pythonPath = pythonPath;
    this.locatorPythonPath = locatorPythonPath ?? pythonPath;
    this.overlayPath = overlayPath;
    this.locatorPath = locatorPath;
    this.spawnProcess = spawnProcess;
    this.runExec = runExec;
    this.now = now;
    this.statePath = join(root, 'state.json');
    this.child = null;
    this.generation = 0;
    this.last = null;
    this.queue = Promise.resolve();
  }

  _enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async start() {
    if (this.child && this.child.exitCode === null) return;
    await mkdir(this.root, { recursive: true });
    this.child = this.spawnProcess(this.pythonPath, [
      this.overlayPath,
      '--state-file', this.statePath,
      '--no-panel',
      '--no-sound',
      '--max-age', '60',
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr?.on('data', () => {});
    const child = this.child;
    child.once('error', () => { if (this.child === child) this.child = null; });
  }

  update(highlight) {
    return this._enqueue(() => this._update(highlight));
  }

  async _update(highlight) {
    if (this.captureHidden) return;
    if (!highlight) {
      this.last = null;
      if (!this.child) return;
      this.generation += 1;
      await this._write({
        visible: false,
        generation: this.generation,
        observed_at: this.now().toISOString(),
      });
      // A hidden overlay has no reason to keep a Tk process around.
      await this._stop();
      return;
    }
    if (highlight.highlight_id && this.last?.highlight_id === highlight.highlight_id
        && this.child?.exitCode === null) return;
    await this.start();
    this.last = highlight;
    this.generation += 1;
    await this._write({
      visible: true,
      generation: this.generation,
      observed_at: this.now().toISOString(),
      steps: [{
        rect: highlight.rect,
        text: highlight.text,
      }],
      step_index: 0,
      ...(Number.isSafeInteger(highlight.target_hwnd)
        ? { target_hwnd: highlight.target_hwnd }
        : {}),
      ...(highlight.window_geometry ? {window_geometry:highlight.window_geometry} : {}),
    });
  }

  async _write(value) {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `.state-${process.pid}-${randomUUID()}.tmp`);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temp, body, 'utf8');
    try {
      await rename(temp, this.statePath);
    } catch (error) {
      // The overlay may be reading state.json under Windows sharing rules.
      // Retry once, then replace in place rather than losing the highlight.
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error?.code)) throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      try {
        await rename(temp, this.statePath);
      } catch {
        await writeFile(this.statePath, body, 'utf8');
        await rm(temp, { force: true });
      }
    }
  }

  async suspendForCapture() {
    return this._enqueue(async () => {
      this.captureHidden = true;
      if (this.child) {
        await this._write({visible:false,generation:++this.generation,observed_at:this.now().toISOString()});
        for (let i=0;i<30;i++) {
          try {
            const ack=JSON.parse(await readFile(join(this.root,'state.hidden.json'),'utf8'));
            if (ack.generation === this.generation) return;
          } catch { /* awaiting the overlay's hidden acknowledgement */ }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('高亮隐藏确认超时');
      }
    });
  }

  async resumeAfterCapture(highlight) {
    return this._enqueue(async () => {
      this.captureHidden = false;
      this.last = null;
      await this._update(highlight);
    });
  }

  async locate(target) {
    if (typeof target !== 'string' || !target.trim()) {
      return { ok: false, reason: 'empty_target' };
    }
    try {
      const { stdout } = await this.runExec(this.locatorPythonPath, [
        '-B', this.locatorPath, '--target', target.trim(),
      ], { cwd: process.cwd(), timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true });
      const value = JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '{}');
      if (!value.ok || !Array.isArray(value.rect) || value.rect.length !== 4) {
        return value;
      }
      return value;
    } catch (error) {
      return { ok: false, reason: 'locator_failed', message: String(error?.message ?? error).slice(0, 300) };
    }
  }

  stop() {
    return this._enqueue(() => this._stop());
  }

  async _stop() {
    const child = this.child;
    this.child = null;
    this.last = null;
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 800);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill(); } catch { clearTimeout(timer); resolve(); }
      });
    }
    try { await rm(this.statePath, { force: true }); } catch { /* best effort */ }
    try { await rm(join(this.root,'state.hidden.json'), { force: true }); } catch { /* best effort */ }
  }

  status() {
    return {
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid ?? null,
      generation: this.generation,
      last: this.last,
    };
  }
}

export function createHighlightController(options) {
  return new HighlightController(options);
}
