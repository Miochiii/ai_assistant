import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {guidanceScope,confirmVisualWindow,selectVisualWindow} from '../plugins/dsh-assistant-host/desktop-grounding.js';
import {parseVisualReply} from '../plugins/dsh-assistant-host/visual-target.js';
import {PanelChatModel} from '../plugins/dsh-assistant-host/panel-model.js';
import {PanelSession} from '../plugins/dsh-assistant-host/panel-session.js';
import {ResidentHost} from '../plugins/dsh-assistant-host/resident-host.js';
import {UiChannel} from '../plugins/dsh-assistant-host/ui-channel.js';
import {HighlightController} from '../plugins/dsh-assistant-host/highlight-controller.js';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';

function desktop() {
  return {capture_scope:'desktop',bounds:{left:-100,top:0,width:200,height:100},width:200,height:100,
    raw:Buffer.alloc(200*100*3),windows:[{hwnd:42,pid:7,rect:[-50,0,50,100]}],
    captured_at:new Date().toISOString(),frame_id:'f',geometry_revision:'g'};
}
const reply={text:'打开格式菜单',window:{position:[300,100]},target:{label:'格式',position:[450,200]},
  steps:[{text:'打开格式菜单',expected:'格式菜单展开'},{text:'选择字体',expected:'字体对话框出现'}]};

test('first observation uses all desktop monitors without a foreground gate; bound watch stays scoped',()=>{
  const scope=guidanceScope(null,[123]);
  assert.equal(scope.monitor,0);assert.equal(scope.desktopWindows,true);
  assert.equal(scope.foregroundWindow,undefined);assert.equal(scope.hwnd,undefined);
  const bound=guidanceScope({target_window:{hwnd:42,pid:7}},[123]);
  assert.equal(bound.foregroundWindow,true);assert.equal(bound.hwnd,42);
});
test('normalized desktop positions include negative screen origins and map to the visible software',()=>{
  const f=desktop(),visual=parseVisualReply(JSON.stringify(reply),f);
  assert.deepEqual(visual.windowPoint,[-40,10]);assert.deepEqual(visual.targetPoint,[-10,20]);
  assert.equal(selectVisualWindow(f,visual).hwnd,42);
  const result=confirmVisualWindow(f,desktop(),visual);
  assert.equal(result.binding.hwnd,42);assert.deepEqual(result.baseline.bounds,{left:-50,top:0,width:100,height:100});
});
test('unrelated desktop activity is ignored but target changes, occlusion and window replacement are rejected',()=>{
  const before=desktop(),visual=parseVisualReply(JSON.stringify(reply),before);
  let after=desktop();after.raw.fill(255,0,30*3);
  assert.equal(confirmVisualWindow(before,after,visual).binding.hwnd,42);
  after=desktop();after.raw.fill(255);assert.throws(()=>confirmVisualWindow(before,after,visual),/画面已变化/);
  after=desktop();after.windows[0].pid=8;assert.throws(()=>confirmVisualWindow(before,after,visual),/切换/);
  after=desktop();after.windows.unshift({hwnd:99,pid:9,rect:[-20,0,20,100]});
  assert.throws(()=>confirmVisualWindow(before,after,visual),/切换/);
});
test('visual reply needs only the target point; local Orb eligibility picks the window',()=>{
  const f=desktop(),visual=parseVisualReply(JSON.stringify({...reply,window:null}),f);
  assert.equal(visual.windowPoint,null);
  assert.equal(selectVisualWindow(f,visual).hwnd,42);
});
test('ambiguous visual replies request clarification and cannot invent a window binding',()=>{
  assert.equal(parseVisualReply('{"text":"请选择一个记事本窗口","target":null,"window":null}',desktop()).highlight,null);
  assert.equal(parseVisualReply(JSON.stringify({...reply,window:null}),desktop()).windowPoint,null);
});
test('shell and system overlay windows are rejected instead of binding the wallpaper',()=>{
  const f=desktop(),visual=parseVisualReply(JSON.stringify(reply),f);
  f.windows=[{hwnd:1,pid:2,rect:[-100,0,100,100],class_name:'Progman',title:'Program Manager'}];
  assert.throws(()=>selectVisualWindow(f,visual),/桌面、系统悬浮层/);
  f.windows=[{hwnd:3,pid:4,rect:[-100,0,100,100],class_name:'CEF-OSC-WIDGET',title:'NVIDIA GeForce Overlay'}];
  assert.throws(()=>selectVisualWindow(f,visual),/桌面、系统悬浮层/);
});
test('default panel capture mode uses the full desktop so visible non-foreground targets can be found', async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-default-'));
  let scope=null;
  const session=new PanelSession({sessionId:'desktop',root,highlighter:{update:async()=>{}},
    makeCaptureAdapter:({outdir})=>({capture:async({scope:requested})=>{
      scope=requested;await mkdir(outdir,{recursive:true});
      const frame=desktop();frame.image_ref=join(outdir,'image.png');frame.raw_ref=join(outdir,'frame.rgb');
      await writeFile(frame.image_ref,'image');await writeFile(frame.raw_ref,frame.raw);return frame;
    }})});
  try {
    const frame=await session.captureFrame();
    assert.equal(scope.monitor,0);assert.equal(scope.desktopWindows,true);
    assert.equal(scope.foregroundWindow,undefined);
    await frame.release();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('foreground capture falls back to desktop when Orb remains foreground', async()=>{
  const root=await mkdtemp(join(tmpdir(),'foreground-fallback-')),scopes=[];
  const session=new PanelSession({sessionId:'fallback',root,captureMode:'foreground',highlighter:{update:async()=>{}},
    makeCaptureAdapter:({outdir})=>({capture:async({scope})=>{
      scopes.push(scope);
      if(scopes.length===1) throw Error('GUIDANCE_WINDOW_NOT_FOREGROUND: assistant_still_foreground');
      await mkdir(outdir,{recursive:true});
      const frame=desktop();frame.image_ref=join(outdir,'image.png');frame.raw_ref=join(outdir,'frame.rgb');
      await writeFile(frame.image_ref,'image');await writeFile(frame.raw_ref,frame.raw);return frame;
    }})});
  try {
    const frame=await session.captureFrame();
    assert.equal(scopes.length,2);
    assert.equal(scopes[0].foregroundWindow,true);
    assert.equal(scopes[1].monitor,0);assert.equal(scopes[1].desktopWindows,true);
    assert.equal(frame.capture_scope,'desktop');
    await frame.release();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('real panel route screenshots first, binds after the model reply, and never enters the main session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-first-')),scopes=[],order=[];
  const model=new PanelChatModel({sessionId:'test',memory:{},ctx:{
    attachments:{saveImage:async()=>({id:'fixture'})},
    llm:{async *stream(request){order.push('model');assert.match(request.system,/整个可见桌面/);
      yield {type:'text-delta',index:0,text:JSON.stringify(reply)};yield {type:'finish',reason:{kind:'stop'}};}}
  }});
  const session=new PanelSession({sessionId:'test',root,model,highlighter:{update:async()=>{}},
    captureMode:'desktop',
    makeCaptureAdapter:({outdir})=>({capture:async({scope})=>{
      scopes.push(scope);order.push('capture');await mkdir(outdir,{recursive:true});
      const frame=desktop();frame.image_ref=join(outdir,'image.png');frame.raw_ref=join(outdir,'frame.rgb');
      await writeFile(frame.image_ref,'synthetic image');await writeFile(frame.raw_ref,frame.raw);
      return frame;
    }})});
  try {
    const result=await model.complete({text:'教我在记事本里更改字体'});
    assert.deepEqual(order,['capture','model','capture']);
    assert.ok(scopes.every(s=>s.monitor===0 && !s.foregroundWindow));
    assert.equal(result.guidancePlan.targetWindow.hwnd,42);
    assert.equal(result.highlightTarget.targetHwnd,42);
    // Keep the original desktop pixel coordinates; window binding must not
    // apply the crop origin a second time (including negative monitor origins).
    assert.deepEqual(result.highlightTarget.rect,[-28,2,36,36]);
    assert.equal(result.guidanceBaseline.width,100);assert.equal(result.guidancePlan.steps.length,2);
    assert.equal((await readdir(join(root,'captures'))).length,0);
    assert.equal(session.host,null); // no parent-agent request or desktop execution
  }finally{await rm(root,{recursive:true,force:true});}
});

test('desktop first highlight retains verified HWND through Host and overlay state',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-bound-highlight-'));
  const child=new EventEmitter();child.exitCode=null;child.stderr=new EventEmitter();
  child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  const highlighter=new HighlightController({root:join(root,'overlay'),spawnProcess:()=>child});
  const host=new ResidentHost({channel:new UiChannel(join(root,'host'),{assistantSessionId:'binding-test'})});
  try {
    const frame=desktop();frame.image_ref=join(root,'image.png');await writeFile(frame.image_ref,'synthetic');
    const model=new PanelChatModel({sessionId:'test',memory:{},observe:async()=>frame,ctx:{
      attachments:{saveImage:async()=>({id:'fixture'})},
      llm:{async *stream(){yield {type:'text-delta',index:0,text:JSON.stringify(reply)};
        yield {type:'finish',reason:{kind:'stop'}};}}}
    });
    model.bindDesktopTarget=async(before,visual)=>confirmVisualWindow(before,desktop(),visual);
    const result=await model.complete({text:'教我更改字体'});
    host.initialize();
    const state=host.setHighlight(result.highlightTarget);
    await highlighter.update(state);
    const rendered=JSON.parse(await readFile(highlighter.statePath,'utf8'));
    assert.equal(rendered.target_hwnd,42);
    assert.deepEqual(rendered.window_geometry,[{hwnd:42,rect:[-50,0,50,100]}]);
    assert.deepEqual(rendered.steps[0].rect,[-28,2,36,36]);
    // A failed/replaced-window confirmation cannot publish a replacement box.
    model.bindDesktopTarget=async()=>{throw Error('目标窗口在识别期间移动或发生切换');};
    await assert.rejects(model.complete({text:'教我继续'}),/移动或发生切换/);
  }finally{host.close();await highlighter.stop();await rm(root,{recursive:true,force:true});}
});

test('watch clears moved, resized or switched-window highlights before restoring overlay',async()=>{
  for (const kind of ['move','resize','dialog','owner-within-union','unchanged']) {
    const root=await mkdtemp(join(tmpdir(),'watch-geometry-'));
    let restored,cleared=false;
    const before={...desktop(),capture_scope:undefined,
      target_window:{hwnd:42,pid:7,foreground:42,window_geometry:[{hwnd:42,rect:[-50,0,50,100]}]}};
    const current={...before,bounds:{...before.bounds},target_window:structuredClone(before.target_window)};
    if(kind==='move')current.bounds.left+=10;
    if(kind==='resize')current.bounds.width+=10;
    if(kind==='dialog')current.target_window.foreground=99;
    if(kind==='owner-within-union')current.target_window.window_geometry[0].rect[0]+=1;
    const session=new PanelSession({sessionId:'test',root,highlighter:{
      suspendForCapture:async()=>{},resumeAfterCapture:async h=>{restored=h;}},
      makeCaptureAdapter:({outdir})=>({capture:async()=>{
        await mkdir(outdir,{recursive:true});const raw_ref=join(outdir,'frame.rgb');
        await writeFile(raw_ref,current.raw);return {...current,raw_ref};
      }})});
    const highlight={text:'old',expires_at:'old'};
    session.lastGuidanceFrame=before;
    session.host={state:{highlight},clearHighlight(){cleared=true;this.state.highlight=null;},_revision(){},_writeState(){}};
    try {
      const frame=await session.captureFrame({task:{target_window:before.target_window},watch:true});
      await frame.release();
      assert.equal(cleared,kind!=='unchanged',kind);
      assert.equal(restored,kind==='unchanged'?highlight:null,kind);
    } finally {await rm(root,{recursive:true,force:true});}
  }
});
