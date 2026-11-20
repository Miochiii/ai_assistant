import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {MemoryRagClient,residentRecall} from '../plugins/dsh-desktop-observe/memory-rag-client.js';

function fixture(options={}) {
  const children=[];
  const worker=new MemoryRagClient({root:process.cwd(),timeoutMs:2000,idleMs:1000,...options,
    spawnProcess(){
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.requests=[];child.killed=false;
      child.stdin=new Writable({write(data,encoding,done){child.requests.push(JSON.parse(data));done();}});
      child.kill=()=>{child.killed=true;};
      child.reply=(extra={})=>child.stdout.write(JSON.stringify({request_id:child.requests.at(-1).request_id,ok:true,ids:['m'],...extra})+'\n');
      children.push(child);return child;
    }});
  return {worker,children};
}
const config={python:'fake'};
const tick=()=>delay(0);

test('one process serializes scopes and reuses loaded worker',async()=>{
  const {worker,children}=fixture();
  try {
    const a=worker.request(config,{scope:'a'}),b=worker.request(config,{scope:'b'});
    await tick();assert.equal(children.length,1);assert.equal(children[0].requests.length,1);
    children[0].reply();assert.deepEqual((await a).ids,['m']);await tick();
    assert.equal(children.length,1);assert.equal(children[0].requests[1].request.scope,'b');
    children[0].reply();assert.equal((await b).ok,true);
  }finally{worker.dispose();}
});

test('queued abort does not kill active request; active abort restarts worker',async()=>{
  const {worker,children}=fixture();
  try {
    const active=new AbortController(),queued=new AbortController();
    const a=worker.request(config,{},active.signal);const ar=assert.rejects(a);
    const b=worker.request(config,{},queued.signal);const br=assert.rejects(b);
    await tick();queued.abort();await br;assert.equal(children[0].killed,false);
    active.abort();await ar;assert.equal(children[0].killed,true);
    const c=worker.request(config,{});await tick();assert.equal(children.length,2);
    children[0].emit('close',1);assert.equal(children[1].killed,false);
    children[1].reply();await c;
  }finally{worker.dispose();}
});

test('bad response, worker exit and timeout fail and allow recovery',async()=>{
  for(const fault of ['mismatch','exit','timeout']) {
    const {worker,children}=fixture({timeoutMs:fault==='timeout'?40:2000});
    try {
      const result=worker.request(config,{});const rejected=assert.rejects(result);
      await tick();
      if(fault==='mismatch')children[0].reply({request_id:'foreign'});
      if(fault==='exit')children[0].emit('close',1);
      if(fault==='timeout')await delay(60);
      await rejected;assert.equal(children[0].killed,true);
      const next=worker.request(config,{});await tick();children[1].reply();await next;
    }finally{worker.dispose();}
  }
});

test('profile change and idle release processes; disposed host cannot restart',async()=>{
  const {worker,children}=fixture({idleMs:20});
  let p=worker.request(config,{});await tick();children[0].reply();await p;
  p=worker.request({...config,device:'cpu'},{});await tick();
  assert.equal(children[0].killed,true);children[1].reply();await p;
  await delay(40);assert.equal(children[1].killed,true);
  worker.dispose();await assert.rejects(worker.request(config,{}));
});

test('pre-aborted and oversized requests never start a worker',async()=>{
  const {worker,children}=fixture();
  try {
    await assert.rejects(worker.request(config,{},AbortSignal.abort()));
    await assert.rejects(worker.request(config,{text:'a'.repeat(2_000_000)}));
    await tick();assert.equal(children.length,0);
  }finally{worker.dispose();}
});

test('resident pipeline revalidates snapshot and never returns worker text',async()=>{
  const calls=[];
  const result=await residentRecall({root:'.',where:{user:'u',project:'p'},config,args:{query:'editor'},
    worker:{request:async()=>({ok:true,ids:['m'],text:'not trusted'})},
    call:async request=>{calls.push(request);return request.op==='rag_snapshot'
      ?{items:[{memory_id:'m',text:'PyCharm'}],scope:'scope',version:'v1'}
      :{items:[],version:'v2',engine:'revision_changed'};}});
  assert.deepEqual(calls.map(c=>c.op),['rag_snapshot','rag_resolve']);
  assert.equal(calls[1].args.version,'v1');assert.equal(calls[1].args.scope,'scope');
  assert.deepEqual(result.items,[]);assert.equal(result.text,undefined);
});

test('worker failure requests literal resolution without another heavy process',async()=>{
  const calls=[];
  const result=await residentRecall({root:'.',where:{},config,args:{query:'editor'},
    worker:{request:async()=>{throw Error('private diagnostic');}},
    call:async request=>{calls.push(request);return request.op==='rag_snapshot'
      ?{items:[{memory_id:'m',text:'PyCharm'}],scope:'s',version:'v'}
      :{items:[],engine:'literal_fallback'};}});
  assert.equal(calls[1].args.fallback,true);assert.equal(result.timing.fallback,true);
  assert.doesNotMatch(JSON.stringify(result),/private diagnostic/);
});
