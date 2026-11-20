// Native AgentLoop + native DeepSeek serializer/parser, with local HTTP fixtures.
// No --send mode, credentials, profile loading, new capture or desktop input.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { definitions } from '../plugins/dsh-desktop-observe/index.js';
import { createObserver, attachObservation } from '../plugins/dsh-desktop-observe/image-delivery.js';
import { createWireGuard, validatePolicy } from './desktop_wire_guard.mjs';

if (process.argv.includes('--send')) throw new Error('Offline-only script: --send is forbidden');
globalThis.fetch = () => { throw new Error('Network forbidden'); };
const sdk = async name => import(pathToFileURL(`E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/${name}/lib/index.js`));
const { Context } = await sdk('cordis');
const { SessionStore } = await sdk('dsh-session');
const { SessionProjectionRegistry } = await sdk('dsh-session-projection');
const { SystemPrompt } = await sdk('dsh-system-prompt');
const { ToolRuntime } = await sdk('dsh-tools');
const { AgentRegistry } = await sdk('dsh-agent');
const { AgentLoop } = await sdk('dsh-agent-loop');
const { LlmRuntime, createUserMessage } = await sdk('dsh-llm');
const { default: LocalAttachmentStore } = await sdk('dsh-attachment-local');
const { DeepSeekAdapter, resolveAdapterOptions, resolveRequestImageTarget, deepSeekImageTokens } = await sdk('dsh-llm-deepseek');
const evidenceRoot = await realpath(join(root, 'results', 'vision'));
const temp = await mkdtemp(join(evidenceRoot, 'tmp-wire-loop-'));
const ctx = new Context();
let handle, timer, calls = 0, captures = 0, uploadFallbacks = 0;
const events = [], errors = [], wire = [];
let report;

function response(toolCall) {
  const frames = [
    { type: 'message_start', message: { id: `offline-${calls}`, model: 'deepseek-flash', role: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: toolCall
      ? { type: 'tool_use', id: 'observe-fixture', name: 'desktop_observe', input: {} }
      : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: toolCall
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ monitor: 1, include_image: true }) }
      : { type: 'text_delta', text: 'OFFLINE_NATIVE_WIRE_IMAGE_RECEIVED' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

try {
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  const tools = new ToolRuntime(ctx), llm = new LlmRuntime(ctx);
  new AgentRegistry(ctx);
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
  new LocalAttachmentStore(ctx, { dshHome: join(temp, 'store'), normalizedImageMaxPixels: 80000 });
  const source = JSON.parse(await readFile(join(root, 'results/vision/c0c3534f-312b-4cd7-b9f3-4597eadad655/observation.json'), 'utf8'));
  await mkdir(join(temp, 'capture'));
  const imagePath = join(temp, 'capture', 'screen.png');
  await copyFile(source.image.path, imagePath);
  const observation = { ...source, image: { ...source.image, path: imagePath } };
  const sessionId = 'offline-native-wire';
  const exec = { agent: { session: { header: { cwd: root, id: sessionId } } }, signal: AbortSignal.timeout(15000) };
  // Prepare and pin native-normalized bytes before starting the loop. The tool
  // still validates its route/policy and returns this real attachment in history.
  const prepared = await attachObservation(ctx, observation, { provider: 'deepseek-official', model: 'deepseek-flash' }, exec);
  const options = resolveAdapterOptions({ baseURL: 'https://api.deepseek.com/anthropic', thinking: 'disabled',
    reasoningEffort: 'off', maxTokens: 1024, streamIdleTimeoutMs: 5000 });
  const attachment = prepared.model_image.attachment;
  const target = resolveRequestImageTarget(options.models.find(m => m.id === 'deepseek-flash'), attachment);
  const image = await ctx.attachments.readImageRequest(attachment, target, exec.signal);
  const imageHash = createHash('sha256').update(image.data).digest('hex');
  const imageTokens = deepSeekImageTokens(image.width, image.height);
  assert(imageTokens <= 1024);
  const policy = { trialId: sessionId, sessionId, maxRequests: 2, maxOutputTokens: 1024,
    maxBodyBytes: 2000000, maxNonImageBytes: 16000, approvedImageHashes: [imageHash],
    reserveMicroCny: 72192, budgetMicroCny: 500000 };
  const approval = { approved: true, status: 'active', trial_id: sessionId,
    policy_sha256: validatePolicy(policy), offline_fixture: true };
  const guardOptions = { directory: join(temp, 'ledger'), policy, readApproval: async () => approval,
    transport: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.deepEqual(body.tools.map(t => t.name).sort(), ['desktop_monitors', 'desktop_observe']);
      const images = [];
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'image') images.push(value);
        for (const child of Object.values(value)) visit(child);
      };
      visit(body.messages);
      assert.equal(images.length, calls === 1 ? 0 : 1);
      if (calls === 2) {
        assert(events.some(e => e.type === 'tool/result'));
        assert.equal(createHash('sha256').update(Buffer.from(images[0].source.data, 'base64')).digest('hex'), imageHash);
      }
      wire.push({ request: calls, inline_images: images.length, tool_names: body.tools.map(t => t.name), max_tokens: body.max_tokens });
      return response(calls === 1);
    } };
  const guardedFetch = await createWireGuard(guardOptions);
  globalThis.fetch = async (url, init) => {
    try { return await guardedFetch(url, init); }
    catch (error) { errors.push(error.message); throw error; }
  };
  const observer = createObserver(ctx, { policy: async () => ({ image_attachment_enabled: true }),
    capture: async () => { captures++; return observation; }, attach: async () => prepared });
  for (const tool of definitions(ctx)) tools.register({ ...tool, execute: tool.name === 'desktop_observe'
    ? observer : async () => { throw new Error('Unexpected monitor request'); } });
  const adapter = new DeepSeekAdapter({ options: () => options, providerName: 'DeepSeek',
    resolveAuth: async () => ({ headers: { 'x-api-key': 'offline-placeholder' },
      onRequestError: async error => { errors.push(error.message); return error; } }),
    resolveUserId: () => sessionId, resolveAttachments: () => ctx.attachments,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    resolveFiles: () => ({ ensureUploaded: async () => { uploadFallbacks++; throw new Error('Inline only'); } }) });
  llm.registerAdapter(['deepseek-official'], adapter);
  ctx.on('session/event', (_session, event) => events.push(event));
  ctx.on('agent/error', ({ error }) => {
    for (let cause = error; cause; cause = cause.cause) errors.push(cause.message);
  });
  handle = await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 1024 } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Offline protocol fixture: observe once, then finish.' }], source: { kind: 'user' } }));
  await Promise.race([handle.agent.whenIdle(), new Promise((_, reject) => {
    timer = setTimeout(() => { handle.agent.cancel({ kind: 'user' }); reject(new Error('Offline loop timed out')); }, 15000);
  })]);
  assert.deepEqual(errors, []);
  assert.equal(calls, 2); assert.equal(captures, 1);
  assert(events.some(e => e.type === 'turn/end'));
  assert(JSON.stringify(events.filter(e => e.type === 'assistant/message')).includes('OFFLINE_NATIVE_WIRE_IMAGE_RECEIVED'));
  const ledger = [];
  for (let i = 1; i <= 2; i++) ledger.push(JSON.parse(await readFile(join(temp, 'ledger', `request-${i}.json`), 'utf8')));
  assert.deepEqual(ledger.map(r => r.images), [0, 1]);
  // Reconstruct the guard as after a worker restart; the old quota stays spent.
  const reopened = await createWireGuard(guardOptions);
  await assert.rejects(reopened('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', redirect: 'error',
    headers: { 'x-deepseek-harness-session-id': sessionId }, body: JSON.stringify({ model: 'deepseek-flash',
      thinking: { type: 'disabled' }, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'retry' }] }) }), /quota exhausted/);
  assert.equal(calls, 2);
  report = { checked_at: new Date().toISOString(), sdk: 'DSH 0.2.1-rc.2', native_agent_loop: true,
    native_deepseek_sdk: true, native_attachments: true, transport: 'local SSE fixture', wire,
    ledger, upload_fallback_attempts: uploadFallbacks, uploaded_files: 0, image_tokens: imageTokens,
    restart_quota_check_passed: true, paid_model_requests: 0, new_screenshots: 0, gui_actions: 0,
    running_desktop_host_tested: false, recognition_accuracy_tested: false, monetary_bound_verified: false };
} finally {
  clearTimeout(timer);
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  await handle?.dispose(); await ctx.fiber.dispose();
  const resolved = await realpath(temp), sub = relative(evidenceRoot, resolved);
  if (!sub || sub.startsWith('..') || isAbsolute(sub)) throw new Error('Unsafe cleanup path');
  await rm(resolved, { recursive: true, force: true });
}
report.temporary_files_removed = true;
await writeFile(join(root, 'results/a04/dsh-native-wire-offline.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
