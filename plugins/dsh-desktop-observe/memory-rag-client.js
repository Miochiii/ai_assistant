import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const failure = code => Object.assign(new Error(code),{code});

/** One lazy CPU worker per Host. Serialized requests, no socket or result cache. */
export class MemoryRagClient {
  constructor({root,spawnProcess=spawn,idleMs=300000,timeoutMs=80000,workerScript='memory_rag_worker.py',argumentsFor=()=>['--serve']}) {
    Object.assign(this,{root,spawnProcess,idleMs,timeoutMs,workerScript,argumentsFor});
    this.queue=Promise.resolve();this.proc=null;this.closed=false;
  }
  _stop(state=this.proc,error=failure('RAG_STOPPED')) {
    if (!state) return;
    if(this.proc===state){this.proc=null;clearTimeout(this.idle);}
    const active=state.active;state.active=null;
    try{state.child.kill();}catch{}
    active?.reject(error);
  }
  dispose(){this.closed=true;this._stop();}
  _process(config) {
    const profile=JSON.stringify(config);
    if(this.proc?.profile!==profile)this._stop();
    if(this.proc)return this.proc;
    const child=this.spawnProcess(config.python,['-B',join(this.root,'scripts',this.workerScript),...this.argumentsFor(config)],
      {cwd:this.root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const state={child,profile,buffer:'',active:null};this.proc=state;
    child.stdout.setEncoding('utf8');child.stderr.resume();
    child.stdout.on('data',chunk=>{
      state.buffer+=chunk;
      if(state.buffer.length>2_000_000){this._stop(state,failure('RAG_OUTPUT_LIMIT'));return;}
      let end;
      while((end=state.buffer.indexOf('\n'))>=0){
        const line=state.buffer.slice(0,end);state.buffer=state.buffer.slice(end+1);
        try{
          const value=JSON.parse(line),active=state.active;
          if(!active || value.request_id!==active.id)throw failure('RAG_RESPONSE_MISMATCH');
          state.active=null;active.resolve(value);
        }catch{this._stop(state,failure('RAG_BAD_RESPONSE'));return;}
      }
    });
    child.once('error',()=>this._stop(state,failure('RAG_PROCESS_ERROR')));
    child.once('close',()=>this._stop(state,failure('RAG_PROCESS_EXIT')));
    child.stdin.on('error',()=>this._stop(state,failure('RAG_PIPE_ERROR')));
    return state;
  }
  request(config,request,signal) {
    const started=performance.now();
    const deadline=AbortSignal.any([AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])]);
    const operation=this.queue.then(async()=>{
      deadline.throwIfAborted();
      if(this.closed)throw failure('RAG_DISPOSED');
      const queued=performance.now()-started;
      const id=randomUUID();
      const line=JSON.stringify({request_id:id,request})+'\n';
      if(Buffer.byteLength(line)>2_000_000)throw failure('RAG_INPUT_LIMIT');
      clearTimeout(this.idle);
      const state=this._process(config);
      try{
        const result=await new Promise((resolve,reject)=>{
          const abort=()=>this._stop(state,failure('RAG_CANCELLED'));
          const finish=fn=>value=>{deadline.removeEventListener('abort',abort);fn(value);};
          state.active={id,resolve:finish(resolve),reject:finish(reject)};
          deadline.addEventListener('abort',abort,{once:true});
          state.child.stdin.write(line,'utf8');
        });
        return {...result,timing:{...result.timing,queue_ms:Math.round(queued),roundtrip_ms:Math.round(performance.now()-started)}};
      }finally{
        if(this.proc===state){this.idle=setTimeout(()=>this._stop(state),this.idleMs);this.idle.unref?.();}
      }
    });
    this.queue=operation.catch(()=>{});
    // A cancelled queued caller returns immediately without killing another request.
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(failure('RAG_CANCELLED'));
      if(deadline.aborted){operation.catch(()=>{});abort();return;}
      deadline.addEventListener('abort',abort,{once:true});
      operation.then(resolve,reject).finally(()=>deadline.removeEventListener('abort',abort));
    });
  }
}

export async function residentRecall({call,worker,config,root,where,args,signal}) {
  const start=performance.now(),timing={};
  const core=(op,payload)=>call({root,...where,op,args:payload,signal,timeoutMs:15000});
  const snapshot=await core('rag_snapshot',{query:args.query});
  timing.snapshot_ms=Math.round(performance.now()-start);
  if(!snapshot.items?.length)return {...snapshot,timing};
  let ids=[],fallback=false;
  try{
    const response=await worker.request(config,{scope:snapshot.scope,query:args.query,items:snapshot.items},signal);
    if(!response.ok || !Array.isArray(response.ids))throw failure('RAG_RETRIEVAL_FAILED');
    ids=response.ids;Object.assign(timing,response.timing);
  }catch(error){
    signal?.throwIfAborted();fallback=true;
    timing.fallback=true; // no subprocess stderr, request text or memory body in metrics
  }
  const resolveStart=performance.now();
  const result=await core('rag_resolve',{scope:snapshot.scope,version:snapshot.version,query:args.query,ids,fallback});
  timing.resolve_ms=Math.round(performance.now()-resolveStart);timing.total_ms=Math.round(performance.now()-start);
  return {...result,timing};
}
