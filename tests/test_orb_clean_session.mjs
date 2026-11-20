import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCleanSession} from '../plugins/dsh-orb-memory/clean-session.js';
function fixture() {
  const source={id:'old',status:'idle',inbox:{nextTurn:[],nextStep:[]}};
  const state={version:'v2',background:'clear',created:[],disposed:0};
  const handles=new Map([['old',source]]);
  const args={source,newId:'fresh',meta:{cwd:'fixture',agentPreset:'computer-use',parentSessionId:'old'},
    expectedVersion:'v2',readVersion:async()=>state.version,backgroundState:async()=>state.background,
    agents:{get:id=>handles.get(id),async create(input){
      state.created.push(input);
      await state.onCreate?.();
      const agent={id:input.sessionId,status:'idle',inbox:{nextTurn:[],nextStep:[]},
        session:{deriveMessages:()=>state.messages??[]}};
      handles.set(agent.id,agent);
      return {agent,async dispose(){state.disposed++;handles.delete(agent.id);}};
    }}};
  return {args,state,source};
}
test('prepares a blank successor, copies no history or parent and does not bind',async()=>{
  const {args,state}=fixture();const result=await prepareCleanSession(args);
  assert.equal(result.status,'prepared');assert.equal(result.bindingChanged,false);
  assert.deepEqual(state.created[0].meta,{cwd:'fixture',agentPreset:'computer-use'});
  assert.equal('seed' in state.created[0],false);assert.equal(state.disposed,0);
});
test('running/queued source or unknown/running background blocks before creation',async()=>{
  for(const mutation of [f=>f.source.status='running',f=>f.source.inbox.nextTurn.push({}),
    f=>f.source.inbox.nextStep.push({}),f=>f.state.background='unknown',f=>f.state.background='running']){
    const f=fixture();mutation(f);await assert.rejects(prepareCleanSession(f.args));assert.equal(f.state.created.length,0);
  }
});
test('version or source changes during creation dispose only the prepared target',async()=>{
  for(const mutation of [f=>f.state.version='v3',f=>f.source.status='running',f=>f.state.background='running']){
    const f=fixture();f.state.onCreate=()=>mutation(f);
    await assert.rejects(prepareCleanSession(f.args));assert.equal(f.state.disposed,1);
    assert.equal(f.args.agents.get('old'),f.source);
  }
});
test('a prepopulated successor is rejected',async()=>{
  const f=fixture();f.state.messages=[{role:'assistant',content:'old summary'}];
  await assert.rejects(prepareCleanSession(f.args),{code:'TARGET_NOT_CLEAN'});assert.equal(f.state.disposed,1);
});
test('cancellation after creation cleans up the unused successor',async()=>{
  const f=fixture(),controller=new AbortController();f.args.signal=controller.signal;
  f.state.onCreate=()=>controller.abort();await assert.rejects(prepareCleanSession(f.args));assert.equal(f.state.disposed,1);
});
test('concurrent preparation for the same source is rejected',async()=>{
  const f=fixture();let release;f.state.onCreate=()=>new Promise(resolve=>release=resolve);
  const first=prepareCleanSession(f.args);
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(prepareCleanSession(f.args),{code:'CLEAN_SESSION_CONFLICT'});
  release();await first;assert.equal(f.state.created.length,1);
});
