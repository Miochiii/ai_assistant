import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readTaskContext,taskContextText} from '../plugins/dsh-orb-memory/task-context.js';
import {installOrbTaskMemory,validateTaskState} from '../plugins/dsh-orb-memory/task-host.js';
import {atomicJson} from '../plugins/dsh-orb-memory/cutover-store.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const generation='a'.repeat(64),nextGeneration='b'.repeat(64);
test('mixed text and structured memories preserve JSON data without rejecting the task',async()=>{
  const items=[{memory_id:'editor',content:'我用 PyCharm 写 Python'},
    {memory_id:'profile',content:{language:'Python',preferences:['简短回答'],note:'literal {{context}}'}},
    {memory_id:'steps',content:[{tool:'PyCharm',purpose:'Python development'}]}];
  const memory={v2:async(_s,op)=>op==='memory_generation'?{enabled:true,generation,consent_revision:1}:{items}};
  const snapshot=await readTaskContext(memory,{},'帮我打开 Python 开发工具',new AbortController().signal);
  assert.deepEqual(snapshot.items,items);
  const payload=JSON.parse(taskContextText(snapshot).split('\n')[1]);
  assert.deepEqual(payload.items,items);assert.equal(payload.execution_authority,false);
});
test('malformed recalled items still fail closed',async()=>{
  for(const item of [{content:'missing ID'},{memory_id:'x',content:undefined},{memory_id:'x',content:null}]){
    const memory={v2:async(_s,op)=>op==='memory_generation'?{enabled:true,generation,consent_revision:1}:{items:[item]}};
    await assert.rejects(readTaskContext(memory,{},'task',new AbortController().signal),/MEMORY_RECALL_INVALID/);
  }
});
test('task retrieval checks revision, switch, limits and data-only context',async()=>{
  let enabled=true,changed=false,calls=0;
  const memory={v2:async(_s,op)=>{
    if(op==='memory_generation')return {enabled,generation:changed?nextGeneration:generation,consent_revision:1};
    calls++;return {items:[{memory_id:'editor',content:'我用 PyCharm 写 Python'}]};
  }};
  const snapshot=await readTaskContext(memory,{},'打开开发工具',new AbortController().signal);
  assert.equal(snapshot.items[0].memory_id,'editor');assert.match(taskContextText(snapshot),/execution_authority":false/);
  enabled=false;assert.deepEqual((await readTaskContext(memory,{},'打开开发工具',new AbortController().signal)).items,[]);assert.equal(calls,1);
  enabled=true;const original=memory.v2;
  memory.v2=async(...args)=>{const result=await original(...args);if(args[1]==='rag_recall')changed=true;return result;};
  await assert.rejects(readTaskContext(memory,{},'任务',new AbortController().signal),/MEMORY_CHANGED/);
});
async function fixture(t,options={}){
  const temp=await mkdtemp(join(root,'tmp/orb-task-unit-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const stateFile=join(temp,'state.json'),sessionFile=join(temp,'binding.json');await atomicJson(sessionFile,{sessionId:'old'});
  let current=generation,stored=options.state??{schema:1,exposures:[]},submitted=0,created=0,released=false;
  const agents=new Map(),hooks=new Map(),statuses=[],transcript=[];
  function add(id){const agent={id,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id,header:{cwd:root,agentPreset:'computer-use'},deriveMessages:()=>[]}};agents.set(id,agent);return agent;}
  add('old');
  let pendingContext;
  const context=()=>pendingContext??Promise.resolve({generation:current,enabled:true,items:[{memory_id:'e',content:'PyCharm'}]});
  const services={agents:{get:id=>agents.get(id)},sessions:{get:id=>agents.get(id)?.session},
    orbMemoryGeneration:{current:async()=>current},orbMemory:{taskContext:context},systemPrompt:{context:()=>()=>{}}};
  const ctx={get:name=>services[name],provide:(name,value)=>services[name]=value,
    on:(name,handler)=>{hooks.set(name,handler);return ()=>hooks.delete(name);},effect(){},
    sessionController:{create:async()=>({sessionId:add(`fresh-${++created}`).id})}};
  const runtime={sessionId:'old',sessionFile,store:{workspaceDirectory:()=>root},lasso:{pending:new Map()},
    ensureSession:async()=>runtime.sessionId,workspaceId:async()=>'w',agentRegistry:()=>({list:()=>[]}),
    block:(_id,role,text)=>transcript.push({role,text}),status:text=>statuses.push(text),
    async applyMemoryBinding(id){this.sessionId=id;if(!this.memoryTasks.switching)this.memoryTasks.abort();},
    async submitPrompt(){submitted++;await options.onSubmit?.(this,statuses);},async newSession(){this.sessionId=add('user-selected').id;await atomicJson(sessionFile,{sessionId:this.sessionId});},async openSession(id){this.sessionId=id;}};
  const service=installOrbTaskMemory(ctx,runtime,{stateFile,legacyGuardOnly:options.legacyGuardOnly},{acquire:async()=>({release:async()=>released=true}),
    readState:async()=>{if(options.readFailure)throw new Error('read');return structuredClone(stored);},
    writeState:async s=>{if(options.writeFailure)throw new Error('disk');await options.onWrite?.();stored=structuredClone(s);}});
  await service.ready;t.after(()=>service.dispose());
  return {service,runtime,hooks,statuses,transcript,sessionFile,agents,version:v=>current=v,
    context:p=>pendingContext=p,counts:()=>({submitted,created,released}),stored:()=>stored};
}
test('failed initial read and failed exposure persistence do not submit actions',async t=>{
  for(const option of ['readFailure','writeFailure']){
    const f=await fixture(t,{[option]:true});await f.runtime.submitPrompt('打开开发工具');
    assert.equal(f.counts().submitted,0);assert.equal(await f.service.allowed('old'),false);
    assert.match(f.statuses.at(-1),/未提交操作/);
  }
});
test('backend handoff retires old exposure and runs new tasks without legacy retrieval',async t=>{
  const f=await fixture(t,{legacyGuardOnly:true,state:{schema:1,exposures:[{sessionId:'old',generation,retired:false}]}});
  // A never-resolving old backend proves the new route does not call it.
  f.context(new Promise(()=>{}));
  assert.equal(await f.service.allowed('old'),false);
  await f.runtime.submitPrompt('新后端任务');
  assert.equal(f.runtime.sessionId,'fresh-1');assert.equal(f.counts().submitted,1);
  assert(!f.statuses.some(s=>s.includes('查询有效记忆')));
  assert.equal(f.stored().exposures.length,1);assert(f.stored().exposures[0].retired);
});
test('pending footer clears before native submission and preserves native task status',async t=>{
  const f=await fixture(t,{onSubmit:async(runtime,statuses)=>{
    assert.equal(statuses.at(-1),'');runtime.status('原任务状态');
  }});
  await f.runtime.submitPrompt('打开开发工具');
  assert(f.statuses.includes('正在为当前任务查询有效记忆…'));
  assert.equal(f.statuses.at(-1),'原任务状态');
});
test('abort clears the pending footer immediately even while retrieval has not settled',async t=>{
  const f=await fixture(t);let resolve;
  f.context(new Promise(r=>resolve=r));const pending=f.runtime.submitPrompt('task');
  await new Promise(r=>setImmediate(r));assert.match(f.statuses.at(-1),/正在为当前任务/);
  f.service.abort();assert.equal(f.statuses.at(-1),'');
  f.runtime.status('用户已停止');
  resolve({generation,enabled:true,items:[]});await pending;
  assert.equal(f.counts().submitted,0);assert.equal(f.statuses.at(-1),'用户已停止');
});
test('finishing a cancelled request does not clear the next request footer',async t=>{
  const f=await fixture(t);let resolveOld,resolveNew;
  f.context(new Promise(r=>resolveOld=r));const old=f.runtime.submitPrompt('old');
  await new Promise(r=>setImmediate(r));
  f.context(new Promise(r=>resolveNew=r));const next=f.runtime.submitPrompt('new');
  assert.equal(f.statuses.at(-1),'');
  resolveOld({generation,enabled:true,items:[]});await old;
  await new Promise(r=>setImmediate(r));assert.match(f.statuses.at(-1),/正在为当前任务/);
  resolveNew({generation,enabled:true,items:[]});await next;
  assert.equal(f.statuses.at(-1),'');assert.equal(f.counts().submitted,1);
});
test('changed memory rotates once, preserves current request and retires the old history',async t=>{
  const f=await fixture(t);await f.runtime.submitPrompt('打开开发工具');assert.equal(f.counts().submitted,1);
  f.version(nextGeneration);await f.runtime.submitPrompt('再次打开开发工具');
  assert.equal(f.runtime.sessionId,'fresh-1');assert.equal(f.counts().submitted,2);
  assert.equal(JSON.parse(await readFile(f.sessionFile,'utf8')).sessionId,'fresh-1');
  assert.equal(await f.service.allowed('old'),false);assert.equal(await f.service.allowed('fresh-1'),true);
  assert(f.transcript.some(r=>r.role==='user'&&r.text==='再次打开开发工具'));
});
test('cancelled retrieval never submits and a chat change wins over pending preparation',async t=>{
  const f=await fixture(t);let resolve;
  f.context(new Promise(r=>resolve=r));const pending=f.runtime.submitPrompt('不要执行的旧任务');
  await new Promise(r=>setImmediate(r));const selected=f.runtime.newSession();
  resolve({generation,enabled:true,items:[]});await pending;await selected;
  assert.equal(f.counts().submitted,0);assert.equal(f.runtime.sessionId,'user-selected');
});
test('lasso and unresolved background work never silently transfer to another session',async t=>{
  const f=await fixture(t);await f.runtime.submitPrompt('task');f.version(nextGeneration);
  await f.runtime.submitPrompt('task with selection','lasso');assert.equal(f.counts().submitted,1);assert.equal(f.counts().created,0);
  f.runtime.agentRegistry=()=>({list:()=>[{callerId:'old',sessionId:'unknown-worker'}]});
  await f.runtime.submitPrompt('task');assert.equal(f.counts().submitted,1);assert.equal(f.counts().created,0);
});
test('unknown/duplicate state schema is rejected',()=>{
  assert.throws(()=>validateTaskState({schema:1,exposures:[{sessionId:'a',generation,retired:false},{sessionId:'a',generation,retired:false}]}));
  assert.throws(()=>validateTaskState({schema:2,exposures:[]}));
});
test('chat selection waits for exposure persistence and cancels the old admission',async t=>{
  let entered,release;const writing=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
  const f=await fixture(t,{onWrite:async()=>{entered();await blocked;}});
  const pending=f.runtime.submitPrompt('旧请求');await writing;
  const selected=f.runtime.newSession();assert.equal(f.runtime.sessionId,'old');
  release();await pending;await selected;
  assert.equal(f.counts().submitted,0);assert.equal(f.runtime.sessionId,'user-selected');
});
