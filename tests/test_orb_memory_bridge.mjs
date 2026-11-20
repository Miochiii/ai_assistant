import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createOrbMemoryBridge } from '../plugins/dsh-orb-memory/bridge.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = fileURLToPath(new URL('../dsh_orb_work', import.meta.url));
const session = { id: 'synthetic-orb', header: { cwd: workspace, agentPreset: 'computer-use' } };
const event = { type: 'user/message', surfaceOp: 'append', data: {
  id: 'message-1', source: { kind: 'user', rpcId: 'request-1' },
  content: [{ type: 'text', text: '以后回答请简短一点' }],
} };
function fixture(enabled = true) {
  const calls = [];
  const bridge = createOrbMemoryBridge({ root, workspace, enabled,
    host: { async v2(...args) { calls.push(args); return { status: 'recorded' }; } } });
  return { bridge, calls };
}
test('front conversation maps to old project but preserves original session; RPC retries share a key', async () => {
  const {bridge,calls} = fixture();
  await bridge.onSessionEvent(session,event);
  await bridge.onSessionEvent(session,{...event,data:{...event.data,id:'message-retry'}});
  assert.equal(calls[0][0].header.cwd,root);
  assert.equal(calls[0][0].id,session.id);
  assert.equal(calls[0][2].source_channel,'orb_daily');
  assert.equal(calls[0][2].event_id,calls[1][2].event_id);
  assert.equal(session.header.cwd,workspace);
});
test('standard code agents, subagents, unknown roots and child directories are excluded', async () => {
  const {bridge,calls} = fixture();
  for (const change of [{agentPreset:'standard'}, {origin:'subagent'}, {parentSessionId:'parent'}, {parentSession:'parent'},
    {cwd:root}, {cwd:workspace+'/child'}, {cwd:undefined}, {agentPreset:undefined}]) {
    await bridge.onSessionEvent({...session,header:{...session.header,...change}},event);
  }
  assert.equal(calls.length,0);
});
test('runtime contexts, tool/assistant output, replacements and delegated RPCs cannot be sources', async () => {
  const {bridge,calls} = fixture();
  for (const e of [{...event,type:'assistant/message'}, {...event,surfaceOp:'replace'},
    {...event,data:{...event.data,source:{kind:'runtime-context',rpcId:'r'}}},
    {...event,data:{...event.data,source:{kind:'user'}}},
    {...event,data:{...event.data,source:{kind:'user',rpcId:'code-agent-fixture'}}}]) {
    await bridge.onSessionEvent(session,e);
  }
  assert.equal(calls.length,0);
});
test('disabled/unloaded bridge does not touch storage', async () => {
  for (const enabled of [false,true]) {
    const {bridge,calls} = fixture(enabled);
    if(enabled) bridge.dispose();
    await bridge.onSessionEvent(session,event);
    await bridge.v2(session,'daily_pending');
    assert.equal(calls.length,0);
  }
});
test('session events cannot mutate consent; controls require the UI entry', async () => {
  const {bridge,calls}=fixture();
  for (const text of ['关闭自动记忆','开启自动记忆','自动记忆状态']) {
    await bridge.onSessionEvent(session,{...event,data:{...event.data,content:[{type:'text',text}]}});
  }
  assert.equal(calls.length,0);
});
