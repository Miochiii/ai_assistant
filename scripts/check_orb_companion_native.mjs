// Actual installed SDK + real MSS/See Now image pipeline, with a fake model.
// No paid request, no keyboard/mouse action, no write to production memory.
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {OrbCompanion} from '../plugins/dsh-assistant-host/orb-companion.js';
import {createWatchCapture} from '../plugins/dsh-assistant-host/orb-watch.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk = name => import(pathToFileURL(`${base}${name}/lib/index.js`));
const {Context, Service} = await sdk('cordis');
const {SessionStore} = await sdk('dsh-session');
const {SessionProjectionRegistry} = await sdk('dsh-session-projection');
const {SystemPrompt} = await sdk('dsh-system-prompt');
const {ToolRuntime} = await sdk('dsh-tools');
const {AgentRegistry} = await sdk('dsh-agent');
const {AgentLoop} = await sdk('dsh-agent-loop');
const {LlmRuntime} = await sdk('dsh-llm');
const {DeepSeekAdapter, resolveAdapterOptions} = await sdk('dsh-llm-deepseek');
const {default: LocalAttachmentStore} = await sdk('dsh-attachment-local');
globalThis.fetch = () => {throw new Error('Network disabled during native fixture');};
const directory = await mkdtemp(join(root, 'runtime/companion-native-'));
const ctx = new Context(); let companion, requests = 0; const replies = [], notices = [];
try {
  new SessionStore(ctx); new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, {includeHarnessIdentity: false, includeRuntimeContext: false});
  new ToolRuntime(ctx); (await sdk('dsh-tool-executor-native')).apply(ctx);
  const store = new LocalAttachmentStore(ctx, {dshHome: join(directory, 'isolated-dsh'), normalizedImageMaxPixels: 360000});
  const llm = new LlmRuntime(ctx);
  await new AgentRegistry(ctx)[Service.init]();
  await new AgentLoop(ctx, {agents: [], maxParallelToolCalls: {get: () => 1}})[Service.init]();
  ctx.on('llm/stream', (_options, next) => (async function* () {
    for await (const chunk of next()) {
      if (chunk.type === 'error' || chunk.type === 'finish' && chunk.reason?.kind === 'error') console.error('fixture stream failure', JSON.stringify(chunk));
      yield chunk;
    }
  })());
  const adapterOptions = resolveAdapterOptions({baseURL: 'https://fixture.invalid/anthropic', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 512});
  llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({options: () => adapterOptions,
    providerName: 'fixture', resolveAuth: async () => ({headers: {'x-api-key': 'offline'}}),
    resolveUserId: () => 'fixture', resolveAttachments: () => store,
    prepareExtensions: async () => ({fields: {}, accept: async () => {}}),
    resolveFiles: () => ({ensureUploaded: async () => {throw new Error('Uploads disabled');}})}));
  globalThis.fetch = async (_url, init) => {
    requests++;
    const wire = JSON.parse(init.body);
    assert.equal(wire.tools?.length ?? 0, 0); assert.equal(wire.max_tokens, 512);
    const blocks = wire.messages.at(-1).content;
    const image = blocks.find(block => block.type === 'image'); assert(image?.source?.data);
    assert.equal(Buffer.from(image.source.data, 'base64').subarray(1, 4).toString(), 'PNG');
    assert(blocks.find(block => block.type === 'text').text.includes('当前屏幕'));
    const events = [
      {type: 'message_start', message: {id: 'fixture', model: 'deepseek-flash', role: 'assistant', usage: {input_tokens: 0, output_tokens: 0}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: '{"speak":true,"text":"原生接口测试回复","reason":"fixture"}'}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 0}}, {type: 'message_stop'},
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
  };
  companion = new OrbCompanion({ctx, root: directory, capture: createWatchCapture(root), autoSchedule: false,
    reply: text => replies.push(text), notice: text => notices.push(text)});
  await companion.start('isolated-native-check');
  await companion.ask('当前屏幕是什么？'); await companion.run.modelTask;
  assert.equal(requests, 1, notices.join('\n')); assert.deepEqual(replies, ['原生接口测试回复'], notices.join('\n'));
  await companion.stop();
  assert.deepEqual(await readdir(join(directory, 'runtime/companion')), []);
  const report = {passed: true, native_sdk: true, real_mss_capture: true, upstream_see_now_pipeline: true,
    native_attachment_roundtrip: true, native_llm_stream: true, model: 'fake',
    paid_requests: 0, desktop_input_events: 0, live_orb_ui: false, screenshot_retained: false};
  await mkdir(join(root, 'results/watch'), {recursive: true});
  await writeFile(join(root, 'results/watch/companion-native.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await companion?.dispose(); await ctx.fiber.dispose();
  await rm(directory, {recursive: true, force: true});
}
