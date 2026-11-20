/**
 * Node-side launcher for the Orb helper or legacy Python resident panel.
 *
 * This is deliberately not a UI runtime: no model, capture, desktop input or
 * widget implementation lives here. It only spawns the UI process, waits for
 * its handshake, exposes status and releases the child on stop.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_PYTHON = 'E:\\python\\python.exe';
const DEFAULT_PANEL = resolve('tools', 'coach_overlay', 'resident_panel.py');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function childAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

export async function startResidentUi({
  channelDir,
  assistantSessionId,
  pythonPath = DEFAULT_PYTHON,
  executablePath = null,
  diagnostics = false,
  panelPath = DEFAULT_PANEL,
  excludeCapture = false,
  noSound = false,
  timeoutMs = 8000,
} = {}) {
  if (!channelDir) throw new Error('channelDir is required');
  if (executablePath && !existsSync(executablePath)) {
    throw new Error(`Orb Electron runtime not found: ${executablePath}`);
  }
  if (!existsSync(panelPath)) throw new Error(`resident panel not found: ${panelPath}`);
  const args = [panelPath, '--channel-dir', channelDir];
  if (excludeCapture) args.push('--exclude-capture');
  if (noSound) args.push('--no-sound');
  if (diagnostics) args.push('--diagnostics');
  const env = { ...process.env };
  if (executablePath) delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executablePath ?? pythonPath, args, {
    cwd: resolve('.'),
    windowsHide: true,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrText = '';
  child.stderr?.on('data', chunk => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-4000);
  });
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`resident UI exited early: ${child.exitCode ?? child.signalCode}`
        + (stderrText ? `; ${stderrText.trim()}` : ''));
    }
    const ready = readJson(join(channelDir, 'ui-ready.json'));
    if (ready && ready.pid === child.pid
        && (!assistantSessionId || ready.assistant_session_id === assistantSessionId)) {
      return {
        child,
        channelDir,
        ready,
        status() {
          const heartbeat = readJson(join(channelDir, 'ui-heartbeat.json'));
          return {
            pid: child.pid,
            alive: childAlive(child),
            ready,
            heartbeat,
            heartbeat_fresh: Boolean(heartbeat && Date.now() - Date.parse(heartbeat.at) < 10000),
          };
        },
        async stop({ timeout = 3000 } = {}) {
          if (!childAlive(child)) return;
          const exited = new Promise(resolveExit => child.once('exit', resolveExit));
          child.kill();
          await Promise.race([exited, delay(timeout)]);
          if (childAlive(child)) {
            child.kill('SIGKILL');
            await Promise.race([exited, delay(1000)]);
          }
        },
      };
    }
    await delay(60);
  }
  child.kill();
  throw new Error('resident UI handshake timed out');
}
