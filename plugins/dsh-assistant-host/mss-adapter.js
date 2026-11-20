/**
 * One-shot mss capture adapter for the resident Host.
 *
 * This is the no-ffmpeg path: the Node Host invokes the project's Python mss
 * helper once and turns its JSON into an ObservationService frame. It does not
 * poll, run a background capture loop, call a model or send input.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { FrameChangeAnalyzer, makeThumbnail } from './frame-analysis.js';

const DEFAULT_PYTHON = resolve('.venv', 'Scripts', 'python.exe');
const DEFAULT_SCRIPT = resolve('tools', 'coach_overlay', 'capture_once.py');

function runCapture({ pythonPath, scriptPath, outdir, scope, timeoutMs }) {
  const args = [scriptPath, '--outdir', outdir];
  if (scope?.foregroundWindow) args.push('--foreground-window');
  if (scope?.desktopWindows) args.push('--desktop-windows');
  if (scope?.pid) args.push('--target-pid', String(scope.pid));
  for (const pid of scope?.excludePids ?? []) {
    if (Number.isSafeInteger(pid) && pid > 0) args.push('--exclude-pid', String(pid));
  }
  if (scope?.hwnd) args.push('--hwnd', String(scope.hwnd));
  else if (scope?.bounds) {
    args.push('--region', String(scope.bounds.left), String(scope.bounds.top),
      String(scope.bounds.width), String(scope.bounds.height));
  } else {
    args.push('--monitor', String(scope?.monitor ?? 1));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, args, {
      cwd: resolve('.'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`mss capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        let detail = stderr.trim();
        try {
          const failed = JSON.parse(stdout.trim());
          if (failed?.error) detail = `${detail}${detail ? ' ' : ''}${failed.error}`;
        } catch { /* keep stderr */ }
        reject(new Error(`mss capture exited ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        const value = JSON.parse(stdout.trim());
        if (value.ok !== true) throw new Error(value.error ?? 'capture failed');
        resolvePromise(value);
      } catch (error) {
        reject(new Error(`invalid mss capture output: ${error?.message ?? error}`));
      }
    });
  });
}

function assertWindowGeometry(scope, result, tolerance) {
  if (scope?.kind !== 'window' || !scope.bounds || !result?.bounds) return;
  const actual = result.bounds;
  const expected = scope.bounds;
  const mismatch = ['left', 'top', 'width', 'height'].some(
    key => Math.abs(Number(actual[key]) - Number(expected[key])) > tolerance,
  );
  if (mismatch) {
    throw new Error(`geometry_changed: expected ${JSON.stringify(expected)} `
      + `got ${JSON.stringify(actual)}`);
  }
}

export function createMssAdapter({
  pythonPath = DEFAULT_PYTHON,
  scriptPath = DEFAULT_SCRIPT,
  outdir = join('runtime', 'assistant-observation'),
  timeoutMs = 10000,
  maxThumbnails = 8,
  geometryTolerance = 2,
} = {}) {
  if (!existsSync(pythonPath)) throw new Error(`mss python missing: ${pythonPath}`);
  if (!existsSync(scriptPath)) throw new Error(`mss capture helper missing: ${scriptPath}`);
  if (!Number.isInteger(maxThumbnails) || maxThumbnails < 1 || maxThumbnails > 64) {
    throw new Error('maxThumbnails must be 1..64');
  }
  if (!Number.isInteger(geometryTolerance) || geometryTolerance < 0 || geometryTolerance > 64) {
    throw new Error('geometryTolerance must be 0..64');
  }
  const previousRaw = new Map();
  const analyzers = new Map();
  const thumbnailQueues = new Map();
  return {
    kind: 'mss',
    async capture({ scope, frameId = `frame-${Date.now()}` } = {}) {
      if (!scope) throw new Error('scope is required');
      const key = `${scope.scope_id}\u0000${scope.geometry_revision}`;
      const result = await runCapture({
        pythonPath, scriptPath, outdir, scope, timeoutMs,
      });
      assertWindowGeometry(scope, result, geometryTolerance);
      const raw = await readFile(result.raw_path);
      const analysisKey = `${key}\u0000${result.width}x${result.height}`;
      let analyzer = analyzers.get(analysisKey);
      if (!analyzer) {
        analyzer = new FrameChangeAnalyzer();
        analyzers.set(analysisKey, analyzer);
      }
      const analysis = analyzer.analyze(raw, result.width, result.height);
      let sourceBbox = analysis.change_bbox;
      if (!sourceBbox && analysis.first_frame) {
        sourceBbox = { left: 0, top: 0, width: result.width, height: result.height };
      }
      let thumbnailRef = null;
      let thumbnailError = null;
      let thumbnailSkipped = null;
      if (!sourceBbox) {
        thumbnailSkipped = 'no_significant_region';
      } else {
        try {
          const thumb = makeThumbnail(raw, result.width, result.height, sourceBbox);
          const thumbDir = join(outdir, 'thumbs');
          await mkdir(thumbDir, { recursive: true });
          const safeId = String(frameId).replace(/[^A-Za-z0-9_-]/g, '_');
          const thumbPath = join(thumbDir, `thumb-${safeId}.png`);
          await writeFile(thumbPath, thumb.png);
          thumbnailRef = resolve(thumbPath);
          analysis.thumbnail_source_bbox = thumb.source_bbox;
          analysis.thumbnail_width = thumb.width;
          analysis.thumbnail_height = thumb.height;
          const queue = thumbnailQueues.get(key) ?? [];
          queue.push(thumbPath);
          while (queue.length > maxThumbnails) {
            const old = queue.shift();
            unlink(old).catch(() => {});
          }
          thumbnailQueues.set(key, queue);
        } catch (error) {
          thumbnailError = String(error?.message ?? error);
        }
      }
      const priorRaw = previousRaw.get(key);
      if (priorRaw && priorRaw !== result.raw_path) unlink(priorRaw).catch(() => {});
      previousRaw.set(key, result.raw_path);
      return {
        frame_id: frameId,
        scope_id: scope.scope_id,
        geometry_revision: scope.geometry_revision,
        captured_at: result.captured_at,
        changed_score: analysis.changed_score,
        changed_ratio: analysis.changed_ratio,
        change_bbox: analysis.change_bbox,
        change_regions: analysis.change_regions,
        filtered_regions: analysis.filtered_regions,
        first_frame: analysis.first_frame,
        dimensions_changed: analysis.dimensions_changed,
        thumbnail_ref: thumbnailRef,
        thumbnail_width: thumbnailRef ? analysis.thumbnail_width : null,
        thumbnail_height: thumbnailRef ? analysis.thumbnail_height : null,
        thumbnail_source_bbox: analysis.thumbnail_source_bbox ?? null,
        ...(thumbnailSkipped ? { thumbnail_skipped: thumbnailSkipped } : {}),
        ...(thumbnailError ? { thumbnail_error: thumbnailError } : {}),
        width: result.width,
        height: result.height,
        image_ref: result.image?.path ?? null,
        source: 'mss',
        bounds: result.bounds,
        raw_ref: result.raw_path,
        target_window: result.target_window ?? null,
        windows: result.windows ?? null,
        capture_scope: result.capture_scope ?? 'window',
      };
    },
  };
}
