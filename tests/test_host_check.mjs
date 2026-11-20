import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { hostCheckCommand } from '../plugins/dsh-desktop-observe/host-check.js';
import { apply } from '../plugins/dsh-desktop-observe/index.js';

const invocation = () => ({rawInput:'',attachments:[],signal:new AbortController().signal,
  agent:{session:{header:{cwd:root,id:'offline-host-check'}}}});

test('command dispatches only monitor enumeration and records no recognition claim',async()=>{
  let report, calls=0;
  const ctx={tools:{modeFor:()=> 'native',execute:async exec=>{
    calls++; assert.equal(exec.name,'desktop_monitors');assert.deepEqual(exec.arguments,{});
    return {value:{read_only:true,coordinate_space:'physical_pixels',monitors:[{index:1,width:100,height:100}]}};
  }}};
  const result=await hostCheckCommand(ctx,{save:async value=>{report=value;return 'offline-report';}}).handler(invocation());
  assert.equal(result.kind,'success');assert.equal(calls,1);
  assert.equal(report.model_calls_by_command,0);assert.equal(report.screenshot_taken,false);
  assert.equal(report.model_tool_selection_tested,false);
});

test('wrong workspace, extra input, and cancellation stop before dispatch',async()=>{
  let calls=0;
  const command=hostCheckCommand({tools:{modeFor:()=> 'native',execute:async()=>{calls++;}}});
  const wrong=invocation();wrong.agent.session.header.cwd=join(root,'..');
  assert.equal((await command.handler(wrong)).kind,'error');
  assert.equal((await command.handler({...invocation(),rawInput:'capture'})).kind,'error');
  assert.equal((await command.handler({...invocation(),attachments:[{}]})).kind,'error');
  await assert.rejects(command.handler({...invocation(),signal:AbortSignal.abort()}));
  assert.equal(calls,0);
});

test('host policy denial is recorded as failure without a direct-body fallback',async()=>{
  let report,calls=0;
  const ctx={tools:{modeFor:()=> 'ptc',execute:async()=>{calls++;return {isError:true};}}};
  const result=await hostCheckCommand(ctx,{save:async r=>{report=r;return 'offline-report';}}).handler(invocation());
  assert.equal(result.kind,'error');assert.equal(calls,1);assert.equal(report.passed,false);
});

test('command registration failure rolls back tools; normal disposal removes all registrations',()=>{
  let removed=[];
  const ctx={tools:{register:t=>()=>removed.push(t.name)},commands:{register:()=>{throw Error('failed command');}}};
  assert.throws(()=>apply(ctx));assert.deepEqual(removed,
    ['desktop_replay','desktop_drag','desktop_combo','desktop_text','desktop_key','desktop_scroll','desktop_click','desktop_observe','desktop_activate','desktop_windows','desktop_monitors']);
  removed=[];ctx.commands.register=c=>()=>removed.push(c.name);
  apply(ctx)();assert.deepEqual(removed,['desktop-offline','desktop-trial','desktop-check',
    'desktop_replay','desktop_drag','desktop_combo','desktop_text','desktop_key','desktop_scroll','desktop_click','desktop_observe','desktop_activate','desktop_windows','desktop_monitors']);
});
