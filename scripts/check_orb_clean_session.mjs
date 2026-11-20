// Native installed-SDK fixture only. No profile, production DB or network access.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {prepareCleanSession} from '../plugins/dsh-orb-memory/clean-session.js';
globalThis.fetch=()=>{throw new Error('Network forbidden');};
const root=fileURLToPath(new URL('../',import.meta.url));
const base='E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk=name=>import(pathToFileURL(`${base}${name}/lib/index.js`));
const version=JSON.parse(await readFile(`${base}dsh-agent-loop/package.json`,'utf8')).version;
assert.equal(version,'0.2.2-rc.1');
const {Context,Service}=await sdk('cordis');
const {SessionStore}=await sdk('dsh-session');
const {SessionProjectionRegistry}=await sdk('dsh-session-projection');
const {SystemPrompt}=await sdk('dsh-system-prompt');
const {ToolRuntime}=await sdk('dsh-tools');
const {apply:installExecutor}=await sdk('dsh-tool-executor-native');
const {AgentRegistry}=await sdk('dsh-agent');
const {AgentLoop}=await sdk('dsh-agent-loop');
const {LlmRuntime,LlmAdapter,createUserMessage}=await sdk('dsh-llm');
const marker='SYNTHETIC_REVOKED_MEMORY_20261110';
const derived='SYNTHETIC_DERIVED_REPLY_20261110';
const late='SYNTHETIC_OLD_BACKGROUND_NOTICE';
const snapshots=[],errors=[],contexts=[],handles=[];
let oldCalls=0,toolCalls=0;
class Fixture extends LlmAdapter {
  resolveModel(provider,id){return {provider,id,name:'offline',inputModalities:['text'],context:{contextWindow:32000},defaultMaxTokens:256};}
  async prepareCall(provider,id){return {model:this.resolveModel(provider,id),stream:o=>this.stream(o)};}
  async *stream(options){
    const text=JSON.stringify(options.messages);
    snapshots.push({sessionId:options.sessionId,oldMemory:text.includes(marker),derived:text.includes(derived),lateNotice:text.includes(late)});
    if(options.sessionId==='old-exposed') {
      oldCalls++;
      if(oldCalls===1){
        assert(text.includes(marker));
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture-call',name:'fixture_echo',arguments:'{}'}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      yield {type:'block-end',index:0,block:{type:'text',text:derived}};
    } else {
      assert(!text.includes(marker));assert(!text.includes(derived));assert(!text.includes(late));
      yield {type:'block-end',index:0,block:{type:'text',text:'Clean conversation reply.'}};
    }
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function runtime(){
  const ctx=new Context();contexts.push(ctx);
  new SessionStore(ctx);new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:true});
  const tools=new ToolRuntime(ctx);installExecutor(ctx);
  const llm=new LlmRuntime(ctx);const agents=new AgentRegistry(ctx);await agents[Service.init]();
  const loop=new AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}});await loop[Service.init]();
  ctx.systemPrompt.context({name:'memory:fixture',order:850,interpolate:false,
    text:context=>context.agent?.id==='old-exposed'?marker:''});
  tools.register({name:'fixture_echo',description:'Synthetic fixture only',parameters:{type:'object',properties:{}},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:marker}]},
    execute:async()=>{toolCalls++;return {fixture:true};}});
  llm.registerAdapter(['offline-clean'],new Fixture());
  ctx.on('agent/error',({error})=>errors.push(error.message));
  return ctx;
}
const agentOptions={provider:'offline-clean',model:'fixture',maxTokens:256};
const meta={cwd:root,agentPreset:'computer-use'};
async function turn(agent,text,source={kind:'user'}){
  agent.followup(createUserMessage({content:[{type:'text',text}],source}));
  let timer;
  try {await Promise.race([agent.whenIdle(),new Promise((_,reject)=>{
    timer=setTimeout(()=>{agent.cancel({kind:'user'});reject(new Error('Fixture timed out'));},10000);
  })]);} finally {clearTimeout(timer);}
}
try {
  const ctx=await runtime();
  const old=await ctx.agents.create({sessionId:'old-exposed',meta,agentOptions});handles.push(old);
  await turn(old.agent,'Use the synthetic tool, then answer.');
  assert.equal(oldCalls,2);assert.equal(toolCalls,1);
  const oldLog=JSON.stringify(old.agent.session.snapshotEvents());
  assert(oldLog.includes(marker)&&oldLog.includes(derived));
  const prepared=await prepareCleanSession({source:old.agent,agents:ctx.agents,newId:'fresh-clean',meta,agentOptions,
    expectedVersion:'v2',readVersion:async()=>'v2',backgroundState:async()=>'clear'});
  handles.push(prepared.handle);assert.equal(prepared.bindingChanged,false);
  await turn(prepared.handle.agent,'Start without previous context.');
  // Model an explicitly retired caller. Native pre-step rejection stops a late
  // Orb-style notice from launching a new LLM/tool cycle in that caller.
  let rejected=0;
  const off=old.agent.ctx.on('agent/pre-step',()=>{rejected++;return {kind:'reject'};});
  const before=snapshots.length;
  await turn(old.agent,late,{kind:'computer-use',form:'notice',summary:'Synthetic completion'});
  assert.equal(snapshots.length,before);assert.equal(rejected,1);assert.equal(toolCalls,1);
  assert(!JSON.stringify(prepared.handle.agent.session.snapshotEvents()).includes(late));
  off();
  // Restore into a separate runtime from only the new session's complete log.
  const seed=JSON.parse(JSON.stringify(prepared.handle.agent.session.snapshotEvents()));
  const freshId=prepared.handle.agent.id;
  const freshHeader=JSON.parse(JSON.stringify(prepared.handle.agent.session.header));
  await prepared.handle.dispose();handles.splice(handles.indexOf(prepared.handle),1);
  const restoredCtx=await runtime();
  const restored=await restoredCtx.agents.create({sessionId:freshId,seed,meta:freshHeader,agentOptions});handles.push(restored);
  await turn(restored.agent,'Continue the clean conversation after restoration.');
  assert.deepEqual(errors,[]);assert.equal(snapshots.length,4);
  const sourceHashes={};
  for(const pkg of ['dsh-session','dsh-agent-loop','dsh-llm']){
    sourceHashes[pkg]=createHash('sha256').update(await readFile(`${base}${pkg}/lib/index.js`)).digest('hex');
  }
  const report={checked_at:new Date().toISOString(),installed_sdk:version,passed:true,snapshots,
    initial_tool_calls:toolCalls,old_history_preserved:true,fresh_session_no_inherited_history:true,
    restore_from_clean_log_passed:true,late_notice_blocked_in_retired_caller:true,
    retired_gate_durable:false,orb_ui_binding_tested:false,production_integration:false,
    paid_model_requests:0,network_requests:0,desktop_actions:0,source_sha256:sourceHashes};
  await mkdir(join(root,'results/memory'),{recursive:true});
  await writeFile(join(root,'results/memory/orb-clean-session-20261110.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({passed:true,fixture_requests:snapshots.length,report:'results/memory/orb-clean-session-20261110.json'})+'\n');
} finally {
  for(const handle of handles.reverse()) await handle.dispose();
  for(const ctx of contexts.reverse()) await ctx.fiber.dispose();
}
