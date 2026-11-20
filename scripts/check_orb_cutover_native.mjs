// Native installed-SDK fixture only. No profile, production DB or network access.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {prepareCleanSession} from '../plugins/dsh-orb-memory/clean-session.js';
import {installOrbMemoryCutover} from '../plugins/dsh-orb-memory/orb-host-adapter.js';
import {atomicJson} from '../plugins/dsh-orb-memory/cutover-store.js';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {callMemory} from '../plugins/dsh-desktop-observe/memory-client.js';
import {createMemoryGenerationProvider} from '../plugins/dsh-orb-memory/generation.js';
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
let oldCalls=0,toolCalls=0,currentGeneration='v1',invalidateDuringStream=false;
const temp=await mkdtemp(join(root,'tmp/orb-native-cutover-'));
const stateFile=join(temp,'state.json'),sessionFile=join(temp,'binding.json');
const sqliteGeneration=process.argv.includes('--sqlite-generation');
const residentGeneration=process.argv.includes('--resident-generation');
const previousDb=process.env.DSH_MEMORY_DB,previousPython=process.env.DSH_MEMORY_PYTHON;
let memoryHost,versionProvider;
const generationCheckMs=[];
const memorySession={id:'fixture-memory-control',header:{cwd:temp}};
async function readGeneration(){
  const started=performance.now();
  try{return versionProvider?await versionProvider.current():currentGeneration;}
  finally{if(versionProvider)generationCheckMs.push(performance.now()-started);}
}
async function advanceGeneration(value){
  if(memoryHost)await memoryHost.v2(memorySession,'daily_configure',{enabled:value!=='v2'});
  else currentGeneration=value;
}
class Fixture extends LlmAdapter {
  resolveModel(provider,id){return {provider,id,name:'offline',inputModalities:['text'],context:{contextWindow:32000},defaultMaxTokens:256};}
  async prepareCall(provider,id){return {model:this.resolveModel(provider,id),stream:o=>this.stream(o)};}
  async *stream(options){
    const text=JSON.stringify(options.messages);
    snapshots.push({sessionId:options.sessionId,oldMemory:text.includes(marker),derived:text.includes(derived),lateNotice:text.includes(late)});
    if(invalidateDuringStream){
      await advanceGeneration('v3');
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'must-not-run',name:'fixture_echo',arguments:'{}'}};
      yield {type:'finish',reason:{kind:'tool-calls'}};return;
    }
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
async function attach(ctx,id){
  ctx.provide('orbMemoryGeneration',{current:readGeneration});
  const runtime={sessionId:id,sessionFile,store:{workspaceDirectory:()=>root,lassoEnabled:()=>false},
    lasso:{pending:new Map()},agentRegistry:()=>({list:()=>[]}),
    async preempt(){},async newSession(){},async openSession(){},
    async applyMemoryBinding(next){this.sessionId=next;}};
  const service=installOrbMemoryCutover(ctx,runtime,{stateFile});
  await service.ready;return {service,runtime};
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
  if(sqliteGeneration){
    process.env.DSH_MEMORY_DB=join(temp,'memory.sqlite3');
    process.env.DSH_MEMORY_PYTHON='E:/file/agent/python.v/.venv/Scripts/python.exe';
    await mkdir(join(temp,'configs'));
    await writeFile(join(temp,'configs/memory-v2.json'),JSON.stringify({enabled:true,allowed_workspace:temp}));
    memoryHost=createMemoryHost({root:temp,residentGeneration,generationRoot:root,userId:'fixture-orb-user',call:args=>callMemory({...args,root,runRoot:temp})});
    versionProvider=createMemoryGenerationProvider({memory:memoryHost,session:memorySession});
  }
  const ctx=await runtime();
  const old=await ctx.agents.create({sessionId:'old-exposed',meta,agentOptions});handles.push(old);
  await atomicJson(sessionFile,{sessionId:old.agent.id});
  const attached=await attach(ctx,old.agent.id);
  await attached.service.initialize({sessionId:old.agent.id,generation:await readGeneration()});
  await turn(old.agent,'Use the synthetic tool, then answer.');
  assert.equal(oldCalls,2);assert.equal(toolCalls,1);
  const oldLog=JSON.stringify(old.agent.session.snapshotEvents());
  assert(oldLog.includes(marker)&&oldLog.includes(derived));
  await advanceGeneration('v2');
  const nextGeneration=await readGeneration();
  const prepared=await prepareCleanSession({source:old.agent,agents:ctx.agents,newId:'fresh-clean',meta,agentOptions,
    expectedVersion:nextGeneration,readVersion:readGeneration,backgroundState:async()=>'clear'});
  handles.push(prepared.handle);assert.equal(prepared.bindingChanged,false);
  await attached.service.commitMemoryCutover(prepared,0);
  assert.equal(attached.runtime.sessionId,'fresh-clean');
  await turn(prepared.handle.agent,'Start without previous context.');
  // Model an explicitly retired caller. Native pre-step rejection stops a late
  // Orb-style notice from launching a new LLM/tool cycle in that caller.
  const blockedBefore=old.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'&&e.data.reason?.kind==='blocked').length;
  const before=snapshots.length;
  await turn(old.agent,late,{kind:'computer-use',form:'notice',summary:'Synthetic completion'});
  assert.equal(snapshots.length,before);assert.equal(old.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'&&e.data.reason?.kind==='blocked').length,blockedBefore+1);assert.equal(toolCalls,1);
  assert(!JSON.stringify(prepared.handle.agent.session.snapshotEvents()).includes(late));

  // Restore into a separate runtime from only the new session's complete log.
  const seed=JSON.parse(JSON.stringify(prepared.handle.agent.session.snapshotEvents()));
  const freshId=prepared.handle.agent.id;
  const freshHeader=JSON.parse(JSON.stringify(prepared.handle.agent.session.header));
  await prepared.handle.dispose();handles.splice(handles.indexOf(prepared.handle),1);
  await old.dispose();handles.splice(handles.indexOf(old),1);
  await ctx.fiber.dispose();contexts.splice(contexts.indexOf(ctx),1);
  const restoredCtx=await runtime();
  const restored=await restoredCtx.agents.create({sessionId:freshId,seed,meta:freshHeader,agentOptions});handles.push(restored);
  const afterRestart=await attach(restoredCtx,freshId);
  await afterRestart.service.recover();
  assert.equal(afterRestart.service.permits('old-exposed'),false);
  await turn(restored.agent,'Continue the clean conversation after restoration.');
  assert.deepEqual(errors,[]);assert.equal(snapshots.length,4);
  invalidateDuringStream=true;
  await turn(restored.agent,'Synthetic version change during inference.');
  assert.equal(toolCalls,1,'No tool call from a stale stream may execute');
  assert.equal(errors.length,1);assert.match(errors[0],/MEMORY_SESSION_CHANGED/);
  const sourceHashes={};
  for(const pkg of ['dsh-session','dsh-agent-loop','dsh-llm']){
    sourceHashes[pkg]=createHash('sha256').update(await readFile(`${base}${pkg}/lib/index.js`)).digest('hex');
  }
  const report={checked_at:new Date().toISOString(),installed_sdk:version,passed:true,snapshots,
    initial_tool_calls:toolCalls,old_history_preserved:true,fresh_session_no_inherited_history:true,
    restore_from_clean_log_passed:true,late_notice_blocked_in_retired_caller:true,
    retired_gate_durable:true,host_adapter_fixture:true,real_orb_runtime:false,orb_ui_binding_tested:false,production_integration:false,
    stale_stream_tool_blocked:true,real_sqlite_generation:sqliteGeneration,resident_generation:residentGeneration,
    generation_checks:sqliteGeneration?{count:generationCheckMs.length,
      total_ms:Math.round(generationCheckMs.reduce((a,b)=>a+b,0)),
      max_ms:Math.round(Math.max(...generationCheckMs))}:null,
    paid_model_requests:0,network_requests:0,desktop_actions:0,source_sha256:sourceHashes};
  await mkdir(join(root,'results/memory'),{recursive:true});
  const reportPath=`results/memory/orb-cutover-${residentGeneration?'resident-':''}${sqliteGeneration?'sqlite-':''}native-20261110.json`;
  await writeFile(join(root,reportPath),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({passed:true,fixture_requests:snapshots.length,report:reportPath})+'\n');
} finally {
  for(const handle of handles.reverse()) await handle.dispose();
  for(const ctx of contexts.reverse()) await ctx.fiber.dispose();
  memoryHost?.dispose();
  if(previousDb===undefined)delete process.env.DSH_MEMORY_DB;else process.env.DSH_MEMORY_DB=previousDb;
  if(previousPython===undefined)delete process.env.DSH_MEMORY_PYTHON;else process.env.DSH_MEMORY_PYTHON=previousPython;
  await rm(temp,{recursive:true,force:true});
}
