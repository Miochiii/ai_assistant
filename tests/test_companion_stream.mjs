import test from 'node:test';
import assert from 'node:assert/strict';
import { companionStream } from '../plugins/dsh-assistant-host/companion-stream.js';

function fixture(reason = 'stop', extra = []) {
  let request;
  const ctx = {llm:{async *stream(value) {
    request=value;
    yield {type:'text-delta',index:0,text:'测试回复'};
    for (const chunk of extra) yield chunk;
    if (reason !== null) yield {type:'finish',reason:{kind:reason}};
  }}};
  return {run:()=>companionStream(ctx,{system:'test',content:[{type:'text',text:'test'}],signal:new AbortController().signal}),request:()=>request};
}

test('30 字上限用的 192 token 必须能通过校验（.24 的回归）', async () => {
  const ctx = {llm: {stream() { throw new Error('reached-llm'); }}};
  await assert.rejects(
    () => companionStream(ctx, {system: 's', content: [{type: 'text', text: 'x'}], maxTokens: 192}),
    /reached-llm/,
  );
});

test('companion request has bounded output with thinking and tools disabled',async()=>{
  const f=fixture(); assert.equal(await f.run(),'测试回复');
  assert.equal(f.request().maxTokens,2048);
  assert.equal(f.request().reasoningEffort,'off');
  assert.deepEqual(f.request().tools,[]);
});

test('truncation and tool requests give distinct actionable errors, never partial success',async()=>{
  await assert.rejects(fixture('max-tokens').run(),e=>e.code==='COMPANION_MAX_TOKENS' && e.details.finishReason==='max-tokens');
  await assert.rejects(fixture('tool-calls').run(),e=>e.code==='COMPANION_TOOL_CALL' && /交给主会话/.test(e.message));
  await assert.rejects(fixture('stop',[{type:'block-start',index:1,blockType:'tool-call'}]).run(),e=>e.code==='COMPANION_TOOL_CALL');
  await assert.rejects(fixture('other').run(),e=>e.code==='COMPANION_FINISH');
  await assert.rejects(fixture(null).run(),e=>e.code==='COMPANION_INCOMPLETE');
});

test('stream timing distinguishes first text and completion without recording content',async()=>{
  const timing={};
  const ctx={llm:{async *stream(){
    yield {type:'text-delta',index:0,text:'private reply'};
    await new Promise(resolve=>setTimeout(resolve,20));
    yield {type:'finish',reason:{kind:'stop'}};
  }}};
  assert.equal(await companionStream(ctx,{system:'test',content:[],signal:new AbortController().signal,timing}),'private reply');
  assert.ok(timing.first_text_ms>=0);assert.ok(timing.model_total_ms>timing.first_text_ms);
  assert.doesNotMatch(JSON.stringify(timing),/private reply/);
});
