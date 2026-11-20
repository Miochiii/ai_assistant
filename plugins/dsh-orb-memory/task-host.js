import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {atomicJson} from './cutover-store.js';
import {acquireOrbCutoverLocks} from './process-lock.js';
import {taskContextText} from './task-context.js';

export function validateTaskState(value){
  if(value?.schema!==1||!Array.isArray(value.exposures))throw new Error('MEMORY_TASK_STATE_INVALID');
  const ids=new Set();
  for(const row of value.exposures){
    if(typeof row?.sessionId!=='string'||!row.sessionId||ids.has(row.sessionId)
      ||typeof row.generation!=='string'||!/^[a-f0-9]{64}$/.test(row.generation)||typeof row.retired!=='boolean')throw new Error('MEMORY_TASK_STATE_INVALID');
    ids.add(row.sessionId);
  }
  return value;
}

// Persistence precedes exposure. Old histories and their child sessions remain
// blocked after revocation, including after app restart. No memory is a tool grant.
export function installOrbTaskMemory(ctx,runtime,{stateFile,legacyGuardOnly=false},dependencies={}){
  const canonical=p=>{try{return realpathSync.native(p).toLowerCase();}catch{return null;}};
  const workspace=canonical(runtime.store.workspaceDirectory());
  if(!workspace)throw new Error('MEMORY_WORKSPACE_UNAVAILABLE');
  const readState=dependencies.readState??(async()=>JSON.parse(await readFile(stateFile,'utf8')));
  const writeState=dependencies.writeState??(s=>atomicJson(stateFile,s));
  const acquire=dependencies.acquire??(()=>acquireOrbCutoverLocks(stateFile,runtime.sessionFile));
  let state,ownership,fault,controller,closed=false,switching=false,queue=Promise.resolve(),writes=Promise.resolve();
  const contexts=new Map();
  const ready=(async()=>{
    ownership=await acquire();state=validateTaskState(await readState());
    // A backend handoff must never reuse histories exposed to the old backend.
    if(legacyGuardOnly)for(const row of [...state.exposures])if(!row.retired)await save({...row,retired:true});
  })().catch(e=>{fault=e;});
  async function save(row){
    const pending=writes.then(async()=>{
      if(fault||closed)throw new Error('MEMORY_TASK_STATE_UNAVAILABLE');
      const next={schema:1,exposures:[...state.exposures.filter(r=>r.sessionId!==row.sessionId),row]};
      try{await writeState(next);state=next;}catch(e){fault=e;throw e;}
    });
    writes=pending.catch(()=>{});return pending;
  }
  const generation=async signal=>{
    const value=await ctx.get('orbMemoryGeneration')?.current(signal);
    if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('MEMORY_GENERATION_UNAVAILABLE');
    return value;
  };
  const session=id=>ctx.get('agents')?.get(id)?.session??ctx.get('sessions')?.get(id);
  function lineage(id){
    const ids=[];
    while(id&&!ids.includes(id)&&ids.length<64){
      ids.push(id);
      id=session(id)?.header?.parentSession??runtime.agentRegistry()?.list().find(r=>r.sessionId===id)?.callerId;
    }
    return ids;
  }
  function managed(id){
    return lineage(id).some(key=>{
      const s=session(key);return (s?.header.agentPreset==='computer-use'&&canonical(s.header.cwd)===workspace)
        ||state?.exposures.some(r=>r.sessionId===key);
    });
  }
  async function allowed(id,signal){
    await ready;
    if(!managed(id))return true;
    if(fault||closed)return false;
    const records=state.exposures.filter(r=>lineage(id).includes(r.sessionId));
    if(!records.length)return true;
    if(records.some(r=>r.retired))return false;
    try{
      const current=await generation(signal);
      if(records.some(r=>r.generation!==current))return false;
      // Record inherited exposure before a delegated model/tool can run.
      if(!state.exposures.some(r=>r.sessionId===id))await save({sessionId:id,generation:current,retired:false});
      return true;
    }catch{return false;}
  }
  const disposers=[];
  // The status footer persists until explicitly replaced. Own only our pending
  // message, so finishing/cancelling an old request cannot erase another status.
  const originalStatus=runtime.status;
  let pendingStatusOwner=null;
  runtime.status=function(...args){
    pendingStatusOwner=null;
    return originalStatus.apply(this,args);
  };
  function showPending(owner){
    runtime.status('正在为当前任务查询有效记忆…');
    pendingStatusOwner=owner;
  }
  function clearPending(owner){
    if(pendingStatusOwner===owner)runtime.status('');
  }
  disposers.push(()=>{runtime.status=originalStatus;});
  disposers.push(ctx.on('agent/pre-step',async(o,next)=>await allowed(o.agent.id,o.signal)?next():{kind:'reject'}));
  disposers.push(ctx.on('llm/stream',(o,next)=>(async function*(){
    if(!o.sessionId||!managed(o.sessionId)){yield* next();return;}
    if(!await allowed(o.sessionId,o.signal))throw new Error('MEMORY_SESSION_CHANGED');
    for await(const chunk of next()){
      if(!await allowed(o.sessionId,o.signal))throw new Error('MEMORY_SESSION_CHANGED');
      yield chunk;
    }
  })()));
  // Run after approval, at dispatch time: a pending approval is not a lease on
  // the earlier memory version. Throwing prevents the actual tool body.
  disposers.push(ctx.on('tools/execute',async(o,next)=>{
    if(o.agent&&!await allowed(o.agent.id,o.signal))throw new Error('MEMORY_SESSION_CHANGED');
    return next();
  }));
  if(!legacyGuardOnly)disposers.push(ctx.get('systemPrompt').context({name:'orb-task-memory',order:850,interpolate:false,
    text:({agent})=>taskContextText(contexts.get(agent?.id))}));
  const idle=id=>{
    const a=ctx.get('agents')?.get(id);
    return a?.status==='idle'&&a.inbox.nextTurn.length===0&&a.inbox.nextStep.length===0;
  };
  async function resolveAgent(id){
    if(!ctx.get('agents')?.get(id)){
      const resolved=await ctx.sessionController.resolveAgent(id);
      if(resolved?.error||!ctx.get('agents')?.get(id))throw new Error('MEMORY_AGENT_UNAVAILABLE');
    }
  }
  function abort(){controller?.abort();}
  async function prepare(text,lassoId,signal){
    await ready;if(fault||closed)throw new Error('MEMORY_TASK_STATE_UNAVAILABLE');
    const id=await runtime.ensureSession();signal.throwIfAborted();
    await resolveAgent(id);signal.throwIfAborted();
    if(!idle(id))throw new Error('MEMORY_TASK_NOT_IDLE');
    const snapshot=legacyGuardOnly?{generation:'0'.repeat(64),enabled:false,items:[]}
      :await ctx.get('orbMemory')?.taskContext(text,id,signal);
    if(!snapshot)throw new Error('MEMORY_SERVICE_UNAVAILABLE');
    signal.throwIfAborted();
    if(runtime.sessionId!==id||!idle(id))throw new Error('MEMORY_SESSION_CHANGED');
    let target=id;
    const old=state.exposures.find(r=>r.sessionId===id);
    if(old&&(old.retired||old.generation!==snapshot.generation)){
      if(lassoId!==undefined||runtime.lasso.pending.size||runtime.pending)throw new Error('MEMORY_SWITCH_PENDING_INPUT');
      const registry=runtime.agentRegistry();
      if(!registry||registry.list().some(r=>r.callerId===id&&ctx.get('agents')?.get(r.sessionId)?.status!=='idle'))throw new Error('MEMORY_BACKGROUND_BUSY');
      const created=await ctx.sessionController.create({workspaceId:await runtime.workspaceId(),agentPreset:'computer-use'});
      target=created.sessionId;
      if(target)await resolveAgent(target);
      if(!target||target===id||!idle(target)||session(target).deriveMessages().length)throw new Error('MEMORY_TARGET_NOT_CLEAN');
      signal.throwIfAborted();
      if(runtime.sessionId!==id||!idle(id)||(!legacyGuardOnly&&await generation(signal)!==snapshot.generation))throw new Error('MEMORY_SESSION_CHANGED');
      const binding=JSON.parse(await readFile(runtime.sessionFile,'utf8'));
      if(binding.sessionId!==id)throw new Error('MEMORY_BINDING_CONFLICT');
      await save({...old,retired:true});
      signal.throwIfAborted();
      await atomicJson(runtime.sessionFile,{sessionId:target});
      // This resets UI history and publishes the new screen owner. Do not copy
      // summaries, tool results, attachments or pending background notifications.
      switching=true;
      try{await runtime.applyMemoryBinding(target);}finally{switching=false;}
      const key=`memory-task-user:${target}`;runtime.lastUserBlockKey=key;
      runtime.block(key,'user',text,false,'set');
      runtime.status('记忆已更新，已切换到新会话继续当前请求。');
    }
    signal.throwIfAborted();
    if(!legacyGuardOnly&&await generation(signal)!==snapshot.generation)throw new Error('MEMORY_SESSION_CHANGED');
    if(snapshot.items.length)await save({sessionId:target,generation:snapshot.generation,retired:false});
    contexts.set(target,snapshot);
    return target;
  }
  const original=runtime.submitPrompt;
  runtime.submitPrompt=function(text,lassoId){
    abort();const own=new AbortController();controller=own;
    const signal=AbortSignal.any([own.signal,AbortSignal.timeout(120000)]);
    const clearStatus=()=>clearPending(own);
    signal.addEventListener('abort',clearStatus,{once:true});
    const pending=queue.then(async()=>{
      try{
        signal.throwIfAborted();if(!legacyGuardOnly)showPending(own);
        await prepare(text,lassoId,signal);signal.throwIfAborted();
        clearPending(own);
        // Binding reset aborts other work but must not cancel this admitted turn.
        return await original.call(runtime,text,lassoId);
      }catch(e){
        if(!own.signal.aborted){
          console.error(`orb-task-memory: preparation failed: ${e.message}`);
          const message=e.message==='MEMORY_BACKGROUND_BUSY'?'后台任务尚未结束，暂时不能切换记忆会话。请结束后重新发送当前任务。'
            :e.message==='MEMORY_SWITCH_PENDING_INPUT'?'记忆已变化，请先结束当前圈选或问答，再重新发送任务。'
            :e.message==='MEMORY_TASK_NOT_IDLE'?'当前会话尚未空闲，本次未提交操作，请稍后重新发送任务。'
            :'记忆任务准备未完成，本次未提交操作。请稍后重新发送任务。';
          runtime.status(message);
        }
      }finally{
        signal.removeEventListener('abort',clearStatus);
        clearPending(own);
        if(controller===own)controller=null;
      }
    });
    queue=pending.catch(()=>{});return pending;
  };
  // UI chat selection cannot interleave the durable binding transaction.
  // Cancel retrieval immediately, then preserve the user's selection in order.
  for(const method of ['newSession','openSession']){
    const prior=runtime[method];
    if(typeof prior!=='function')continue;
    runtime[method]=function(...args){
      abort();const pending=queue.then(()=>prior.apply(runtime,args));
      queue=pending.catch(()=>{});return pending;
    };
    disposers.push(()=>{runtime[method]=prior;});
  }
  const api={ready,abort,allowed,get switching(){return switching;},inspect:()=>({fault:!!fault,exposures:state?.exposures.length??0}),
    async dispose(){closed=true;abort();await queue;await writes;await ready;for(const off of disposers.reverse())off?.();runtime.submitPrompt=original;await ownership?.release();}};
  runtime.memoryTasks=api;
  ctx.provide('orbTaskMemory',api);
  ctx.effect(()=>()=>api.dispose());
  return api;
}
