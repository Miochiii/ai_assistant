import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MemoryCutoverService} from '../plugins/dsh-orb-memory/cutover-service.js';
import {atomicJson,cutoverStore} from '../plugins/dsh-orb-memory/cutover-store.js';
const tmp=fileURLToPath(new URL('../tmp/',import.meta.url));
async function fixture(t){
  const dir=await mkdtemp(join(tmp,'orb-cutover-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'state.json'),binding=join(dir,'binding.json');
  await atomicJson(binding,{sessionId:'old'});
  const base=cutoverStore(path),flags={ui:'old',fail:null,writes:0};
  const driver={inspect:()=>({sessionId:flags.ui}),async checkInitial(){},async checkPrepared(){},async validateRecovery(){},
    async readBinding(){return JSON.parse(await readFile(binding,'utf8')).sessionId;},
    async writeBinding(id){if(flags.fail==='binding')throw new Error('disk');await atomicJson(binding,{sessionId:id});},
    async applyBinding(id){if(flags.fail==='ui')throw new Error('ui');flags.ui=id;},};
  const store={read:()=>base.read(),async write(s){flags.writes++;if(flags.fail==='final'&&!s.pending&&s.revision===1)throw new Error('disk');await base.write(s);}};
  const service=new MemoryCutoverService({store,driver});
  await service.initialize({sessionId:'old',generation:'v1'});
  const prepared={status:'prepared',bindingChanged:false,previousSessionId:'old',sessionId:'new',memoryVersion:'v2'};
  return {dir,path,binding,flags,service,prepared,driver,store};
}
test('durable cutover retires old before binding and reload keeps the gate',async t=>{
  const f=await fixture(t);
  const write=f.driver.writeBinding;
  f.driver.writeBinding=async id=>{assert.equal(f.service.permits('old'),false);assert((await f.store.read()).retired.includes('old'));await write(id);};
  assert.equal((await f.service.commitMemoryCutover(f.prepared,0)).status,'committed');
  const restored=new MemoryCutoverService(f);await restored.recover();
  assert.equal(restored.permits('old'),false);assert.equal(restored.permits('new'),true);
});
for(const phase of ['binding','ui','final'])test(`failure at ${phase} stays blocked and recovers the same target`,async t=>{
  const f=await fixture(t);f.flags.fail=phase;
  await assert.rejects(f.service.commitMemoryCutover(f.prepared,0));
  assert.equal(f.service.permits('old'),false);assert.equal(f.service.permits('new'),false);
  f.flags.fail=null;const restored=new MemoryCutoverService(f);
  assert.equal((await restored.recover()).sessionId,'new');
  assert.equal(restored.state.revision,1);assert.equal((await restored.recover()).status,'ready');
});
test('conflicting binding is never overwritten during recovery',async t=>{
  const f=await fixture(t);f.flags.fail='binding';await assert.rejects(f.service.commitMemoryCutover(f.prepared,0));
  f.flags.fail=null;await atomicJson(f.binding,{sessionId:'user-selected-other'});
  await assert.rejects(new MemoryCutoverService(f).recover(),/BINDING_CONFLICT/);
  assert.equal(await f.driver.readBinding(),'user-selected-other');
});
test('missing/corrupt state fails closed; enrollment never replaces corrupt data',async t=>{
  const f=await fixture(t);await writeFile(f.path,'{broken');
  const restored=new MemoryCutoverService(f);await assert.rejects(restored.recover());
  assert.equal(restored.permits('new'),false);
  await assert.rejects(restored.initialize({sessionId:'new',generation:'v2'}));
  await rm(f.path);await assert.rejects(restored.load());assert.equal(restored.permits('new'),false);
});
test('busy admission / stale revision creates no pending state',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.commitMemoryCutover(f.prepared,99),/CUTOVER_CONFLICT/);
  f.driver.checkPrepared=async()=>{throw new Error('ORB_NOT_IDLE');};
  await assert.rejects(f.service.commitMemoryCutover(f.prepared,0),/ORB_NOT_IDLE/);
  assert.equal((await f.store.read()).pending,null);assert.equal(await f.driver.readBinding(),'old');
});
