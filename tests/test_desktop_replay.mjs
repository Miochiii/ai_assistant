import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { createReplayTool, replayArgs } from '../plugins/dsh-desktop-observe/replay.js';

const session = { header: { id: 'replay-test', cwd: root } };
const exec = { agent: { session }, signal: new AbortController().signal };

test('replay arguments reject coordinates and unsafe ids', () => {
  assert.deepEqual(replayArgs({ program_id: 'notepad-open-file-menu' }),
    { programId: 'notepad-open-file-menu', version: 2 });
  assert.throws(() => replayArgs({ program_id: '../escape' }), /program_id/);
  assert.throws(() => replayArgs({ program_id: 'ok', center: [1, 2] }), /Unknown/);
  assert.throws(() => replayArgs({ program_id: 'ok', version: 0 }), /version/);
});

test('replay tool returns only a compact program result', async () => {
  let seen;
  const tool = createReplayTool({ run: async request => {
    seen = request;
    await writeFile(request.outputPath, JSON.stringify({
      run_id: 'run-test',
      run_record: { run_id: 'run-test', lifecycle: 'ended', termination_reason: 'completed',
        input_delivery: 'sent', verification: { status: 'passed' },
        checkpoint_write: { status: 'skipped' } },
      result: { status: 'completed', steps: [{ step_id: '1' }], receipts: [{ ok: true }] },
    }));
    return { code: 0, stdout: '', stderr: '' };
  } });
  const result = await tool({ program_id: 'notepad-open-file-menu', version: 2 }, exec);
  assert.equal(seen.programId, 'notepad-open-file-menu');
  assert.equal(seen.session, 'replay-test');
  assert.equal(result.ok, true);
  assert.equal(result.program_condition_verified, true);
  assert.equal(result.task_success_verified, false);
  assert.equal(result.receipt_count, 1);
  assert.equal(result.steps[0].step_id, '1');
  await rm(result.evidence_path, { force: true });
});

test('replay tool forwards a multi-step program and reports all steps', async () => {
  const programId = 'test-replay-multistep';
  const folder = join(root, 'runtime', 'programs', programId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'v2.json'), JSON.stringify({ steps: [{ step_id: '1' }, { step_id: '2' }] }));
  let seen;
  try {
    const tool = createReplayTool({ run: async request => {
      seen = request;
      await writeFile(request.outputPath, JSON.stringify({
        run_id: 'run-multi',
        run_record: { run_id: 'run-multi', lifecycle: 'ended', termination_reason: 'completed',
          input_delivery: 'sent', verification: { status: 'passed' },
          checkpoint_write: { status: 'skipped' } },
        result: { status: 'completed',
          steps: [{ step_id: '1', location: { status: 'found' } },
                  { step_id: '2', location: { status: 'found' } }],
          receipts: [{ ok: true }, { ok: true }] },
      }));
      return { code: 0, stdout: '', stderr: '' };
    } });
    const result = await tool({ program_id: programId, version: 2 }, exec);
    assert.equal(seen.programId, programId);
    assert.equal(seen.session, 'replay-test');
    assert.equal(result.ok, true);
    assert.equal(result.step_count, 2);
    assert.equal(result.completed_steps, 2);
    assert.equal(result.receipt_count, 2);
    assert.deepEqual(result.steps.map(step => step.step_id), ['1', '2']);
    await rm(result.evidence_path, { force: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('replay tool requests memory context and records auto checkpoint', async () => {
  const programId = 'test-replay-memory';
  const folder = join(root, 'runtime', 'programs', programId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'v2.json'), JSON.stringify({ steps: [{ step_id: '1' }] }));
  let seen;
  let checkpointed;
  try {
    const memory = {
      context: async sessionArg => {
        assert.equal(sessionArg, session);
        return { scope: { user: 'u', project: 'p' }, memory_context: { session_id: 'replay-test' } };
      },
      checkpoint: async (sessionArg, runId) => {
        assert.equal(sessionArg, session);
        checkpointed = runId;
        return { status: 'saved' };
      },
    };
    const runs = {
      checkpointResult: async () => { throw new Error('must not mark a saved checkpoint as skipped'); },
      get: async runId => ({ run_id: runId, task_id: 't', lifecycle: 'ended',
        termination_reason: 'completed', input_delivery: 'sent',
        verification: { status: 'passed' }, checkpoint_write: { status: 'saved' } }),
    };
    const tool = createReplayTool({ memory, runs, run: async request => {
      seen = request;
      await writeFile(request.outputPath, JSON.stringify({
        run_id: 'run-memory', run_record: { run_id: 'run-memory', lifecycle: 'ended',
          termination_reason: 'completed', input_delivery: 'sent',
          verification: { status: 'passed' }, checkpoint_write: { status: 'pending' } },
        result: { status: 'completed', steps: [{ step_id: '1' }], receipts: [{ ok: true }] },
      }));
      return { code: 0, stdout: '', stderr: '' };
    } });
    const result = await tool({ program_id: programId, version: 2 }, exec);
    assert.equal(seen.memoryContext.memory_context.session_id, 'replay-test');
    assert.equal(checkpointed, 'run-memory');
    assert.equal(result.memory_context_available, true);
    assert.equal(result.run_record.checkpoint_write.status, 'saved');
    await rm(result.evidence_path, { force: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('replay tool caps program steps before the runner', async () => {
  const programId = 'test-replay-too-many-steps';
  const folder = join(root, 'runtime', 'programs', programId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'v2.json'), JSON.stringify({
    steps: Array.from({ length: 9 }, (_, index) => ({ step_id: String(index + 1) })),
  }));
  try {
    const tool = createReplayTool({ run: async () => assert.fail('runner must not run') });
    await assert.rejects(tool({ program_id: programId, version: 2 }, exec), /PROGRAM_TOO_MANY_STEPS/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
