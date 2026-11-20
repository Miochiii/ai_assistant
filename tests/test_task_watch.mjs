import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskWatch,sameScene} from '../plugins/dsh-assistant-host/task-watch.js';
import {ResidentHost} from '../plugins/dsh-assistant-host/resident-host.js';
import {UiChannel} from '../plugins/dsh-assistant-host/ui-channel.js';
import {parseGuidancePlan} from '../plugins/dsh-assistant-host/visual-target.js';

function frame(value=0,left=0) {
  return {raw:Buffer.alloc(64*36*3,value),width:64,height:36,
    bounds:{left,top:0,width:64,height:36},target_window:{hwnd:123,pid:456,foreground:123},
    captured_at:new Date().toISOString(),release:async()=>{}};
}
function fixture(verifier={verify:async()=>({status:'passed'})}) {
  const root=mkdtempSync(join(tmpdir(),'task-watch-'));
  const host=new ResidentHost({channel:new UiChannel(root,{assistantSessionId:'test'}),stepVerifier:verifier});
  host.initialize();
  host.startTask({steps:['Open menu','Choose item'],conditions:['menu open','item opened'],
    targetWindow:{hwnd:123,pid:456}});
  let now=0,current=frame(); host.guidanceBaseline=current;
  const watch=new TaskWatch({host,capture:async()=>current,now:()=>now});
  return {host,watch,set(f){current=f;},async tick(){now+=2000;await watch.tick();},
    close(){host.close();rmSync(root,{recursive:true,force:true});}};
}

test('unchanged frames spend no model calls; changed then stable advances exactly one step',async()=>{
  const f=fixture();try {
    for(let i=0;i<8;i++)await f.tick();
    assert.equal(f.watch.calls,0);
    f.set(frame(100));await f.tick();await f.tick();assert.equal(f.watch.calls,0);
    await f.tick();assert.equal(f.host.state.task.step_index,1);assert.equal(f.watch.calls,1);
    for(let i=0;i<8;i++)await f.tick();
    assert.equal(f.watch.calls,1);
    f.set(frame(200));await f.tick();await f.tick();await f.tick();
    assert.equal(f.host.state.task.status,'complete');assert.equal(f.watch.calls,2);
  } finally {f.close();}
});
test('animation does not pass stability gate and a failed result never advances',async()=>{
  const f=fixture({verify:async()=>({status:'failed'})});try {
    for(let i=1;i<=8;i++){f.set(frame(i*25));await f.tick();}
    assert.equal(f.watch.calls,0);
    await f.tick();await f.tick();assert.equal(f.watch.calls,1);
    assert.equal(f.host.state.task.step_index,0);
    for(let i=0;i<6;i++)await f.tick();assert.equal(f.watch.calls,1);
  }finally{f.close();}
});
test('pause stops capture; window unavailable clears highlight without a model request',async()=>{
  const f=fixture();try {
    f.host.state.mode='standby';await f.tick();assert.equal(f.watch.stage,'idle');
    f.host.state.mode='coach';f.watch.capture=async()=>{throw Error('not foreground');};
    f.host.setHighlight({text:'current',rect:[0,0,10,10]});await f.tick();
    assert.equal(f.watch.stage,'waiting_window');assert.equal(f.host.state.highlight,null);assert.equal(f.watch.calls,0);
  }finally{f.close();}
});
test('temporary Orb focus keeps the current highlight and waits',async()=>{
  const f=fixture();try {
    f.host.setHighlight({text:'current',rect:[0,0,10,10]});
    f.watch.capture=async()=>{throw Error('用户正在助手面板中交互，暂缓自动观察');};
    await f.tick();
    assert.equal(f.watch.stage,'waiting_window');
    assert.equal(f.host.state.highlight.text,'current');
    assert.equal(f.watch.calls,0);
  }finally{f.close();}
});
test('cancelled task cannot be advanced by a late verifier result',async()=>{
  let resolve;const f=fixture({verify:()=>new Promise(r=>{resolve=r;})});try {
    const pending=f.host._verifyCurrentStep({frame:frame()});
    f.host.endTask();f.host.startTask({steps:['new task']});
    resolve({status:'passed'});assert.equal((await pending).status,'stale');
    assert.equal(f.host.state.task.step_index,0);
  }finally{f.close();}
});
test('duplicate verification is single flight and a post-inference screen change rejects success',async()=>{
  let resolve;const f=fixture({verify:()=>new Promise(r=>{resolve=r;})});try {
    f.host.validateStepFrame=async()=>false;
    const pending=f.host._verifyCurrentStep({frame:frame()});
    assert.equal((await f.host._verifyCurrentStep()).status,'busy');
    resolve({status:'passed'});assert.equal((await pending).status,'unknown');
    assert.equal(f.host.state.task.step_index,0);
  }finally{f.close();}
});
test('screen comparison binds geometry and foreground as well as pixels',()=>{
  assert.equal(sameScene(frame(),frame()),true);
  assert.equal(sameScene(frame(),frame(0,10)),false);
  assert.equal(sameScene(frame(),frame(200)),false);
});

test('only validated passed transition adopts a new window and next-step baseline',async()=>{
  const f=fixture({verify:async()=>({status:'passed',visual:{targetPoint:[5,5]}})});
  try {
    const next=frame(100);next.target_window={hwnd:999,pid:777,foreground:999};
    f.host.validateStepFrame=async(_frame,_task,result)=>{
      result.nextWindow=next.target_window;result.nextBaseline=next;return true;
    };
    await f.host._verifyCurrentStep({frame:frame()});
    assert.equal(f.host.state.task.step_index,1);assert.equal(f.host.state.task.target_window.hwnd,999);
    assert.equal(f.host.guidanceBaseline,next);
    f.host.validateStepFrame=async()=>false;
    await f.host._verifyCurrentStep({frame:frame()});
    assert.equal(f.host.state.task.step_index,1);assert.equal(f.host.state.task.status,'waiting_user');
  }finally{f.close();}
});
test('plans accept a top-level instruction that differs from step zero',()=>{
  const value={text:'Open menu',steps:[{text:'Open menu',expected:'menu open'},
    {text:'Choose item',expected:'item opened'}]};
  assert.equal(parseGuidancePlan(JSON.stringify(value)).length,2);
  const repaired=parseGuidancePlan(JSON.stringify({...value,text:'A different instruction'}));
  assert.equal(repaired[0].text,'A different instruction');
  assert.throws(()=>parseGuidancePlan(JSON.stringify({...value,steps:[{text:'Click'}]})));
});

test('model plan enters the live Host and carries the window binding; verified next target is highlighted',async()=>{
  const f=fixture({verify:async()=>({status:'passed',highlight:{text:'second step',rect:[1,2,30,30]}})});
  try {
    f.host.endTask();const seen=[];f.host.highlightResolver=async h=>seen.push(h);
    f.host.model={complete:async()=>({text:'first step',highlightTarget:{rect:[0,0,30,30]},
      guidancePlan:{title:'live fixture',steps:['first step','second step'],
        conditions:['open','done'],targetWindow:{hwnd:123,pid:456}},
      guidanceBaseline:frame()})};
    await f.host._runModel({event:{payload:{text:'guide me'},event_id:'new'},requestId:'r'});
    assert.equal(f.host.state.task.steps.length,2);assert.equal(f.host.state.task.target_window.hwnd,123);
    await f.host._verifyCurrentStep({frame:frame(50)});
    assert.equal(seen.at(-1).text,'second step');assert.equal(f.host.state.task.step_index,1);
  }finally{f.close();}
});
