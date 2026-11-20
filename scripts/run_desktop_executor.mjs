// Fixed executor launcher for the Harness: normal user integrity, no .venv change.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cachedPython;

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function basePython() {
  if (cachedPython) return cachedPython;
  const config = path.join(ROOT, '.venv', 'pyvenv.cfg');
  if (existsSync(config)) {
    for (const line of readFileSync(config, 'utf8').split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index < 0 || line.slice(0, index).trim() !== 'base-executable') continue;
      const candidate = line.slice(index + 1).trim().replace(/^"|"$/g, '');
      if (candidate && existsSync(candidate)) {
        cachedPython = candidate;
        return cachedPython;
      }
    }
  }
  if (process.env.DSH_BASE_PYTHON && existsSync(process.env.DSH_BASE_PYTHON)) {
    cachedPython = process.env.DSH_BASE_PYTHON;
    return cachedPython;
  }
  throw new ExecutorError('EXECUTOR_PYTHON_MISSING',
    'Cannot resolve the base Python from .venv/pyvenv.cfg or DSH_BASE_PYTHON');
}

function runScript(scriptName, extraArgs, stdin, timeoutMs, { signal, cancelGraceMs = 1500, harnessSession } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecutorError('EXECUTOR_CANCELLED', 'Cancelled before the executor was launched'));
      return;
    }
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timer;
    let killTimer;
    let cancelled = false;
    let timedOut = false;
    let outputTooLarge = false;
    const cancelPath = path.join(ROOT, 'runtime', 'cancellations', `${randomUUID()}.cancel`);
    mkdirSync(path.dirname(cancelPath), { recursive: true });
    const child = spawn(basePython(), ['-B', path.join(ROOT, 'scripts', scriptName), ...extraArgs], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_EXECUTOR_CANCEL_FILE: cancelPath, DSH_SESSION_ID: harnessSession ?? '' },
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      try { unlinkSync(cancelPath); } catch { /* already absent */ }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const requestCancel = () => {
      try { writeFileSync(cancelPath, 'cancel', 'utf8'); } catch { /* best effort */ }
      if (!killTimer) {
        killTimer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, cancelGraceMs);
      }
    };
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      requestCancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      requestCancel();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        outputTooLarge = true;
        stdout = stdout.slice(0, 2_000_000);
        requestCancel();
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.once('error', () => finish(reject, new ExecutorError('EXECUTOR_LAUNCH_FAILED', 'Cannot start the executor')));
    child.once('close', code => {
      if (outputTooLarge) {
        finish(reject, new ExecutorError('EXECUTOR_OUTPUT_TOO_LARGE',
          'Executor output exceeded the limit; outcome unknown, no retry'));
        return;
      }
      if (timedOut) {
        finish(reject, new ExecutorError('EXECUTOR_TIMEOUT',
          'Executor timed out; outcome unknown, no retry'));
        return;
      }
      if (cancelled && !stdout.trim()) {
        finish(reject, new ExecutorError('EXECUTOR_CANCELLED',
          'Executor cancelled; outcome unknown, no retry'));
        return;
      }
      finish(resolve, { code, stdout, stderr, cancelled });
    });
    if (stdin !== undefined && stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function runProcess(extraArgs, stdin, timeoutMs, options) {
  return runScript('desktop_executor.py', extraArgs, stdin, timeoutMs, options);
}

function parseReceipt(output) {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new ExecutorError('EXECUTOR_BAD_OUTPUT', 'Executor returned no JSON receipt');
  }
}

export async function runWindowActivate(hwnd, { timeoutMs = 30_000, signal } = {}) {
  const result = await runScript('window_activate.py', ['--hwnd', String(hwnd)], null, timeoutMs, { signal });
  const receipt = parseReceipt(result.stdout);
  receipt.exit_code = result.code;
  if (result.cancelled) receipt.launcher_cancelled = true;
  return receipt;
}

export function buildRequest(manifestPath, label, center, expected = '', grantId) {
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isInteger)) {
    throw new ExecutorError('TARGET_INVALID', 'Target must be [x, y] in image pixels');
  }
  if (center[0] < 0 || center[0] >= image.width || center[1] < 0 || center[1] >= image.height) {
    throw new ExecutorError('TARGET_OUT_OF_IMAGE', 'Target is outside the observation image');
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...center] },
    action: { type: 'click', button: 'left' },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export async function click(manifestPath, label, center, expected = '', options = {}) {
  return runExecutor(buildRequest(manifestPath, label, center, expected), options);
}

export function buildScrollRequest(manifestPath, label, center, notches, expected = '', grantId) {
  if (!Number.isSafeInteger(notches) || notches === 0 || notches < -3 || notches > 3) {
    throw new ExecutorError('TARGET_INVALID', 'notches must be a non-zero integer in -3..3');
  }
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isInteger)) {
    throw new ExecutorError('TARGET_INVALID', 'Target must be [x, y] in image pixels');
  }
  if (center[0] < 0 || center[0] >= image.width || center[1] < 0 || center[1] >= image.height) {
    throw new ExecutorError('TARGET_OUT_OF_IMAGE', 'Target is outside the observation image');
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...center] },
    action: { type: 'scroll', axis: 'vertical', notches },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export function buildKeyRequest(manifestPath, label, center, key, expected = '', grantId) {
  if (!['Left', 'Right', 'Up', 'Down', 'Home', 'End'].includes(key)) {
    throw new ExecutorError('TARGET_INVALID', 'key must be a short navigation key');
  }
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isInteger)) {
    throw new ExecutorError('TARGET_INVALID', 'Target must be [x, y] in image pixels');
  }
  if (center[0] < 0 || center[0] >= image.width || center[1] < 0 || center[1] >= image.height) {
    throw new ExecutorError('TARGET_OUT_OF_IMAGE', 'Target is outside the observation image');
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...center] },
    action: { type: 'key', key },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export function buildTextRequest(manifestPath, label, center, text, expected = '', grantId) {
  if (typeof text !== 'string' || text.length < 1 || text.length > 16
    || [...text].some(char => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f)) {
    throw new ExecutorError('TARGET_INVALID', 'text must be 1..16 non-control Unicode scalars');
  }
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isInteger)) {
    throw new ExecutorError('TARGET_INVALID', 'Target must be [x, y] in image pixels');
  }
  if (center[0] < 0 || center[0] >= image.width || center[1] < 0 || center[1] >= image.height) {
    throw new ExecutorError('TARGET_OUT_OF_IMAGE', 'Target is outside the observation image');
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...center] },
    action: { type: 'text', text },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export function buildChordRequest(manifestPath, label, center, combo, expected = '', grantId) {
  const allowed = { 'Ctrl+Left': 'Left', 'Ctrl+Right': 'Right' };
  const key = allowed[combo];
  if (!key) throw new ExecutorError('TARGET_INVALID', 'combo must be Ctrl+Left or Ctrl+Right');
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isInteger)) {
    throw new ExecutorError('TARGET_INVALID', 'Target must be [x, y] in image pixels');
  }
  if (center[0] < 0 || center[0] >= image.width || center[1] < 0 || center[1] >= image.height) {
    throw new ExecutorError('TARGET_OUT_OF_IMAGE', 'Target is outside the observation image');
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...center] },
    action: { type: 'chord', modifiers: ['ctrl'], key },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export function buildDragRequest(manifestPath, label, start, end, expected = '', grantId) {
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const image = manifest.image;
  const bounds = manifest.capture_bounds;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation image size is invalid');
  }
  if (!bounds || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new ExecutorError('OBSERVATION_INVALID', 'Observation origin is invalid');
  }
  for (const point of [start, end]) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger)
      || point[0] < 0 || point[0] >= image.width || point[1] < 0 || point[1] >= image.height) {
      throw new ExecutorError('TARGET_INVALID', 'Drag points must be inside the observation image');
    }
  }
  const requestId = randomUUID();
  return {
    schema_version: 1,
    request_id: requestId,
    operation_id: requestId,
    observation: {
      observation_id: manifest.observation_id,
      manifest: path.resolve(resolvedPath),
      image_sha256: image.sha256,
      image_size: { width: image.width, height: image.height },
      desktop_origin: { left: bounds.left, top: bounds.top },
    },
    target: { label, center: [...start] },
    action: { type: 'drag', end: [...end] },
    expected: { description: expected },
    authorization_grant: grantId,
  };
}

export async function selfCheck({ timeoutMs = 30_000 } = {}) {
  const result = await runProcess(['--self-check'], null, timeoutMs);
  const receipt = parseReceipt(result.stdout);
  receipt.exit_code = result.code;
  return receipt;
}

export async function runExecutor(requestOrPath, { timeoutMs = 120_000, signal, harnessSession } = {}) {
  const isPath = typeof requestOrPath === 'string';
  const args = ['--request', isPath ? requestOrPath : '-'];
  const stdin = isPath ? null : JSON.stringify(requestOrPath);
  const result = await runProcess(args, stdin, timeoutMs, { signal, harnessSession });
  try {
    const receipt = parseReceipt(result.stdout);
    receipt.exit_code = result.code;
    if (result.cancelled) receipt.launcher_cancelled = true;
    return receipt;
  } catch (error) {
    error.message = `${error.message}; exit=${result.code}; stderr=${(result.stderr || '').slice(-800)}`;
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2];
  if (argument === '--self-check' || argument === undefined) {
    selfCheck().then(receipt => {
      console.log(JSON.stringify(receipt, null, 2));
      process.exitCode = receipt.ok ? 0 : 3;
    }).catch(error => {
      console.error(JSON.stringify({ ok: false, error_code: error.code ?? 'EXECUTOR_ERROR' }));
      process.exitCode = 1;
    });
  } else if (argument === '--request' && process.argv[3]) {
    runExecutor(process.argv[3]).then(receipt => {
      console.log(JSON.stringify(receipt, null, 2));
      process.exitCode = receipt.ok ? 0 : 2;
    }).catch(error => {
      console.error(JSON.stringify({ ok: false, error_code: error.code ?? 'EXECUTOR_ERROR' }));
      process.exitCode = 1;
    });
  } else {
    console.error('usage: node scripts/run_desktop_executor.mjs [--self-check | --request <file>]');
    process.exitCode = 2;
  }
}
