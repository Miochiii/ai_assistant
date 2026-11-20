import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isMemoryQuestion,answerMemoryQuestion} from '../plugins/dsh-orb-memory/recall-answer.js';
import {createOrbMemoryService} from '../plugins/dsh-orb-memory/service.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const workspace=fileURLToPath(new URL('../dsh_orb_work',import.meta.url));
const session={id:'orb',header:{cwd:workspace,agentPreset:'computer-use'}};
function fixture(options={}){
  const state={generation:'a'.repeat(64),enabled:true,consent_revision:1};
  const calls=[],requests=[];
  const memory={async v2(s,op,args){
    calls.push({s,op,args});
    if(op==='memory_generation'){await options.onGeneration?.(state);return {...state};}
    if(op==='rag_recall'){await options.onRecall?.(state);return {items:options.items??[{memory_id:'editor',content:'我习惯使用 PyCharm 写 Python 进行开发'}]};}
    if(op==='daily_configure'){state.enabled=args.enabled;state.generation='b'.repeat(64);state.consent_revision++;return {...state};}
    throw new Error(op);
  }};
  const ctx={llm:{async *stream(request){
    requests.push(request);await options.onModel?.(state,request);
    yield {type:'text-delta',index:0,text:options.output??JSON.stringify({supported:true,answer:'你习惯用 PyCharm 写 Python。'})};
    yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const service=createOrbMemoryService({root,workspace,memory,ctx,sessionForId:id=>id==='orb'?session:null,isBusy:()=>false});
  const answer=()=>answerMemoryQuestion({memory,session,ctx,text:'我用什么写 Python',signal:new AbortController().signal});
  return {state,calls,requests,service,answer};
}
test('personal recall routing preserves action requests and advice',()=>{
  for(const text of ['我用什么写 Python','你还记得我喜欢哪个编辑器吗？','我习惯用什么开发工具？','还记得我的编辑器吗'])assert(isMemoryQuestion(text),text);
  for(const text of ['帮我打开 PyCharm','我用什么写 Python，帮我打开它','我该选什么编辑器？','我为什么运行不了 Python','你推荐什么编辑器','我用什么编辑器；然后安装它','正常聊天'])assert(!isMemoryQuestion(text),text);
});
test('recall answers use only retrieved facts in a fresh tool-free request',async()=>{
  const f=fixture();
  try{
    assert.match(await f.service.answerRecall('我用什么写 Python','orb'),/PyCharm/);
    const request=f.requests[0];assert.equal(f.requests.length,1);
    assert.deepEqual(request.tools,[]);assert.equal(request.messages.length,1);assert.notEqual(request.sessionId,session.id);
    assert.equal(request.provider,'deepseek-official');assert.equal(request.model,'deepseek-flash');
    const payload=JSON.parse(request.messages[0].content[0].text);
    assert.equal(payload.execution_authority,false);assert.equal(payload.memory_context[0].memory_id,'editor');
    assert.equal(f.calls[0].s.header.cwd,root);assert.equal(f.calls.filter(c=>c.op==='memory_generation').length,3);
    await f.service.answerRecall('我用什么写 Python','orb');assert.notEqual(f.requests[1].sessionId,request.sessionId);
  }finally{await f.service.dispose();}
});
test('disabled, empty, and foreign workspace requests never send memory to model',async()=>{
  const f=fixture({items:[]});
  try{
    assert.match(await f.service.answerRecall('我用什么写 Python','orb'),/没有查到/);
    f.state.enabled=false;assert.equal(await f.service.answerRecall('我用什么写 Python','orb'),null);
    assert.equal(await f.service.answerRecall('我用什么写 Python','foreign'),null);assert.equal(f.requests.length,0);
  }finally{await f.service.dispose();}
});
test('revocation during retrieval or model completion discards obsolete answers',async()=>{
  for(const hook of ['onRecall','onModel']){
    const f=fixture({[hook]:state=>{state.generation='b'.repeat(64);}});
    try{assert.match(await f.service.answerRecall('我用什么写 Python','orb'),/旧结果未显示/);assert.equal(f.requests.length,hook==='onRecall'?0:1);}
    finally{await f.service.dispose();}
  }
});
test('malformed generation fails closed and unsupported answers do not guess',async()=>{
  const f=fixture({onGeneration:state=>{state.generation=undefined;}});
  try{await assert.rejects(f.answer(),/GENERATION_UNAVAILABLE/);assert.equal(f.requests.length,0);}finally{await f.service.dispose();}
  for(const output of ['null','plain invented answer','{"supported":false}']){
    const f=fixture({output});
    try{if(output.includes('false'))assert.match(await f.answer(),/不足以确认/);else await assert.rejects(f.answer(),/ANSWER_INVALID/);}
    finally{await f.service.dispose();}
  }
});
test('new input and disabling memory cancel in-flight recall',async()=>{
  for(const action of ['abort','disable']){
    let ready,release;const entered=new Promise(r=>ready=r),blocked=new Promise(r=>release=r);
    const f=fixture({onModel:async()=>{ready();await blocked;}});
    try{
      const answer=f.service.answerRecall('我用什么写 Python','orb');await entered;
      if(action==='abort')f.service.abortRecall();else await f.service.control('关闭自动记忆','orb');
      release();assert.equal(await answer,'');
    }finally{release();await f.service.dispose();}
  }
});
test('installed UI method routes recall, preserves actions, and suppresses stale session replies',async()=>{
  const code=await readFile(new URL('../dsh_orb_full_orig/dist/host/index.js',import.meta.url),'utf8');
  const start=code.indexOf('\tasync onPrompt(text, lassoId) {'),end=code.indexOf('\n\t/** Start one new turn',start);
  assert(start>=0&&end>start);
  const onPrompt=new Function('randomUUID',`return (${code.slice(start,end).trim().replace(/^async onPrompt/,'async function')});`)(randomUUID);
  const shown=[],native=[];const f=fixture();
  const ui={ctx:{get:()=>f.service},sessionId:'orb',transcriptEpoch:1,turnRunning:false,
    block:(id,role,text)=>shown.push({id,role,text}),ensureSession:async()=>ui.sessionId,preempt:async text=>native.push(text)};
  try{
    await onPrompt.call(ui,'我用什么写 Python');assert.match(shown.at(-1).text,/PyCharm/);assert.equal(native.length,0);
    assert(shown.some(b=>b.text.includes('正在查询有效记忆')));
    await onPrompt.call(ui,'帮我打开 PyCharm');assert.equal(native.length,1);
    await onPrompt.call(ui,'我用什么写 Python','lasso');assert.equal(native.length,2);
    f.state.enabled=false;await onPrompt.call(ui,'我用什么写 Python');assert.equal(native.length,3);
    f.state.enabled=true;const original=f.service.answerRecall;
    f.service.answerRecall=async()=>{ui.transcriptEpoch++;return '不得显示的旧答案';};
    await onPrompt.call(ui,'我用什么写 Python');assert(!shown.some(b=>b.text==='不得显示的旧答案'));
    f.service.answerRecall=original;
    let release;ui.ensureSession=()=>new Promise(r=>release=r);
    const old=onPrompt.call(ui,'我用什么写 Python');await onPrompt.call(ui,'正常聊天');release('orb');await old;
    assert.equal(native.length,4);assert.equal(f.requests.length,1);
  }finally{await f.service.dispose();}
});
