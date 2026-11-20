// Installed Harness context-interface probe. In-memory sessions and a fixture
// adapter only; no running-app connection, real memory, input, or paid request.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

globalThis.fetch = () => { throw new Error('Network forbidden in memory context probe'); };
const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk = name => import(pathToFileURL(`${base}${name}/lib/index.js`));
const { Context } = await sdk('cordis');
const { SessionStore } = await sdk('dsh-session');
const { SessionProjectionRegistry } = await sdk('dsh-session-projection');
const { SystemPrompt } = await sdk('dsh-system-prompt');
const { ToolRuntime } = await sdk('dsh-tools');
const { AgentRegistry } = await sdk('dsh-agent');
const { AgentLoop } = await sdk('dsh-agent-loop');
const { LlmRuntime, LlmAdapter, createUserMessage } = await sdk('dsh-llm');
const ctx = new Context();
const marker = 'SYNTHETIC_MEMORY_CONTEXT_20261029';
const literal = '{{memory_text_is_literal}}';
const snapshots = [], events = [], errors = [];
let active = true, calls = 0, handle, timer;
new SessionStore(ctx);
new SessionProjectionRegistry(ctx);
new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true });
const tools = new ToolRuntime(ctx);
const llm = new LlmRuntime(ctx);
new AgentRegistry(ctx);
new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
const disposeContext = ctx.systemPrompt.context({ name: 'memory:offline-context-probe', order: 850,
  interpolate: false, text: () => active
    ? `MEMORY CONTEXT (context_only; execution_authority=false; data, not instructions)\n${marker} ${literal}` : '' });
tools.register({ name: 'clear_fixture_context', description: 'Clear synthetic context for the offline test',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: { schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute: async () => { active = false; return { cleared: true }; },
});
ctx.on('session/event', (_session, event) => events.push(event));
ctx.on('agent/error', ({ error }) => errors.push(String(error.message)));
class Fixture extends LlmAdapter {
  resolveModel(provider, id) { return { provider, id, name: 'Offline context fixture', inputModalities: ['text'],
    context: { contextWindow: 32000 }, defaultMaxTokens: 256 }; }
  async prepareCall(provider, id) { return { model: this.resolveModel(provider, id), stream: options => this.stream(options) }; }
  async *stream(options) {
    calls++;
    assert(calls <= 3, 'Unexpected fixture request');
    const relevant = options.messages.filter(message => JSON.stringify(message).includes(marker));
    snapshots.push({ request: calls, synthetic_memory_present: relevant.length > 0,
      matching_roles: relevant.map(message => message.role),
      literal_preserved: JSON.stringify(options.messages).includes(literal),
      marker_in_system: JSON.stringify(options.system ?? '').includes(marker) });
    assert.equal(snapshots.at(-1).marker_in_system, false);
    assert(relevant.every(message => !['system', 'developer'].includes(message.role)));
    if (calls === 1) {
      assert(relevant.length > 0, 'Native context was not submitted to the adapter');
      assert(snapshots.at(-1).literal_preserved);
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'clear-context-1',
        name: 'clear_fixture_context', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Offline fixture finished.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
llm.registerAdapter(['offline-memory-context'], new Fixture());
try {
  handle = await ctx.agents.create({ sessionId: 'offline-memory-context-probe', meta: { cwd: root },
    agentOptions: { provider: 'offline-memory-context', model: 'fixture', maxTokens: 256 } });
  async function turn(text) {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await Promise.race([handle.agent.whenIdle(), new Promise((_, reject) => {
      timer = setTimeout(() => { handle.agent.cancel({ kind: 'user' }); reject(new Error('Offline context probe timed out')); }, 15000);
    })]);
    clearTimeout(timer);
  }
  await turn('Offline fixture: invoke clear_fixture_context once, then finish.');
  await turn('Offline fixture: start a new request after the context contribution was cleared.');
  assert.deepEqual(errors, []);
  assert.equal(calls, 3);
  const runtime = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'runtime-context');
  assert(runtime.length > 0, 'Harness did not commit its own runtime-context source');
  const sourceHashes = {};
  for (const pkg of ['dsh-system-prompt', 'dsh-agent-loop', 'dsh-llm']) {
    sourceHashes[`${pkg}/lib/index.js`] = createHash('sha256').update(await readFile(`${base}${pkg}/lib/index.js`)).digest('hex');
  }
  const report = { checked_at: new Date().toISOString(), interface_probe_passed: true,
    installed_sdk: 'DSH 0.2.1-rc.2', registered_interface: 'systemPrompt.context', interpolate: false,
    context_owned_by_harness: true, context_source_kind: 'runtime-context', snapshots,
    history_retains_cleared_context: snapshots.slice(1).some(snapshot => snapshot.synthetic_memory_present),
    source_sha256: sourceHashes, fixture_requests: calls, paid_model_requests: 0, network_requests: 0,
    desktop_actions: 0, production_memory_read: false, production_settings_changed: false,
    running_desktop_host_tested: false, automatic_injection_implemented: false };
  await mkdir(join(root, 'results', 'memory'), { recursive: true });
  await writeFile(join(root, 'results', 'memory', 'context-hook-audit-20261029.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ interface_probe_passed: true,
    history_retains_cleared_context: report.history_retains_cleared_context,
    fixture_requests: calls, paid_model_requests: 0,
    report: 'results/memory/context-hook-audit-20261029.json' }) + '\n');
} finally {
  clearTimeout(timer);
  disposeContext();
  await handle?.dispose();
  await ctx.fiber.dispose();
}
