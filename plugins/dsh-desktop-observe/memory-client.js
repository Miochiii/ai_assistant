// Trusted host bridge to the memory core CLI. The model never chooses the
// database, user scope, project scope or operation arguments directly.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class MemoryClientError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export function memoryDatabase(root) {
  return process.env.DSH_MEMORY_DB || join(root, 'runtime', 'memory', 'memory.sqlite3');
}

export function memoryPython(root) {
  const python = join(root, '.venv', 'Scripts', 'python.exe');
  return process.env.DSH_MEMORY_PYTHON || python;
}

export async function callMemory({ root, runRoot = root, user, project, op, args = {}, signal, timeoutMs = 15000 }) {
  const db = memoryDatabase(root);
  const python = memoryPython(root);
  const script = join(root, 'scripts', 'memory_cli.py');
  mkdirSync(join(root, 'runtime', 'memory'), { recursive: true });
  const command = [python, '-B', script, '--db', db, '--user', user, '--project', project, '--root', runRoot];
  return await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer;
    let child;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { child?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const onAbort = () => finish(reject, new MemoryClientError('MEMORY_CANCELLED'));
    if (signal?.aborted) {
      reject(new MemoryClientError('MEMORY_CANCELLED'));
      return;
    }
    try {
      child = spawn(python, command.slice(1), {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new MemoryClientError('STORAGE_UNAVAILABLE'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, new MemoryClientError('MEMORY_TIMEOUT')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2_000_000) finish(reject, new MemoryClientError('MEMORY_OUTPUT_TOO_LARGE'));
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.once('error', () => finish(reject, new MemoryClientError('STORAGE_UNAVAILABLE')));
    child.stdin.on('error', () => finish(reject, new MemoryClientError('STORAGE_UNAVAILABLE')));
    child.once('close', code => {
      let value;
      try { value = JSON.parse(stdout); } catch {
        finish(reject, new MemoryClientError('MEMORY_BAD_OUTPUT', `exit ${code}`));
        return;
      }
      if (!value || value.ok !== true) {
        finish(reject, new MemoryClientError(value?.error_code || 'MEMORY_STORAGE_ERROR'));
        return;
      }
      finish(resolve, value.result);
    });
    child.stdin.end(JSON.stringify({ op, args }), 'utf8');
  });
}
