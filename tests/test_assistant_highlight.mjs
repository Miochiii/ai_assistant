import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost, makeAssistantEvent } from '../plugins/dsh-assistant-host/resident-host.js';
import { validateHighlight } from '../plugins/dsh-assistant-host/protocol.js';
import { HighlightController } from '../plugins/dsh-assistant-host/highlight-controller.js';

test('highlight protocol validates rect and identity', () => {
  const value = { highlight_id: 'h1', text: '点击文件', rect: [10, 20, 120, 40] };
  assert.equal(validateHighlight(value), value);
  assert.throws(() => validateHighlight({ ...value, rect: [1, 2] }), /rect/);
  assert.throws(() => validateHighlight({ ...value, highlight_id: '' }), /highlight_id/);
  const pinned={...value,target_hwnd:2,window_geometry:[{hwnd:1,rect:[0,0,100,100]},{hwnd:2,rect:[20,20,60,60]}]};
  assert.equal(validateHighlight(pinned),pinned);
  assert.throws(()=>validateHighlight({...pinned,target_hwnd:3}),/window_geometry/);
  assert.throws(()=>validateHighlight({...pinned,window_geometry:[{hwnd:2,rect:[50,50,10,10]}]}),/window_geometry/);
});

test('Host owns one highlight and clears it on task end', () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-highlight-host-'));
  try {
    const channel = new UiChannel(root, { assistantSessionId: 'instance-h' });
    const host = new ResidentHost({ channel });
    host.initialize();
    const highlight = host.setHighlight({
      text: '点击文件', target: '文件', rect: [10, 20, 120, 40],
    });
    assert.equal(host.state.highlight.highlight_id, highlight.highlight_id);
    assert.equal(host.state.highlight.task_id, null);
    host.startTask({ title: '菜单', steps: ['打开文件菜单'] });
    host.setHighlight({ text: '打开文件菜单', target: '文件', rect: [10, 20, 120, 40] });
    assert.equal(host.state.highlight.task_id, host.state.task.task_id);
    host.endTask('test');
    assert.equal(host.state.highlight, null);
    host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Host routes a model highlight target to the resolver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-highlight-resolver-'));
  const resolved = [];
  try {
    const channel = new UiChannel(root, { assistantSessionId: 'instance-r' });
    const host = new ResidentHost({
      channel,
      model: { async complete() { return { text: '点击文件', highlightTarget: '文件' }; } },
      highlightResolver: async target => { resolved.push(target); },
    });
    host.initialize();
    const event = makeAssistantEvent({ host, kind: 'chat_submit', payload: { text: '教我打开文件' }, clientSeq: 1 });
    channel.submitEvent(event);
    await host.poll();
    await host.waitForIdle();
    assert.deepEqual(resolved, ['文件']);
    assert.equal(host.state.task?.title, '指导任务');
    assert.equal(host.state.mode, 'coach');
    host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('highlight controller mirrors state and locates targets without spawning in tests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-highlight-controller-'));
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const controller = new HighlightController({
    root,
    spawnProcess: () => child,
    runExec: async () => ({ stdout: JSON.stringify({ ok: true, rect: [1, 2, 3, 4] }) }),
  });
  try {
    await controller.update({ rect: [10, 20, 30, 40], text: '点击这里', target_hwnd: null });
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    assert.equal(state.visible, true);
    assert.deepEqual(state.steps[0].rect, [10, 20, 30, 40]);
    assert.equal(state.steps[0].text, '点击这里');
    assert.equal(controller.status().running, true);
    const located = await controller.locate('文件');
    assert.deepEqual(located.rect, [1, 2, 3, 4]);
    await controller.update(null);
    assert.equal(controller.status().running, false);
    await controller.stop();
    assert.equal(controller.status().running, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping updates serialize hide/show and do not spawn duplicate overlays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'highlight-race-'));
  const children = [];
  const controller = new HighlightController({root, spawnProcess:()=>{
    const child = new EventEmitter(); child.exitCode=null; child.stderr=new EventEmitter();
    child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
    children.push(child); return child;
  }});
  try {
    const h={highlight_id:'h1',rect:[1,2,20,20],text:'目标'};
    await Promise.all([controller.update(h),controller.update(h),controller.update(null),controller.update({...h,highlight_id:'h2'})]);
    assert.equal(children.length,2);
    assert.equal(children[0].exitCode,0);
    assert.equal(controller.status().last.highlight_id,'h2');
    await controller.stop();
    assert.equal(controller.status().running,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Host expires a highlight without needing another user message', async () => {
  const root=mkdtempSync(join(tmpdir(),'highlight-expiry-'));
  let now=new Date('2026-01-01T00:00:00Z');
  const host=new ResidentHost({channel:new UiChannel(root,{assistantSessionId:'expiry'}),clock:()=>now});
  try {
    host.initialize();
    host.setHighlight({text:'目标',rect:[1,2,20,20],expiresAt:'2026-01-01T00:00:10Z'});
    now=new Date('2026-01-01T00:00:11Z'); await host.poll();
    assert.equal(host.state.highlight,null);
  } finally {host.close();rmSync(root,{recursive:true,force:true});}
});

test('capture waits for the matching hidden acknowledgement before restoring highlight', async()=>{
  const root=mkdtempSync(join(tmpdir(),'highlight-ack-'));
  const child=new EventEmitter();child.exitCode=null;child.stderr=new EventEmitter();
  child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  const controller=new HighlightController({root,spawnProcess:()=>child});
  try {
    const h={highlight_id:'current',rect:[1,2,20,20],text:'目标'};
    await controller.update(h);
    const poll=setInterval(()=>{
      try {const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
        if(state.visible===false)writeFileSync(join(root,'state.hidden.json'),JSON.stringify({generation:state.generation}));
      }catch{}
    },10);
    try {await controller.suspendForCapture();}finally{clearInterval(poll);}
    assert.equal(controller.captureHidden,true);
    await controller.update(h);assert.equal(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).visible,false);
    await controller.resumeAfterCapture(h);
    assert.equal(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).visible,true);
  }finally{await controller.stop();rmSync(root,{recursive:true,force:true});}
});
