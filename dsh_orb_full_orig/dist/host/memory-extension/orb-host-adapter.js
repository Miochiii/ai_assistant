// Development-only seam, called inside Orb's apply while it owns runtime.
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {atomicJson,cutoverStore} from './cutover-store.js';
import {MemoryCutoverService} from './cutover-service.js';
import {acquireOrbCutoverLocks} from './process-lock.js';

export function installOrbMemoryCutover(ctx,runtime,config) {
  if(!config?.stateFile)throw new Error('CUTOVER_STATE_PATH_REQUIRED');
  const canonical=p=>{try{return realpathSync.native(p).toLowerCase();}catch{return null;}};
  const workspace=canonical(runtime.store.workspaceDirectory());
  if(!workspace)throw new Error('CUTOVER_WORKSPACE_UNAVAILABLE');
  const generation=async(signal)=>{
    const value=await ctx.get('orbMemoryGeneration')?.current(signal);
    if(typeof value!=='string'||!value)throw new Error('MEMORY_GENERATION_UNAVAILABLE');
    return value;
  };
  let admissions=0;
  function idle(id){
    const agent=ctx.get('agents')?.get(id);
    return agent?.status==='idle'&&agent.inbox.nextTurn.length===0&&agent.inbox.nextStep.length===0;
  }
  function checkIdle(){
    if(admissions||runtime.turnRunning||runtime.pendingPrompt||runtime.pending||runtime.creating
      ||runtime.store.lassoEnabled()||runtime.lasso.pending.size||runtime.translation
      ||!idle(runtime.sessionId))throw new Error('ORB_NOT_IDLE');
    const registry=runtime.agentRegistry();
    if(!registry||typeof registry.list!=='function')throw new Error('BACKGROUND_UNKNOWN');
    // Completed records may still have undelivered notifications. Conservatively
    // defer any caller with records until a future delivery-ack API exists.
    if(registry.list().some(row=>row.callerId===runtime.sessionId))throw new Error('BACKGROUND_NOT_CLEAR');
  }
  async function target(id){
    let agent=ctx.get('agents')?.get(id);
    if(!agent){
      const resolved=await ctx.sessionController.resolveAgent(id);
      if(resolved?.error)throw new Error('TARGET_UNAVAILABLE');
      agent=ctx.get('agents')?.get(id);
    }
    if(!agent||agent.session.header.agentPreset!=='computer-use'
      ||canonical(agent.session.header.cwd)!==workspace||!idle(id)
      ||agent.session.deriveMessages().length!==0)throw new Error('TARGET_NOT_CLEAN');
    return agent;
  }
  const service=new MemoryCutoverService({store:cutoverStore(config.stateFile),driver:{
    inspect:()=>({sessionId:runtime.sessionId,workspace,admissions,turnRunning:!!runtime.turnRunning,
      pendingPrompt:!!runtime.pendingPrompt,pendingQuestion:!!runtime.pending}),
    async checkInitial(id){checkIdle();if(id!==runtime.sessionId)throw new Error('BINDING_CONFLICT');await target(id);},
    async checkPrepared(p,s){
      checkIdle();if(runtime.sessionId!==s.current||await generation()!==p.memoryVersion)throw new Error('CUTOVER_CONFLICT');
      await target(p.sessionId);
    },
    async validateRecovery(p){
      if(admissions||runtime.turnRunning||runtime.pendingPrompt||runtime.pending)throw new Error('ORB_NOT_IDLE');
      const old=ctx.get('agents')?.get(p.from);
      if(old&&!idle(p.from))throw new Error('SOURCE_NOT_IDLE');
      if(await generation()!==p.generation)throw new Error('MEMORY_VERSION_CHANGED');
      await target(p.to);
    },
    async readBinding(){return JSON.parse(await readFile(runtime.sessionFile,'utf8')).sessionId;},
    writeBinding:id=>atomicJson(runtime.sessionFile,{sessionId:id}),
    async applyBinding(id){
      // The generated seam implements this inside Orb's lexical scope, including
      // its private screen-owner publisher. Never call swallow-errors remember().
      await runtime.applyMemoryBinding(id);
    },
  }});
  // Persisted state is loaded before any managed request may pass. The caller
  // explicitly enrolls a blank session if this is a first-time installation.
  let ownership;
  const loaded=(async()=>{
    ownership=await acquireOrbCutoverLocks(config.stateFile,runtime.sessionFile);
    await service.load();
  })().catch(error=>{service.fault=ownership?'STATE_UNAVAILABLE':'BINDING_LOCK_UNAVAILABLE';});
  service.ready=loaded;
  // Public mutators cannot bypass ownership if startup could not obtain it.
  for(const method of ['load','initialize','recover','commitMemoryCutover']){
    const original=service[method].bind(service);
    service[method]=async(...args)=>{
      if(!ownership)throw new Error('BINDING_LOCK_UNAVAILABLE');
      return original(...args);
    };
  }
  async function allowed(id,signal){
    await loaded;
    if(!service.permits(id))return false;
    if(service.state.current===id){
      try{return await generation(signal)===service.state.generation;}catch{return false;}
    }
    return true;
  }
  const disposers=[];
  disposers.push(ctx.on('agent/pre-step',async(options,next)=>{
    const agent=options.agent;
    if(agent?.session.header.agentPreset!=='computer-use'||canonical(agent.session.header.cwd)!==workspace)return next();
    return await allowed(agent.id,options.signal)?next():{kind:'reject'};
  }));
  // Also check the window between pre-step and the actual provider request.
  disposers.push(ctx.on('llm/stream',(options,next)=>{
    const agent=ctx.get('agents')?.get(options.sessionId);
    if(agent?.session.header.agentPreset!=='computer-use'||canonical(agent.session.header.cwd)!==workspace)return next();
    return (async function*(){
      if(!await allowed(agent.id,options.signal))throw new Error('MEMORY_SESSION_BLOCKED');
      for await(const chunk of next()){
        if(!await allowed(agent.id,options.signal))throw new Error('MEMORY_SESSION_CHANGED');
        yield chunk;
      }
    })();
  }));
  // Preserve FIFO ordering of UI requests. Busy/failed recovery is explicit,
  // and no action is automatically retried or forwarded twice.
  let queue=Promise.resolve();
  for(const method of ['preempt','newSession','openSession']){
    const original=runtime[method];
    runtime[method]=function(...args){
      const run=queue.then(async()=>{
        await loaded;
        if(service.locked||service.state?.pending||(service.fault&&method!=='newSession'))throw new Error('MEMORY_CUTOVER_PENDING');
        if(method==='openSession'&&service.state.retired.includes(args[0]))throw new Error('MEMORY_SESSION_RETIRED');
        admissions++;
        try{return await original.apply(this,args);}finally{admissions--;}
      });
      queue=run.catch(()=>{});return run;
    };
    disposers.push(()=>{runtime[method]=original;});
  }
  ctx.provide('orbMemoryCutover',service);
  ctx.effect(()=>async()=>{
    await loaded;
    service.fault='DISPOSED';
    for(const dispose of disposers.reverse())dispose?.();
    const lock=ownership;ownership=null;await lock?.release();
  });
  return service;
}
