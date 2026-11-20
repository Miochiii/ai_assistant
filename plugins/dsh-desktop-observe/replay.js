// Proof-bound verified-program replay as one host tool call. It does not accept
// coordinates or arbitrary code; the Python adapter performs every step's
// preflight/observe/locate/execute/verify and the fixed executor enforces auth.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { basePython } from '../../scripts/run_desktop_executor.mjs';
import { requireSession, root } from './bridge.js';

const PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPLAY_ARGS = new Set(['program_id', 'version']);

export function replayArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !REPLAY_ARGS.has(key))) throw new Error('Unknown argument');
  if (typeof args.program_id !== 'string' || !PROGRAM_ID.test(args.program_id)) {
    throw new Error('program_id must be a safe program identifier');
  }
  const version = args.version ?? 2;
  if (!Number.isSafeInteger(version) || version < 1 || version > 1000) {
    throw new Error('version must be a positive integer');
  }
  return { programId: args.program_id, version };
}

function programPath(programId, version) {
  return join(root, 'runtime', 'programs', programId, `v${version}.json`);
}

function compactRun(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    run_id: record.run_id, task_id: record.task_id, lifecycle: record.lifecycle,
    termination_reason: record.termination_reason, input_delivery: record.input_delivery,
    verification: record.verification, checkpoint_write: record.checkpoint_write,
  };
}

export function createReplayTool({ run = runPythonReplay, memory = null, runs = null } = {}) {
  return async (args, exec) => {
    const session = requireSession(exec);
    const sessionObject = exec?.agent?.session;
    const input = replayArgs(args);
    const path = programPath(input.programId, input.version);
    if (!existsSync(path)) throw new Error(`Verified program not found: ${input.programId} v${input.version}`);
    let program;
    try { program = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('Verified program manifest is unreadable'); }
    if (!Array.isArray(program.steps) || program.steps.length === 0) throw new Error('Verified program has no steps');
    if (program.steps.length > 8) throw new Error('PROGRAM_TOO_MANY_STEPS: at most 8 steps are accepted');
    const outputPath = join(root, 'results', 'desktop-replay', `${randomUUID()}.json`);
    mkdirSync(join(root, 'results', 'desktop-replay'), { recursive: true });
    let memoryContext = null;
    try { memoryContext = await memory?.context(sessionObject) ?? null; }
    catch { /* memory must not block desktop replay */ }
    const processResult = await run({
      programId: input.programId, version: input.version, session,
      outputPath, signal: exec.signal, memoryContext,
    });
    if (!existsSync(outputPath)) {
      throw new Error(`Replay produced no evidence file (exit ${processResult.code})`);
    }
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    const result = output.result || {};
    let runRecord = compactRun(output.run_record);
    const status = result.status;
    const completed = status === 'completed';
    const runId = output.run_id ?? runRecord?.run_id ?? null;
    if (memoryContext && memory && runId) {
      try {
        const checkpoint = await memory.checkpoint(sessionObject, runId);
        if (['skipped', 'failed'].includes(checkpoint?.status) && runs?.checkpointResult) {
          await runs.checkpointResult({ run_id: runId, result: { status: checkpoint.status,
            ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
            ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
        }
        if (runs?.get) {
          const fresh = await runs.get(runId);
          if (fresh) runRecord = compactRun(fresh);
        }
      } catch (error) {
        if (runs?.checkpointResult) {
          try {
            await runs.checkpointResult({ run_id: runId, result: {
              status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128),
            } });
          } catch { /* leave pending for later recovery */ }
        }
        if (runs?.get) {
          try {
            const fresh = await runs.get(runId);
            if (fresh) runRecord = compactRun(fresh);
          } catch { /* keep the durable result snapshot */ }
        }
      }
    }
    return {
      ok: completed,
      status,
      reason: result.reason ?? null,
      program_id: input.programId,
      program_version: input.version,
      run_id: runId,
      run_record: runRecord,
      program_condition_verified: completed && runRecord?.verification?.status === 'passed',
      task_success_verified: false,
      step_count: program.steps.length,
      completed_steps: completed ? program.steps.length
        : (Array.isArray(result.receipts) ? result.receipts.length : 0),
      steps: (result.steps || []).map(step => ({ step_id: step.step_id,
        location_status: step.location?.status ?? null, timings: step.timings ?? null })),
      receipt_count: Array.isArray(result.receipts) ? result.receipts.length : 0,
      evidence_path: outputPath,
      memory_context_available: Boolean(memoryContext),
      notice: 'This result covers only the program\'s declared postcondition. It is not general task success and does not retry failed or unknown steps.',
    };
  };
}

export function renderReplay(_args, value) {
  return [{ type: 'text', text: `Verified replay: ${value.status}${value.reason ? ` (${value.reason})` : ''}\n${JSON.stringify(value)}` }];
}

function runPythonReplay({ programId, version, session, outputPath, signal, memoryContext = null }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('REPLAY_CANCELLED_UNKNOWN'));
      return;
    }
    const args = ['-B', join(root, 'scripts', 'preact_replay.py'),
      '--program-id', programId, '--version', String(version), '--session', session, '--out', outputPath];
    const env = { ...process.env };
    if (memoryContext) env.DSH_MEMORY_CONTEXT = JSON.stringify(memoryContext);
    else delete env.DSH_MEMORY_CONTEXT;
    const child = spawn(basePython(), args, { cwd: root, windowsHide: true,
      env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, new Error('REPLAY_CANCELLED_UNKNOWN'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on('error', error => finish(reject, new Error(`REPLAY_LAUNCH_FAILED: ${error.message}`)));
    child.on('close', code => finish(resolve, { code, stdout: stdout.slice(-4000), stderr }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, new Error('REPLAY_TIMEOUT_UNKNOWN'));
    }, 120_000);
  });
}
