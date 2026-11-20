// Run in Harness Electron with ELECTRON_RUN_AS_NODE=1 and --expose-internals.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { encodePng } from '../plugins/dsh-assistant-host/vendor/see-now/png.js';
import { ModelCheck } from '../plugins/dsh-assistant-host/model-check.js';
import { PanelChatModel } from '../plugins/dsh-assistant-host/panel-model.js';

globalThis.fetch = () => { throw Error('Network disabled'); };
const sdk = name => import(pathToFileURL(join(dirname(process.execPath), 'resources/app.asar/dsh/node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context, Service } = await sdk('cordis');
const { SessionStore } = await sdk('dsh-session');
const { SessionProjectionRegistry } = await sdk('dsh-session-projection');
const { SystemPrompt } = await sdk('dsh-system-prompt');
const { ToolRuntime } = await sdk('dsh-tools');
const { AgentRegistry } = await sdk('dsh-agent');
const { AgentLoop } = await sdk('dsh-agent-loop');
const { LlmRuntime, createUserMessage } = await sdk('dsh-llm');
const { default: LocalAttachmentStore } = await sdk('dsh-attachment-local');
const { DeepSeekAdapter, resolveAdapterOptions } = await sdk('dsh-llm-deepseek');
const temp = await mkdtemp(join(tmpdir(), 'companion-wire-'));
try {
  const ctx = new Context();
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx);
  (await sdk('dsh-tool-executor-native')).apply(ctx);
  const llm = new LlmRuntime(ctx);
  await new AgentRegistry(ctx)[Service.init]();
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
  await loop[Service.init]();
  new LocalAttachmentStore(ctx, { dshHome: temp, normalizedImageMaxPixels: 80000 });
  const options = resolveAdapterOptions({ baseURL: 'https://fixture.invalid/anthropic', thinking: 'disabled',
    reasoningEffort: 'off', maxTokens: 512, streamIdleTimeoutMs: 5000 });
  llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({ options: () => options, providerName: 'fixture',
    resolveAuth: async () => ({ headers: { 'x-api-key': 'offline' } }),
    resolveUserId: () => 'fixture', resolveAttachments: () => ctx.attachments,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    resolveFiles: () => ({ ensureUploaded: async () => { throw Error('Uploads disabled'); } }) }));
  const wire = [];
  let reply = 'parent-first';
  let stopReason = 'end_turn';
  globalThis.fetch = async (_url, init) => {
    wire.push(JSON.parse(init.body));
    const frames = [
      { type: 'message_start', message: { id: 'fixture', model: 'deepseek-flash', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ];
    return new Response(frames.map(f => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  ctx.on('session/event', (_session, event) => events.push(event.type));
  ctx.on('agent/error', ({ error }) => { console.error(error.message); });
  const parent = await ctx.agents.create({ sessionId: 'parent-fixture', meta: { cwd: temp },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 512 } });
  async function mainTurn(text) {
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await parent.agent.whenIdle();
    assert.ok(JSON.stringify(wire.at(-1)?.messages).includes(text));
  }
  await mainTurn('MAIN_PRIVATE_1');
  const initialEvents = events.length;
  const panel = new PanelChatModel({ ctx, sessionId: 'parent-fixture' });
  const image = join(temp, 'fixture.png');
  await writeFile(image, encodePng(Buffer.alloc(16 * 16 * 3), 16, 16));
  let spoken = 0;
  const check = new ModelCheck({ ctx, sessionId: 'parent-fixture', resultDir: temp,
    onReply: text => { spoken++; panel.noteObservation(text); } });
  for (let i = 0; i < 20; i++) {
    reply = JSON.stringify({ speak: i % 2 === 0, text: 'EYE_' + i, reason: 'WATCH_REASON' });
    await check.request({ frame: { frame_id: String(i), thumbnail_ref: image } });
    for (let n = 0; check.pending && n < 500; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(check.last?.frame_id, String(i));
    const body = wire.at(-1);
    assert.match(JSON.stringify(body.system), /鲸鱼助手/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content.filter(b => b.type === 'image' && b.source.data).length, 1);
    assert.equal(body.tools?.length ?? 0, 0);
    assert.doesNotMatch(JSON.stringify(body), /MAIN_PRIVATE|WATCH_REASON/);
  }
  assert.equal(spoken, 10);
  reply = 'PANEL_ANSWER';
  assert.equal((await panel.complete({ text: 'PANEL_QUESTION' })).text, reply);
  assert.match(JSON.stringify(wire.at(-1).messages), /EYE_18/);
  assert.doesNotMatch(JSON.stringify(wire.at(-1).messages), /MAIN_PRIVATE|WATCH_REASON|EYE_19|"type":"image"/);
  let pref = { version: 'v1', style: '一次只说一步' };
  const guided = new PanelChatModel({ ctx, sessionId: 'parent-fixture',
    memory: { guidancePreference: async () => pref } });
  reply = 'OLD_GUIDANCE_ECHO';
  await guided.complete({ text: '教我打开计算器' });
  assert.match(JSON.stringify(wire.at(-1)), /一次只说一步/);
  pref = { version: 'v2', style: '先给概览' };
  reply = 'OVERVIEW_ECHO';
  await guided.complete({ text: '下一步' });
  assert.match(JSON.stringify(wire.at(-1)), /先给概览/);
  assert.doesNotMatch(JSON.stringify(wire.at(-1)), /一次只说一步|OLD_GUIDANCE_ECHO/);
  pref = null;
  reply = 'neutral reply';
  await guided.complete({ text: '继续' });
  assert.doesNotMatch(JSON.stringify(wire.at(-1)), /一次只说一步|OLD_GUIDANCE_ECHO|先给概览|OVERVIEW_ECHO/);
  let released = false;
  guided.observe = async () => ({ image_ref:image, frame_id:'visual-fixture',
    geometry_revision:'visual-g1', captured_at:new Date().toISOString(),
    bounds:{left:0,top:0,width:1920,height:1080}, release:async()=>{released=true;} });
  reply = JSON.stringify({text:'VISUAL_GUIDE',target:{label:'fixture',position:[500,500]}});
  const visualReply = await guided.complete({text:'继续'});
  assert.deepEqual(visualReply.highlightTarget.rect,[942,522,36,36]);
  assert.equal(released,true);
  assert.equal(wire.at(-1).messages.at(-1).content.filter(b=>b.type==='image' && b.source.data).length,1);
  assert.equal(wire.at(-1).tools?.length ?? 0,0);
  assert.equal(wire.at(-1).max_tokens,2048);
  assert.equal(wire.at(-1).thinking.type,'disabled');
  const oldHistory = JSON.stringify(panel.history);
  stopReason='max_tokens';
  await assert.rejects(panel.complete({text:'truncation fixture'}),error=>error.code==='COMPANION_MAX_TOKENS');
  assert.equal(JSON.stringify(panel.history),oldHistory);
  stopReason='tool_use';
  await assert.rejects(panel.complete({text:'tool stop fixture'}),error=>error.code==='COMPANION_TOOL_CALL');
  assert.equal(JSON.stringify(panel.history),oldHistory);
  stopReason='end_turn';
  assert.equal(events.length, initialEvents);
  reply = 'parent-second';
  await mainTurn('MAIN_PRIVATE_2');
  assert.match(JSON.stringify(wire.at(-1).messages), /MAIN_PRIVATE_1/);
  assert.doesNotMatch(JSON.stringify(wire.at(-1)), /PANEL_|EYE_|WATCH_REASON|桌面陪伴角色|一次只说一步|先给概览|OVERVIEW_ECHO|"type":"image"/);
  assert.doesNotMatch(JSON.stringify(wire.at(-1)), /VISUAL_GUIDE/);
  assert.equal(wire.length, 29);
  console.log('PASS: 29 local SSE requests; image transport, parent isolation, max_tokens/tool_use diagnosis and incomplete history rejection verified. No network.');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
