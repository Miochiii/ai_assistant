import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apply} from '../third_party/dsh-memory-evolve/lib/index.js';
import {MemoryStore,SuggestionQueue,ArchiveStore} from '../third_party/dsh-memory-evolve/lib/store.js';
import {reviewCommand} from '../third_party/dsh-memory-evolve/lib/review.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(join(root,'configs/evolve-integration.json'),'utf8'));
const dir=await mkdtemp(join(root,'tmp/evolve-integration-'));
const effects=[],tools=[],contexts=[],commands=[],routes=[];
const services={tools:{register:def=>{tools.push(def);return ()=>{};},get:()=>undefined},
  systemPrompt:{context:def=>{contexts.push(def);return ()=>{};}},
  commands:{register:def=>{commands.push(def);return ()=>{};}},
  webServer:{register:route=>{routes.push(route);return ()=>{};}},
  settings:{describe:ns=>ns==='locale'?{value:{preference:'zh'}}:undefined}};
const ctx={...services,get:key=>services[key],on:()=>()=>{},logger:{warn(){},info(){},error(){}},
  effect:fn=>{const d=fn();if(typeof d==='function')effects.push(d);return d??(()=>{});},
  inject:(deps,cb)=>({dispose:deps.every(d=>services[d])?cb(ctx):()=>{}})};
try{
  apply(ctx,{...config,memoryDir:dir,skillDir:join(dir,'skills')});
  const memory=tools.find(t=>t.name==='memory');assert(memory);
  assert(!tools.some(t=>['dtodo','de_coi','de_channel_send'].includes(t.name)));
  const exec={agent:{id:'test',session:{header:{cwd:root}}},callId:'synthetic',signal:new AbortController().signal};
  assert((await memory.execute({action:'add',target:'key',content:'PyCharm 位于 program 第一行第二列。'},exec)).ok);
  const review=reviewCommand({},new MemoryStore(dir),null,new ArchiveStore(dir),new SuggestionQueue(join(dir,'SUGGESTIONS.jsonl')));
  assert(review.handler({rawInput:'list',agent:exec.agent}).text.includes('PyCharm'));
  assert.equal(review.handler({rawInput:'approve 1',agent:exec.agent}).kind,'success');
  assert(JSON.stringify(await memory.execute({action:'list',target:'key'},exec)).includes('PyCharm'));
  assert((await memory.execute({action:'replace',target:'key',match:'第一行第二列',content:'PyCharm 位于 program 第二行第一列。'},exec)).ok);
  const updated=JSON.stringify(await memory.execute({action:'list',target:'key'},exec));
  assert(updated.includes('第二行第一列')&&!updated.includes('第一行第二列'));
  assert((await memory.execute({action:'remove',target:'key',match:'第二行第一列'},exec)).ok);
  assert(!JSON.stringify(await memory.execute({action:'list',target:'key'},exec)).includes('PyCharm'));
  assert(contexts.some(c=>c.name==='memory:snapshot'));assert(routes.length);
  const report={passed:true,real_plugin:true,simulated_host:true,live_app:false,paid_requests:0,
    registered_tools:tools.map(t=>t.name),memory_write_read_update_delete:true,routes:routes.length,
    per_turn_logs:false,external_dispatch:false};
  await writeFile(join(root,'results/memory/evolve-integration.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{for(const d of effects.reverse())await d();await rm(dir,{recursive:true,force:true});}
