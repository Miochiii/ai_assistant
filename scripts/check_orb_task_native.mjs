// Installed DSH SDK, real persistent gate, fake model/tools/memory. No desktop actions.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {installOrbTaskMemory} from '../plugins/dsh-orb-memory/task-host.js';
import {atomicJson} from '../plugins/dsh-orb-memory/cutover-store.js';
globalThis.fetch=()=>{throw new Error('Network forbidden');};
const root=fileURLToPath(new URL('../',import.meta.url));
const base='E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk=name=>import(pathToFileURL(`${base}${name}/lib/index.js`));
const {Context,Service}=await sdk('cordis');
const {SessionStore}=await sdk('dsh-session');
const {SessionProjectionRegistry}=await sdk('dsh-session-projection');
const {SystemPrompt}=await sdk('dsh-system-prompt');
const {ToolRuntime}=await sdk('dsh-tools');
const {apply:installExecutor}=await sdk('dsh-tool-executor-native');
const {AgentRegistry}=await sdk('dsh-agent');
const {AgentLoop}=await sdk('dsh-agent-loop');
const {LlmRuntime,LlmAdapter,createUserMessage}=await sdk('dsh-llm');
const temp=await mkdtemp(join(root,'tmp/orb-task-native-'));
const stateFile=join(temp,'exposures.json'),sessionFile=join(temp,'binding.json');
const handles=[],contexts=[],requests=[],statuses=[];
let version='a'.repeat(64),enabled=true,toolCalls=0,created=0,mode='normal',modelStep=0;
const marker='SYNTHETIC_PyCharm_PREFERENCE';
const meta={cwd:root,agentPreset:'computer-use'},agentOptions={provider:'offline-memory',model:'fixture',maxTokens:256};
class Fixture extends LlmAdapter{
  resolveModel(provider,id){return {provider,id,name:'offline',inputModalities:['text'],context:{contextWindow:32000},defaultMaxTokens:256};}
  async prepareCall(provider,id){return {model:this.resolveModel(provider,id),stream:o=>this.stream(o)};}
  async *stream(o){
    const hasMemory=JSON.stringify(o.messages).includes(marker);requests.push({id:o.sessionId,hasMemory});
    if(mode==='stream-change')version='c'.repeat(64);
    if(mode==='normal'&&++modelStep%2===0){yield {type:'block-end',index:0,block:{type:'text',text:'Completed synthetic task.'}};yield {type:'finish',reason:{kind:'stop'}};return;}
    yield {type:'block-end',index:0,block:{type:'tool-call',id:`call-${requests.length}`,name:'fixture_open',arguments:JSON.stringify({editor:hasMemory?'PyCharm':'default'})}};
    yield {type:'finish',reason:{kind:'tool-calls'}};
  }
}
async function createContext(){
  const ctx=new Context();contexts.push(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:true});
  const tools=new ToolRuntime(ctx);installExecutor(ctx);
  const llm=new LlmRuntime(ctx);const agents=new AgentRegistry(ctx);await agents[Service.init]();
  const loop=new AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}});await loop[Service.init]();
  tools.register({name:'fixture_open',description:'Synthetic open only',parameters:{type:'object',properties:{editor:{type:'string'}},required:['editor']},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:'synthetic tool output'}]},
    execute:async args=>{toolCalls++;assert.equal(args.editor,enabled?'PyCharm':'default');return {ok:true};}});
  llm.registerAdapter(['offline-memory'],new Fixture());
  ctx.provide('orbMemoryGeneration',{current:async()=>version});
  ctx.provide('orbMemory',{taskContext:async()=>({generation:version,enabled,items:enabled?[{memory_id:'editor',content:marker}]:[]})});
  ctx.on('tools/pre-execute',async(_o,next)=>{if(mode==='approval-change')version='e'.repeat(64);return next();});
  return ctx;
}
async function createAgent(ctx,id,options={}){
  const h=await ctx.agents.create({sessionId:id,meta,agentOptions,...options});handles.push(h);return h.agent;
}
async function turn(agent,text){
  agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
  let timer;
  try{await Promise.race([agent.whenIdle(),new Promise((_,reject)=>timer=setTimeout(()=>{agent.cancel({kind:'user'});reject(new Error('fixture timeout'));},10000))]);}
  finally{clearTimeout(timer);}
}
async function attach(ctx,id){
  ctx.provide('sessionController',{create:async()=>({sessionId:(await createAgent(ctx,`fresh-${++created}`)).id})});
  const runtime={sessionId:id,sessionFile,store:{workspaceDirectory:()=>root},lasso:{pending:new Map()},
    agentRegistry:()=>({list:()=>[]}),workspaceId:async()=>'fixture-workspace',ensureSession:async()=>runtime.sessionId,
    block(){},status:text=>statuses.push(text),async applyMemoryBinding(next){this.sessionId=next;},
    async submitPrompt(text){await turn(ctx.agents.get(this.sessionId),text);}};
  const service=installOrbTaskMemory(ctx,runtime,{stateFile});await service.ready;
  assert.equal(service.inspect().fault,false);return {service,runtime};
}
try{
  await atomicJson(stateFile,{schema:1,exposures:[]});await atomicJson(sessionFile,{sessionId:'initial'});
  const ctx=await createContext();const first=await createAgent(ctx,'initial');
  const {service,runtime}=await attach(ctx,'initial');
  await runtime.submitPrompt('帮我打开 Python 开发工具');assert.equal(toolCalls,1);assert(requests.every(r=>r.hasMemory));
  const seed=JSON.parse(JSON.stringify(first.session.snapshotEvents()));
  const header=JSON.parse(JSON.stringify(first.session.header));
  assert(JSON.stringify(seed).includes(marker));
  version='b'.repeat(64);enabled=false;
  await runtime.submitPrompt('再次打开开发工具');assert.notEqual(runtime.sessionId,'initial');assert.equal(toolCalls,2);
  assert(requests.filter(r=>r.id===runtime.sessionId).every(r=>!r.hasMemory));
  assert.equal(await service.allowed('initial'),false);
  const count=requests.length;await turn(first,'late background completion');assert.equal(requests.length,count);
  // A child inherits the source's invalidation even before its first request.
  const child=await createAgent(ctx,'child',{meta:{...meta,agentPreset:'standard',parentSession:'initial'}});
  await turn(child,'delegated stale task');assert.equal(requests.length,count);
  version='d'.repeat(64);enabled=true;mode='approval-change';
  await runtime.submitPrompt('校验审批之后版本变化');assert.equal(toolCalls,2);
  mode='stream-change';version='f'.repeat(64);
  await runtime.submitPrompt('校验生成过程中版本变化');assert.equal(toolCalls,2);
  assert(statuses.every(s=>!s.startsWith('记忆任务准备未完成')),statuses.join('\n'));
  for(const h of handles.splice(0).reverse())await h.dispose();
  await ctx.fiber.dispose();contexts.splice(contexts.indexOf(ctx),1);
  const restored=await createContext();const old=await createAgent(restored,'initial',{seed,meta:header});
  const attached=await attach(restored,'initial');
  assert.equal(await attached.service.allowed('initial'),false);
  const before=requests.length;await turn(old,'restored old history');assert.equal(requests.length,before);
  const report={passed:true,native_sdk:true,fake_memory:true,fake_model:true,real_orb_ui:false,
    task_received_memory:true,synthetic_tool_selected_pycharm:true,disable_rotated_clean_session:true,
    retired_history_blocked_after_restart:true,stale_child_blocked:true,approval_gap_tool_blocked:true,
    stream_change_tool_blocked:true,paid_requests:0,desktop_actions:0,tool_calls:toolCalls};
  await writeFile(join(root,'results/memory/orb-task-native.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{
  for(const h of handles.reverse())await h.dispose();
  for(const ctx of contexts.reverse())await ctx.fiber.dispose();
  await rm(temp,{recursive:true,force:true});
}
