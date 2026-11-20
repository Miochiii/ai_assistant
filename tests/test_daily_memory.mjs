import assert from 'node:assert/strict';
import test from 'node:test';
import {DailyMemory} from '../plugins/dsh-assistant-host/daily-memory.js';
import {PanelChatModel} from '../plugins/dsh-assistant-host/panel-model.js';
test('daily worker calls extraction then commit, with no parent agent or tools',async()=>{
  const ops=[];let request;
  const memory={async v2(_s,op,args){ops.push(op);if(op==='daily_pending')return {events:[{event_id:'e',content:'回答请简短'}],batch_id:'b'};assert.equal(args.candidates[0].source_event_id,'e');return {automatic:1};}};
  const ctx={llm:{async *stream(req){request=req;yield {type:'text-delta',index:0,text:'[{"source_event_id":"e","quote":"回答请简短","key":"communication.style"}]'};yield {type:'finish',reason:{kind:'stop'}};}}};
  const worker=new DailyMemory({memory,ctx,session:{header:{cwd:'fixture'}}});
  await worker.tick();await worker.tick();
  assert.deepEqual(ops,['daily_pending','daily_commit']);assert.deepEqual(request.tools,[]);assert.equal(worker.last.automatic,1);
});
test('revoked memory version clears dependent assistant history',async()=>{
  let version='v1', request;
  const memory={async v2(_s,op){if(op==='rag_version')return {version};if(op==='rag_recall')return {version,items:version==='v1'?[{content:'旧记忆'}]:[]};}};
  const ctx={llm:{async *stream(req){request=req;yield {type:'text-delta',index:0,text:'旧记忆的回复'};yield {type:'finish',reason:{kind:'stop'}};}}};
  const model=new PanelChatModel({memory,ctx,sessionId:'test'});
  await model.complete({text:'你好'});assert.match(JSON.stringify(request),/旧记忆/);
  version='v2';await model.complete({text:'继续聊'});
  assert.doesNotMatch(JSON.stringify(request),/旧记忆/);
});

test('revocation during inference prevents displaying and retaining its reply',async()=>{
  let version='v1';
  const memory={async v2(_s,op){if(op==='rag_version')return {version};if(op==='rag_recall')return {version,items:[{content:'旧记忆'}]};}};
  const ctx={llm:{async *stream(){version='v2';yield {type:'text-delta',index:0,text:'不应展示'};yield {type:'finish',reason:{kind:'stop'}};}}};
  const model=new PanelChatModel({memory,ctx,sessionId:'test'});
  await assert.rejects(model.complete({text:'你好'}),{code:'MEMORY_CONTEXT_CHANGED'});
  assert.deepEqual(model.history,[]);
});
