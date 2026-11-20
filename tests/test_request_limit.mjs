import test from 'node:test';
import assert from 'node:assert/strict';
import {installRequestLimit} from '../plugins/dsh-desktop-observe/request-limit.js';
function fixture() {
  let listener, calls=0;
  const limit=installRequestLimit({on:(event,fn)=>{assert.equal(event,'llm/stream');listener=fn;return ()=>{};}},
    {sessionId:'limited',provider:'fixture',model:'image',maxRequests:2,maxOutputTokens:1024,maxRequestBytes:1000});
  const base={sessionId:'limited',provider:'fixture',model:'image',maxTokens:100,messages:[]};
  return {limit,calls:()=>calls,async run(change={},fail=false){
    const stream=listener({...base,...change},async function*(){calls++;if(fail)throw Error('transport failed');yield {type:'finish'};});
    for await(const _ of stream){}
  }};
}
test('failed attempts and title requests consume the same session quota',async()=>{
  const f=fixture();await assert.rejects(f.run({},true),/transport/);
  await f.run({purpose:'session-title'});await assert.rejects(f.run(),/SESSION_REQUEST_LIMIT/);
  assert.equal(f.calls(),2);assert.equal(f.limit.snapshot().requests,2);
});
test('route, output, size, cancellation rejected before adapter dispatch',async()=>{
  for(const change of [{provider:'other'},{model:'other'},{maxTokens:1025},{messages:['x'.repeat(1001)]},
    {signal:AbortSignal.abort()}]){
    const f=fixture();await assert.rejects(f.run(change));assert.equal(f.calls(),0);
  }
});
test('other sessions remain unaffected and concurrent calls cannot exceed quota',async()=>{
  const f=fixture();await f.run({sessionId:'other',maxTokens:5000});assert.equal(f.limit.snapshot().requests,0);
  const results=await Promise.allSettled(Array.from({length:6},()=>f.run()));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,2);assert.equal(f.calls(),3);
});
