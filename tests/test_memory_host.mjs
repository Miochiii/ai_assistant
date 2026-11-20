import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHostError, createMemoryHost, definitions, installContextGate, parseMemoryCommand } from '../plugins/dsh-desktop-observe/memory.js';

const session = { id: 'session-1', header: { cwd: 'E:\\file\\agent\\ai assistant' } };

function fakeCall() {
  const calls = [];
  const call = async request => {
    calls.push(request);
    switch (request.op) {
      case 'event': return request.args.event_id;
      case 'propose': return 'mem-candidate';
      case 'remember': return 'mem-remember';
      case 'confirm': return request.args.memory_id;
      case 'recall': return { route: 'current', items: [{ memory_id: 'mem-active', status: 'active',
        content: '目录A', trust: 'context_only', execution_authority: false }],
        excluded: [], truncated: false, execution_authority: false };
      case 'context_state': return { session_id: request.args.session_id, generation: request.args.generation,
        status: 'clean', revision: 0, invalidation_event_ids: [], execution_authority: false };
      case 'context_generation': return { session_id: request.args.session_id, generation: 1,
        has_state: false, execution_authority: false };
      case 'context_refresh': return { session_id: request.args.session_id,
        generation: (request.args.generation ?? 1) + 1, previous_generation: request.args.generation ?? 1,
        status: 'clean', revision: 0, execution_authority: false };
      case 'exposure_register': return { exposure_id: 'exposure-test',
        memory_ids: request.args.memory_ids, stage: request.args.stage, execution_authority: false };
      case 'checkpoint': return 'mem-checkpoint';
      case 'auto_checkpoint': return { status: 'saved', memory_id: 'mem-auto' };
      case 'resume': return { items: [], requires_fresh_observation: true,
        automatic_execution: false, task_success_verified: false };
      case 'revoke': return { memory_id: request.args.memory_id, revoked: true };
      case 'deletion_plan': return { memory_ids: ['mem-active'], event_ids: [],
        policy: 'source_and_revision_closure', plan_id: 'a'.repeat(64), data_version: '1:2:3' };
      case 'forget': return { memory_ids: ['mem-active'], event_ids: [],
        policy: 'source_and_revision_closure', external_copies_erased: false };
      default: throw new Error(`unexpected ${request.op}`);
    }
  };
  return { call, calls };
}

function userEvent(id = 'msg-1', text = '记住：报告保存到目录A。') {
  return { type: 'user/message', data: { id, source: { kind: 'user' },
    content: [{ type: 'text', text }] } };
}

test('user message becomes a source; model propose is candidate-only', async () => {
  const { call, calls } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test', userId: 'local-user' });
  assert.equal(host.onSessionEvent(session, userEvent()), true);
  assert.equal(host.onSessionEvent(session, { type: 'user/message',
    data: { id: 'injected', source: { kind: 'memory' }, content: [{ type: 'text', text: 'not user' }] } }), false);
  const result = await host.propose(session, { kind: 'preference', key: 'report.directory', content: '目录A' });
  assert.equal(result.memory_id, 'mem-candidate');
  assert.equal(result.visible, false);
  assert.deepEqual(calls.map(c => c.op), ['event', 'propose']);
  assert.equal(calls[0].args.origin, 'user');
  assert.equal(calls[1].args.source_event_ids[0], calls[0].args.event_id);
  assert.ok(!calls.some(c => c.op === 'remember'));
});

test('propose without a real user source is refused', async () => {
  const { call } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  await assert.rejects(host.propose(session, { kind: 'fact', key: 'x', content: 'y' }),
    error => error instanceof MemoryHostError && error.code === 'NO_USER_SOURCE');
});

test('recall records a metadata-only exposure and blocks needs_refresh context', async () => {
  const { call: base, calls } = fakeCall();
  const host = createMemoryHost({ call: base, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent('msg-exposure'));
  await host.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' });
  assert.deepEqual(calls.filter(c => c.op === 'context_state').map(c => c.args.session_id), ['session-1']);
  const exposure = calls.find(c => c.op === 'exposure_register');
  assert.deepEqual(exposure.args.memory_ids, ['mem-active']);
  assert.equal(exposure.args.generation, 1);
  assert.match(exposure.args.request_id, /^request-/);
  assert.equal(exposure.args.stage, 'prepared');

  const stale = createMemoryHost({ call: request => request.op === 'context_state'
    ? Promise.resolve({ status: 'needs_refresh', revision: 3 })
    : base(request), projectFor: () => 'project-test' });
  host.onSessionEvent(stale, userEvent('msg-stale'));
  await assert.rejects(stale.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' }),
    error => error instanceof MemoryHostError && error.code === 'CONTEXT_NEEDS_REFRESH');
});

test('context generation bootstraps and refresh advances it', async () => {
  const { call: base, calls } = fakeCall();
  const states = [];
  const call = request => request.op === 'context_state'
    ? Promise.resolve({ session_id: request.args.session_id, generation: request.args.generation,
      status: states.at(-1) ?? 'clean', revision: 0, invalidation_event_ids: [] })
    : base(request);
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent('msg-generation'));
  const initial = await host.contextState(session);
  assert.equal(initial.generation, 1);
  assert.equal(calls.filter(c => c.op === 'context_generation').length, 1);
  const refreshed = await host.refreshContext(session, undefined, 'test_refresh');
  assert.equal(refreshed.generation, 2);
  assert.equal(calls.find(c => c.op === 'context_refresh').args.reason, 'test_refresh');
  await host.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' });
  const exposure = calls.filter(c => c.op === 'exposure_register').at(-1);
  assert.equal(exposure.args.generation, 2);
});

test('memory tool errors are structured and actionable, not bare UNKNOWN', async () => {
  const host = { recall: async () => { throw new MemoryHostError('CONTEXT_NEEDS_REFRESH'); } };
  const recall = definitions(host).find(tool => tool.name === 'memory_recall');
  const result = await recall.execute({ route: 'none' }, { agent: { session }, signal: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'CONTEXT_NEEDS_REFRESH');
  assert.equal(result.memory_tools_available, false);
  assert.match(result.message, /memory refresh/);
  assert.match(result.recovery, /memory refresh/);
});

test('recall and checkpoint carry context authority and recalled dependencies', async () => {  const { call, calls } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent());
  const recalled = await host.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' });
  assert.equal(recalled.trust, 'context_only');
  assert.equal(recalled.execution_authority, false);
  const checkpoint = await host.checkpoint(session, {
    task_id: 'task-1', goal: '整理报告', completed: ['读取资料'], next_step: '重新观察桌面',
    blockers: [], status: 'in_progress', depends_on: ['mem-explicit'],
  });
  assert.equal(checkpoint.task_success_verified, false);
  assert.equal(checkpoint.requires_fresh_observation, true);
  assert.deepEqual(checkpoint.depends_on, ['mem-active', 'mem-explicit']);
  const checkpointCall = calls.find(c => c.op === 'checkpoint');
  assert.deepEqual(checkpointCall.args.depends_on, ['mem-active', 'mem-explicit']);
});

test('recall dependencies are per request, not per session', async () => {
  const { call } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent('msg-1'));
  await host.recall(session, { route: 'current', kind: 'preference', key: 'report.directory' });
  host.onSessionEvent(session, userEvent('msg-2', '第二个请求'));
  const checkpoint = await host.checkpoint(session, { task_id: 'task-2', goal: '新任务',
    completed: [], next_step: '观察', blockers: [], status: 'in_progress' });
  assert.deepEqual(checkpoint.depends_on, []);
});

test('unknown project refuses automation instead of sharing workspace-unknown', async () => {
  const { call } = fakeCall();
  const host = createMemoryHost({ call });
  const noCwd = { id: 'no-project', header: {} };
  await assert.rejects(host.recall(noCwd, { route: 'none' }),
    error => error instanceof MemoryHostError && error.code === 'PROJECT_UNKNOWN');
});

test('host command remembers, confirms and binds forget to a plan', async () => {
  const { call, calls } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  const invocation = (rawInput, commandId = 'cmd-1') => ({ commandId, rawInput, signal: undefined,
    agent: { session } });
  const remember = await host.command(invocation('remember {"kind":"preference","key":"report.directory","content":"目录A"}'));
  assert.equal(remember.kind, 'success');
  const rememberCall = calls.find(c => c.op === 'remember');
  assert.equal(rememberCall.args.source_event_ids[0], calls.find(c => c.op === 'event').args.event_id);
  const confirm = await host.command(invocation('confirm mem-candidate', 'cmd-2'));
  assert.equal(confirm.kind, 'success');
  const noConfirm = await host.command(invocation('forget {"memory_id":"mem-active"}', 'cmd-3'));
  assert.equal(noConfirm.kind, 'error');
  const plan = await host.command(invocation('plan {"memory_id":"mem-active"}', 'cmd-4'));
  assert.equal(plan.kind, 'success');
  const planId = /plan_id: ([a-f0-9]+)/.exec(plan.text)[1];
  const noPlanId = await host.command(invocation('forget {"memory_id":"mem-active","confirm":true}', 'cmd-5'));
  assert.equal(noPlanId.kind, 'error');
  const forget = await host.command(invocation(
    `forget {"memory_id":"mem-active","confirm":true,"plan_id":"${planId}"}`, 'cmd-6'));
  assert.equal(forget.kind, 'success');
  assert.match(forget.text, /external_copies_erased/);
  const forgetCall = calls.find(c => c.op === 'forget');
  assert.equal(forgetCall.args.plan_id, 'a'.repeat(64));
  assert.equal(forgetCall.args.data_version, '1:2:3');
  const refresh = await host.command(invocation('refresh', 'cmd-7'));
  assert.equal(refresh.kind, 'success');
  assert.match(refresh.text, /generation 2/);
  assert.equal(calls.filter(c => c.op === 'context_refresh').length, 1);
});

test('auto checkpoint consumes a durable run id; a boolean cannot authorize a write', async () => {
  const { call, calls } = fakeCall();
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent());
  const base = { task_id: 'task-auto', goal: '自动任务', completed: ['读取'],
    next_step: '观察', blockers: [], status: 'in_progress', operation_id: 'op-auto' };
  await assert.rejects(host.autoCheckpoint(session, base),
    error => error instanceof MemoryHostError && error.code === 'RUN_ID_REQUIRED');
  await assert.rejects(host.autoCheckpoint(session, { ...base, consent: true }), { code: 'RUN_ID_REQUIRED' });
  const result = await host.autoCheckpoint(session, { ...base, consent: true, run_id: 'trusted-run' });
  assert.equal(result.memory_id, 'mem-auto');
  assert.deepEqual(calls.find(c => c.op === 'auto_checkpoint').args, { run_id: 'trusted-run' });
  assert.equal(calls.some(c => c.op === 'event'), false);
});

test('resume dependencies propagate to a later derived checkpoint', async () => {
  const { call: base, calls } = fakeCall();
  const call = request => request.op === 'resume' ? Promise.resolve({ items: [
    { status: 'active', memory_id: 'old-summary', depends_on: ['original-fact'] },
  ] }) : base(request);
  const host = createMemoryHost({ call, projectFor: () => 'project-test' });
  host.onSessionEvent(session, userEvent('next-request', '继续任务'));
  await host.resume(session, { task_id: 'old-task' });
  await host.checkpoint(session, { task_id: 'new-task', goal: 'continue',
    completed: [], next_step: 'observe', blockers: [], status: 'blocked' });
  assert.deepEqual(calls.find(c => c.op === 'checkpoint').args.depends_on, ['old-summary', 'original-fact']);
});

test('llm/stream gate never aborts the conversation on a stale context', async () => {
  let handler;
  const ctx = { on: (name, callback) => { if (name === 'llm/stream') handler = callback; return () => {}; } };
  installContextGate(ctx, { markSubmitted: async () => {
    throw new MemoryHostError('CONTEXT_NEEDS_REFRESH');
  } });
  assert.equal(typeof handler, 'function');
  const next = async function* () { yield { dispatched: true }; };
  const chunks = [];
  for await (const chunk of handler({ sessionId: 'session-1' }, next)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ dispatched: true }]);

  let marked = 0;
  installContextGate(ctx, { markSubmitted: async sessionId => {
    assert.equal(sessionId, 'session-1'); marked++;
  } });
  chunks.length = 0;
  for await (const chunk of handler({ sessionId: 'session-1' }, next)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ dispatched: true }]);
  assert.equal(marked, 1);
});

test('command parser is explicit and rejects malformed JSON', () => {
  assert.deepEqual(parseMemoryCommand('help'), { op: 'help' });
  assert.throws(() => parseMemoryCommand('remember {bad'), /JSON/);
  assert.deepEqual(parseMemoryCommand('confirm abc'), { op: 'confirm', id: 'abc' });
});
