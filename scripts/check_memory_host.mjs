// Offline host integration check: real memory core CLI, no model or desktop action.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createMemoryHost } from '../plugins/dsh-desktop-observe/memory.js';
import { callMemory } from '../plugins/dsh-desktop-observe/memory-client.js';
import { createRunLedgerClient } from '../plugins/dsh-desktop-observe/runs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const folder = await mkdtemp(join(ROOT, 'runtime', 'memory-tests', 'host-'));
const db = join(folder, 'memory.sqlite3');
const projectDir = join(folder, 'project');
await mkdir(projectDir, { recursive: true });
const previousDb = process.env.DSH_MEMORY_DB;
process.env.DSH_MEMORY_DB = db;
const session = { id: `host-${randomUUID()}`, header: { cwd: projectDir } };
const host = createMemoryHost({ userId: 'local-user', call: request => callMemory({ ...request, runRoot: folder }) });
const report = { schema_version: 1, checks: [], db: null };
try {
  assert.equal(host.onSessionEvent(session, { type: 'user/message', data: {
    id: 'host-message-1', source: { kind: 'user' },
    content: [{ type: 'text', text: '记住：报告保存到目录A。' }],
  } }), true);
  const proposed = await host.propose(session, { kind: 'preference', key: 'report.directory', content: '目录A' });
  assert.equal(proposed.status, 'candidate');
  assert.equal(proposed.visible, false);
  report.checks.push({ step: 'propose', memory_id: proposed.memory_id, active: false });

  const invocation = rawInput => ({ commandId: `cmd-${randomUUID()}`, rawInput, signal: undefined,
    agent: { session } });
  const confirmed = await host.command(invocation(`confirm ${proposed.memory_id}`));
  assert.equal(confirmed.kind, 'success', confirmed.text);
  report.checks.push({ step: 'confirm', memory_id: proposed.memory_id });

  const recalled = await host.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' });
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].content, '目录A');
  assert.equal(recalled.execution_authority, false);
  report.checks.push({ step: 'recall', status: 'matched', execution_authority: false });

  const sessionB = { id: `host-b-${randomUUID()}`, header: { cwd: projectDir } };
  const hostB = createMemoryHost({ userId: 'local-user', call: request => callMemory({ ...request, runRoot: folder }) });
  const recalledB = await hostB.recall(sessionB, { route: 'current', kind: 'preference', key: 'report.directory' });
  assert.equal(recalledB.items.length, 1);
  report.checks.push({ step: 'second_session_recall', status: 'matched' });
  const historyB = await hostB.recall(sessionB, { route: 'history', kind: 'preference', key: 'report.directory' });
  assert.ok(historyB.items.length >= 1);
  report.checks.push({ step: 'history', status: 'matched' });

  const checkpoint = await host.checkpoint(session, { task_id: 'task-1', goal: '整理报告',
    completed: ['读取资料'], next_step: '重新观察桌面', blockers: [], status: 'in_progress' });
  assert.equal(checkpoint.task_success_verified, false);
  assert.ok(checkpoint.depends_on.includes(recalled.items[0].memory_id));
  report.checks.push({ step: 'checkpoint', task_success_verified: false });

  const resumed = await host.resume(session, { task_id: 'task-1' });
  assert.equal(resumed.requires_fresh_observation, true);
  assert.equal(resumed.automatic_execution, false);
  report.checks.push({ step: 'resume', requires_fresh_observation: true });

  assert.equal(await host.runContext(session), null);
  report.checks.push({ step: 'automatic_disabled_by_default', status: 'no_context' });
  const enabled = await host.command(invocation('automation {"auto_checkpoint":true,"retention_days":30,"acknowledge_retained_body":true}'));
  assert.equal(enabled.kind, 'success', enabled.text);
  const context = await host.runContext(session);
  const runs = createRunLedgerClient({ root: folder });
  const run = runs.start({ task_id: 'task-auto', request_id: context.memory_context.request_id, ...context });
  runs.end({ run_id: run.run_id, operation_id: 'host-terminal', termination_reason: 'completed',
    input_delivery: 'sent', verification: { status: 'unknown' }, executor_state: 'stopped',
    checkpoint_facts: [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] });
  const auto = await host.autoCheckpoint(session, { run_id: run.run_id });
  const autoAgain = await host.autoCheckpoint(session, { run_id: run.run_id });
  assert.equal(auto.memory_id, autoAgain.memory_id);
  report.checks.push({ step: 'auto_checkpoint_idempotent', memory_id: auto.memory_id });
  const resumedAuto = await hostB.resume(sessionB, { task_id: 'task-auto' });
  assert.equal(resumedAuto.items[0].memory_id, auto.memory_id);
  assert.deepEqual(new Set(resumedAuto.items[0].sources.map(source => source.origin)), new Set(['user', 'tool']));
  assert.equal(resumedAuto.automatic_execution, false);
  assert.equal(resumedAuto.items[0].evidence_availability[0].availability, 'available');
  report.checks.push({ step: 'automatic_second_session_resume', status: 'context_only' });
  const disabled = await host.command(invocation('automation {"auto_checkpoint":false}'));
  assert.equal(disabled.kind, 'success', disabled.text);
  assert.equal((await host.autoCheckpoint(session, { run_id: run.run_id })).status, 'skipped');
  report.checks.push({ step: 'disable_stops_delivery', status: 'skipped' });
  await rm(join(folder, 'runtime', 'runs', `${run.run_id}.json`));
  const missingEvidence = await hostB.resume(sessionB, { task_id: 'task-auto' });
  assert.equal(missingEvidence.items[0].evidence_availability[0].availability, 'unavailable');
  report.checks.push({ step: 'missing_run_evidence', status: 'unavailable' });

  const plan = await host.command(invocation(`plan {"memory_id":"${recalled.items[0].memory_id}"}`));
  assert.equal(plan.kind, 'success', plan.text);
  const planMatch = /plan_id: ([a-f0-9]+)/.exec(plan.text);
  assert.ok(planMatch, plan.text);
  const forget = await host.command(invocation(
    `forget {"memory_id":"${recalled.items[0].memory_id}","confirm":true,"plan_id":"${planMatch[1]}"}`));
  assert.equal(forget.kind, 'success', forget.text);
  assert.match(forget.text, /external_copies_erased/);
  report.checks.push({ step: 'forget', external_copies_erased: false });
  await assert.rejects(hostB.recall(sessionB, { route: 'current', kind: 'preference', key: 'report.directory' }),
    error => error?.code === 'CONTEXT_NEEDS_REFRESH');
  report.checks.push({ step: 'stale_context_blocked', status: 'needs_refresh' });
  const sessionC = { id: `host-c-${randomUUID()}`, header: { cwd: projectDir } };
  const afterForget = await hostB.recall(sessionC, { route: 'current', kind: 'preference', key: 'report.directory' });
  assert.equal(afterForget.items.length, 0);
  report.checks.push({ step: 'second_session_after_forget', status: 'empty' });

  report.ok = true;
  report.checks_count = report.checks.length;
  await writeFile(join(ROOT, 'results', 'memory', 'host-integration.json'),
    JSON.stringify(report, null, 2), { encoding: 'utf8' });
  console.log(JSON.stringify({ ok: true, checks: report.checks.length,
    report: 'results/memory/host-integration.json' }));
} finally {
  if (previousDb === undefined) delete process.env.DSH_MEMORY_DB;
  else process.env.DSH_MEMORY_DB = previousDb;
  await rm(folder, { recursive: true, force: true });
}
