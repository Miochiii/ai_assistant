import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PanelSession} from '../plugins/dsh-assistant-host/panel-session.js';
import {PanelStepVerifier} from '../plugins/dsh-assistant-host/panel-guidance.js';

function desktop() {return {capture_scope:'desktop',bounds:{left:0,top:0,width:128,height:72},width:128,height:72,
  raw:Buffer.alloc(128*72*3),windows:[{hwnd:99,pid:8,rect:[0,0,128,72]}],captured_at:new Date().toISOString()};}

test('bound capture failure observes desktop without adopting it or retrying assistant-focus errors',async()=>{
  const root=await mkdtemp(join(tmpdir(),'transition-capture-'));let reason='different_foreground_window';const scopes=[],resumed=[];
  const session=new PanelSession({sessionId:'test',root,highlighter:{
    update:async()=>{},suspendForCapture:async()=>{},resumeAfterCapture:async h=>resumed.push(h)},
    makeCaptureAdapter:({outdir})=>({capture:async({scope})=>{
      scopes.push(scope);if(scope.hwnd)throw Error('GUIDANCE_WINDOW_NOT_FOREGROUND: '+reason);
      await mkdir(outdir,{recursive:true});const raw_ref=join(outdir,'f.rgb');await writeFile(raw_ref,desktop().raw);
      return {...desktop(),raw_ref};
    }})});
  session.host={state:{highlight:{text:'old'}},clearHighlight(){this.state.highlight=null;}};
  const task={target_window:{hwnd:42,pid:7}};
  try {
    const frame=await session.captureFrame({task,watch:true});await frame.release();
    assert.equal(frame.capture_scope,'desktop');assert.equal(scopes[1].desktopWindows,true);
    assert.equal(task.target_window.hwnd,42);assert.equal(resumed.at(-1),null);
    reason='assistant_still_foreground';scopes.length=0;
    await assert.rejects(session.captureFrame({task,watch:true}));assert.equal(scopes.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('desktop transition requires semantic pass and locally stable target before rebinding',async()=>{
  const session=new PanelSession({sessionId:'test',root:tmpdir(),highlighter:{}});
  const before=desktop();let captures=0;
  session.captureFrame=async()=>{captures++;return desktop();};
  const task={target_window:{hwnd:42,pid:7}};
  assert.equal(await session.validateStepFrame(before,task,{status:'unknown'}),false);
  assert.equal(await session.validateStepFrame(before,task,{status:'passed'}),false);
  assert.equal(captures,0);
  const result={status:'passed',visual:{targetPoint:[64,36]},highlight:{rect:[46,18,36,36]}};
  assert.equal(await session.validateStepFrame(before,task,result),true);
  assert.equal(result.nextWindow.hwnd,99);assert.equal(result.highlight.targetHwnd,99);
  assert.equal(task.target_window.hwnd,42); // Host commits only after cancellation checks.
  session.captureFrame=async()=>{const f=desktop();f.windows[0].pid=9;return f;};
  await assert.rejects(session.validateStepFrame(before,task,{status:'passed',visual:{targetPoint:[64,36]}}));
});

test('transition verifier rejects pass without grounding and supports final-step evidence anchor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'transition-verifier-'));
  const image=join(root,'fixture.png');await writeFile(image,'synthetic');
  let reply={status:'passed',reason:'字体窗口出现'};
  const verifier=new PanelStepVerifier({ctx:{llm:{async *stream(){
    yield {type:'text-delta',index:0,text:JSON.stringify(reply)};yield {type:'finish',reason:{kind:'stop'}};
  }}},attachments:{saveImage:async()=>({id:'fixture'})},captureFrame:async()=>({...desktop(),image_ref:image})});
  const request={task:{title:'更换字体',steps:['打开字体'],conditions:['字体窗口出现']},step:{index:0,text:'打开字体'}};
  try {
    assert.equal((await verifier.verify(request)).status,'unknown');
    reply={...reply,evidence_window:{position:[500,500]}};
    const result=await verifier.verify(request);assert.equal(result.status,'passed');
    assert.deepEqual(result.visual.targetPoint,[64,36]);assert.equal(result.highlight,undefined);
    reply={status:'unknown',target:{label:'无关窗口',position:[500,500]}};
    assert.equal((await verifier.verify(request)).visual,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});
